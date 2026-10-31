// generate-meetings: makes sure every group has its monthly meetings (and
// trainings, if the group has a training_rule) for the next 12 months.
//
// Idempotent: each generated row has source_key "rule:YYYY-MM", unique per group,
// so running it again only fills gaps. Months that already have a meeting
// (generated, seeded, or cancelled) are left alone.
//
// Called monthly by pg_cron (cron.sql) with the x-cron-secret header.
// POST body (all optional):
//   { "group": "family" }      only this group
//   { "reflow": true }         also move future rule meetings that nobody re-timed by hand
//                              (manual_time = false) to match a changed rule
//   { "dryRun": true }         report what would change, write nothing
import { corsHeaders, cronAuthorized, json, serviceClient } from "../_shared/http.ts";
import { addMonths, monthName, nthWeekday, ym, zonedTime } from "../_shared/time.ts";

interface Rule { nth: number; weekday: number; start: string; durationMinutes?: number; titleTemplate?: string; location?: unknown }
interface AgendaItem { time: number; item: string; owner: string }
interface Existing { id: string; source_key: string; starts_at: string; manual_time: boolean; cancelled_at: string | null }

const MONTHS_AHEAD = 12;

function occurrence(rule: Rule, y: number, m: number): Date | null {
  const day = nthWeekday(y, m, rule.weekday, rule.nth);
  if (!day) return null;
  const [hh, mm] = rule.start.split(":").map(Number);
  return zonedTime(y, m, day, hh, mm);
}

function title(rule: Rule, m: number, fallback: string) {
  return (rule.titleTemplate ?? `{month} ${fallback}`).replace("{month}", monthName(m));
}

function agendaFor(template: AgendaItem[], hotSeatId: string | null, hotSeatName: string): AgendaItem[] {
  return template.map((it) => ({
    time: it.time,
    item: it.item.replace("{hotSeatName}", hotSeatName || "TBD"),
    owner: it.owner === "{hotSeat}" ? (hotSeatId ?? "all") : it.owner,
  }));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (!cronAuthorized(req)) return json(req, { error: "Forbidden" }, 403);
  const opts = await req.json().catch(() => ({})) as { group?: string; reflow?: boolean; dryRun?: boolean };
  const db = serviceClient();
  const now = new Date();
  const report: Record<string, unknown> = {};

  let q = db.from("group_settings").select("group_id, meeting_rule, training_rule, agenda_template, groups(name)");
  if (opts.group) q = q.eq("group_id", opts.group);
  const { data: groups, error } = await q;
  if (error) return json(req, { error: error.message }, 500);

  // Current month in Central time.
  const nowCT = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit" })
    .format(now).split("-").map(Number);

  for (const g of groups ?? []) {
    const gid = g.group_id as string;
    const groupName = (g.groups as { name?: string } | null)?.name ?? "";
    const out = { meetingsCreated: [] as string[], trainingsCreated: [] as string[], reflowed: [] as string[] };
    report[gid] = out;

    const months = Array.from({ length: MONTHS_AHEAD + 1 }, (_, i) => addMonths(nowCT[0], nowCT[1], i));

    // ---------- meetings ----------
    const rule = g.meeting_rule as Rule | null;
    if (rule) {
      const keys = months.map((x) => `rule:${ym(x.y, x.m)}`);
      const { data: existing } = await db.from("meetings")
        .select("id, source_key, starts_at, manual_time, cancelled_at").eq("group_id", gid).in("source_key", keys);
      const have = new Map<string, Existing>(((existing ?? []) as Existing[]).map((r) => [r.source_key, r]));

      // Hot seat rotation: continue after the latest meeting that has someone assigned.
      const { data: members } = await db.from("members").select("id, name, sort_order")
        .eq("group_id", gid).is("removed_at", null).order("sort_order").order("name");
      const roster = (members ?? []) as { id: string; name: string }[];
      const { data: lastHs } = await db.from("meetings").select("hot_seat_member_id")
        .eq("group_id", gid).not("hot_seat_member_id", "is", null).is("cancelled_at", null)
        .order("starts_at", { ascending: false }).limit(1).maybeSingle();
      let idx = roster.findIndex((m) => m.id === lastHs?.hot_seat_member_id);

      const rows: { id: string; [k: string]: unknown }[] = [];
      for (const { y, m } of months) {
        const key = `rule:${ym(y, m)}`;
        const at = occurrence(rule, y, m);
        if (!at || at <= now) continue;
        const ex = have.get(key);
        if (ex) {
          if (opts.reflow && !ex.manual_time && !ex.cancelled_at && new Date(ex.starts_at).getTime() !== at.getTime()) {
            out.reflowed.push(ex.id);
            if (!opts.dryRun) {
              await db.from("meetings").update({ starts_at: at.toISOString(), duration_minutes: rule.durationMinutes ?? 60 })
                .eq("id", ex.id);
            }
          }
          continue;
        }
        let hs: { id: string; name: string } | null = null;
        if (roster.length) { idx = (idx + 1) % roster.length; hs = roster[idx]; }
        rows.push({
          id: `mt-${gid}-${ym(y, m)}`,
          group_id: gid,
          starts_at: at.toISOString(),
          duration_minutes: rule.durationMinutes ?? 60,
          title: title(rule, m, groupName),
          location: rule.location ?? null,
          agenda: agendaFor((g.agenda_template ?? []) as AgendaItem[], hs?.id ?? null, hs ? hs.name.split(" ")[0] : ""),
          hot_seat_member_id: hs?.id ?? null,
          source_key: key,
        });
      }
      out.meetingsCreated = rows.map((r) => r.id);
      if (rows.length && !opts.dryRun) {
        const { error: e } = await db.from("meetings").upsert(rows, { onConflict: "group_id,source_key", ignoreDuplicates: true });
        if (e) return json(req, { error: `meetings ${gid}: ${e.message}` }, 500);
      }
    }

    // ---------- trainings ----------
    const trule = g.training_rule as Rule | null;
    if (trule) {
      const keys = months.map((x) => `rule:${ym(x.y, x.m)}`);
      const { data: existing } = await db.from("trainings")
        .select("id, source_key, starts_at, manual_time, cancelled_at").eq("group_id", gid).in("source_key", keys);
      const have = new Map<string, Existing>(((existing ?? []) as Existing[]).map((r) => [r.source_key, r]));
      const rows: { id: string; [k: string]: unknown }[] = [];
      for (const { y, m } of months) {
        const key = `rule:${ym(y, m)}`;
        const at = occurrence(trule, y, m);
        if (!at || at <= now) continue;
        const ex = have.get(key);
        if (ex) {
          if (opts.reflow && !ex.manual_time && !ex.cancelled_at && new Date(ex.starts_at).getTime() !== at.getTime()) {
            out.reflowed.push(ex.id);
            if (!opts.dryRun) await db.from("trainings").update({ starts_at: at.toISOString() }).eq("id", ex.id);
          }
          continue;
        }
        rows.push({
          id: `tr-${gid}-${ym(y, m)}`, group_id: gid, starts_at: at.toISOString(),
          duration_minutes: trule.durationMinutes ?? 60, source_key: key,
        });
      }
      out.trainingsCreated = rows.map((r) => r.id);
      if (rows.length && !opts.dryRun) {
        const { error: e } = await db.from("trainings").upsert(rows, { onConflict: "group_id,source_key", ignoreDuplicates: true });
        if (e) return json(req, { error: `trainings ${gid}: ${e.message}` }, 500);
      }
    }
  }

  return json(req, { ok: true, dryRun: !!opts.dryRun, report });
});
