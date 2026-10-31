// schedule-notifications: runs hourly (cron.sql). Looks at upcoming and recent
// events, works out which scheduled reminders fall due in the next ~hour, and
// queues them with enqueue_notifications(). The SQL side applies preferences,
// the SMS allowlist, email fallback and quiet hours, and dedupes, so running
// this twice (or catching up after a missed hour) never double-sends.
//
// Spec: supabase/NOTIFICATIONS.md. Event-driven notifications (new announcement,
// comments, "I can help", invites, schedule changes) are queued by database
// triggers instead, not here.
//
// POST body (optional): { "now": "2026-11-07T15:05:00-06:00" } to simulate a time (testing),
//                       { "dryRun": true } to return the items without queueing.
import { corsHeaders, cronAuthorized, json, serviceClient } from "../_shared/http.ts";
import { DAY, fmtWhen, HOUR, localMorningAfter } from "../_shared/time.ts";

const LOOKBACK = 3 * HOUR;   // catch up if a run was missed
const LOOKAHEAD = 65 * 60_000; // queue a little ahead; send-notifications waits for send_after

type Channel = "email" | "sms" | "push";
interface Item {
  memberId: string; kind: string; category: "meeting" | "nudge" | "digest" | "other";
  channels: Channel[]; subject: string; body: string; url: string;
  refType: string; refId: string; refStartsAt: string; sendAt: string; dedupeBase: string;
}
interface Loc { type?: string; label?: string; url?: string | null; address?: string | null }

const first = (name: string) => (name || "").split(" ")[0];
const epoch = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

function whereText(loc: Loc | null, full: boolean): string {
  if (!loc) return "";
  if (loc.type === "zoom") return full && loc.url ? `Zoom: ${loc.url}` : "Zoom";
  return loc.address ? (full ? `At ${loc.address}` : loc.address) : "In person";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (!cronAuthorized(req)) return json(req, { error: "Forbidden" }, 403);
  const opts = await req.json().catch(() => ({})) as { now?: string; dryRun?: boolean };
  const now = opts.now ? new Date(opts.now) : new Date();
  const lo = now.getTime() - LOOKBACK, hi = now.getTime() + LOOKAHEAD;
  const due = (t: Date) => t.getTime() >= lo && t.getTime() < hi;
  const db = serviceClient();
  const items: Item[] = [];

  const { data: groups, error } = await db.from("group_settings")
    .select("group_id, location_default, location_override, notification_options, groups(name)");
  if (error) return json(req, { error: error.message }, 500);

  for (const g of groups ?? []) {
    const gid = g.group_id as string;
    const gname = (g.groups as { name?: string } | null)?.name ?? "";
    const groupLoc = (g.location_override ?? g.location_default) as Loc;
    const oneHour = !!(g.notification_options as { oneHourReminder?: boolean })?.oneHourReminder;

    const { data: members } = await db.from("members").select("id, name, role")
      .eq("group_id", gid).is("removed_at", null).order("sort_order");
    const roster = members ?? [];
    const name = (id: string | null) => roster.find((m) => m.id === id)?.name ?? "";
    const admins = roster.filter((m) => m.role === "admin");
    const { data: prefs } = await db.from("notification_prefs").select("member_id, nudges").eq("group_id", gid);
    const nudgesOn = (id: string) => (prefs ?? []).find((p) => p.member_id === id)?.nudges !== false;

    const add = (it: Omit<Item, "dedupeBase"> & { dedupeBase?: string }) =>
      items.push({ ...it, dedupeBase: it.dedupeBase ?? `${it.kind}:${it.refId}:${it.memberId}:${epoch(it.refStartsAt)}` });

    // ---------------- Meetings: from 16 days ago (2-week nudge) to 8 days ahead ----------------
    const { data: meetings } = await db.from("meetings")
      .select("id, title, starts_at, duration_minutes, location, hot_seat_member_id, hot_seat_prep, action_plan")
      .eq("group_id", gid).is("cancelled_at", null)
      .gte("starts_at", new Date(now.getTime() - 16 * DAY).toISOString())
      .lte("starts_at", new Date(now.getTime() + 8 * DAY).toISOString())
      .order("starts_at");
    const ids = (meetings ?? []).map((m) => m.id);
    const [{ data: rsvps }, { data: checkins }, { data: commitments }] = await Promise.all([
      db.from("meeting_rsvps").select("meeting_id, member_id, status").in("meeting_id", ids.length ? ids : [""]),
      db.from("checkins").select("meeting_id, member_id").in("meeting_id", ids.length ? ids : [""]),
      db.from("commitments").select("id, meeting_id, member_id, text, status").in("meeting_id", ids.length ? ids : [""]),
    ]);

    for (const mt of meetings ?? []) {
      const start = new Date(mt.starts_at);
      const loc = (mt.location ?? groupLoc) as Loc;
      const when = fmtWhen(start);
      const url = `#/meetings/${mt.id}`;
      const base = { refType: "meeting", refId: mt.id, refStartsAt: mt.starts_at, url };
      const hs = mt.hot_seat_member_id as string | null;
      const checkedIn = new Set((checkins ?? []).filter((c) => c.meeting_id === mt.id).map((c) => c.member_id));
      const rsvpd = new Set((rsvps ?? []).filter((r) => r.meeting_id === mt.id).map((r) => r.member_id));
      const committed = new Set((commitments ?? []).filter((c) => c.meeting_id === mt.id).map((c) => c.member_id));

      if (start > now) {
        // 7 days before: everyone, email + push
        const t7 = new Date(start.getTime() - 7 * DAY);
        if (due(t7)) for (const m of roster) add({
          ...base, memberId: m.id, kind: "meeting_7d", category: "meeting", channels: ["email", "push"],
          subject: `${mt.title} is a week away`,
          body: `${mt.title}: ${when} CT, ${whereText(loc, false)}.${hs ? ` ${first(name(hs))} is on the hot seat.` : ""} Tap to RSVP.`,
          sendAt: t7.toISOString(),
        });

        // 48 hours before: hot seat person, sms + push
        const t48 = new Date(start.getTime() - 48 * HOUR);
        if (hs && due(t48)) add({
          ...base, memberId: hs, kind: "meeting_hotseat_48h", category: "meeting", channels: ["sms", "push"],
          subject: "You're on the hot seat",
          body: mt.hot_seat_prep
            ? `${gname}: you're on the hot seat ${when}. Your prep is in. Reread it before the meeting.`
            : `${gname}: you're on the hot seat ${when}. Your prep is due in 24 hours.`,
          sendAt: t48.toISOString(),
        });

        // 24 hours before: everyone, sms + push, with Zoom link or address; check-in nudge if missing
        const t24 = new Date(start.getTime() - 24 * HOUR);
        if (due(t24)) {
          for (const m of roster) {
            const nudge = !checkedIn.has(m.id) && nudgesOn(m.id) ? " Check in before it starts." : "";
            add({
              ...base, memberId: m.id, kind: "meeting_24h", category: "meeting", channels: ["sms", "push"],
              subject: `${mt.title} is tomorrow`,
              body: `${gname} tomorrow, ${when} CT. ${whereText(loc, true)}.${nudge}`,
              sendAt: t24.toISOString(),
            });
          }
          // 24 hours before: admins, email digest
          const noRsvp = roster.filter((m) => !rsvpd.has(m.id)).map((m) => m.name);
          const noCheckin = roster.filter((m) => !checkedIn.has(m.id)).map((m) => m.name);
          const going = (rsvps ?? []).filter((r) => r.meeting_id === mt.id && r.status === "yes").length;
          const digest = [
            `${mt.title}, ${when} CT. ${going} of ${roster.length} going.`,
            `Hot seat: ${hs ? `${name(hs)}, prep ${mt.hot_seat_prep ? "is in" : "NOT in yet"}` : "nobody assigned"}.`,
            `No RSVP (${noRsvp.length}): ${noRsvp.join(", ") || "none"}.`,
            `No check-in yet (${noCheckin.length}): ${noCheckin.join(", ") || "none"}.`,
          ].join("\n");
          for (const a of admins) add({
            ...base, memberId: a.id, kind: "meeting_admin_digest", category: "digest", channels: ["email"],
            subject: `Tomorrow's ${gname}: who's missing`, body: digest, sendAt: t24.toISOString(),
          });
        }

        // 1 hour before (groups with oneHourReminder, i.e. The Shoreline): push + sms with Zoom
        const t1 = new Date(start.getTime() - HOUR);
        if (oneHour && due(t1)) for (const m of roster) add({
          ...base, memberId: m.id, kind: "meeting_1h", category: "meeting", channels: ["push", "sms"],
          subject: `${gname} in an hour`,
          body: `${gname} starts in an hour. ${whereText(loc, true)}`,
          sendAt: t1.toISOString(),
        });
      } else {
        // Day after, 10 AM: no commitment yet -> push nudge. Hot seat person without action plan -> action plan push.
        const tAfter = localMorningAfter(start, 1);
        if (due(tAfter)) {
          for (const m of roster) {
            if (m.id === hs && !mt.action_plan) {
              add({
                ...base, memberId: m.id, kind: "meeting_day_after_action_plan", category: "nudge", channels: ["push"],
                subject: "Your action plan",
                body: "Thanks for taking the hot seat. Save the advice you're taking and your next step.",
                url: `#/hotseat`, sendAt: tAfter.toISOString(),
              });
            } else if (!committed.has(m.id)) {
              add({
                ...base, memberId: m.id, kind: "meeting_day_after_commitment", category: "nudge", channels: ["push"],
                subject: "Your commitment",
                body: `What's your one commitment from ${mt.title}? Add it so the group can cheer you on.`,
                url: `#/track`, sendAt: tAfter.toISOString(),
              });
            }
          }
        }
        // About 2 weeks after, 10 AM: commitment not done -> push nudge
        const t14 = localMorningAfter(start, 14);
        if (due(t14)) {
          for (const c of (commitments ?? []).filter((c) => c.meeting_id === mt.id && c.status !== "done")) {
            if (!roster.some((m) => m.id === c.member_id)) continue;
            add({
              ...base, memberId: c.member_id, kind: "commitment_2w", category: "nudge", channels: ["push"],
              subject: "Halfway check",
              body: `Halfway to the next meeting. How's "${c.text.slice(0, 80)}" going?`,
              url: `#/track`, sendAt: t14.toISOString(),
              dedupeBase: `commitment_2w:${c.id}`,
            });
          }
        }
      }
    }

    // ---------------- Trainings: 7 days email, 24 hours push ----------------
    const { data: trainings } = await db.from("trainings")
      .select("id, starts_at, topic, video_url").eq("group_id", gid).is("cancelled_at", null)
      .gt("starts_at", now.toISOString()).lte("starts_at", new Date(now.getTime() + 8 * DAY).toISOString());
    for (const tr of trainings ?? []) {
      const start = new Date(tr.starts_at);
      const label = tr.topic ? `Training: ${tr.topic}` : `${gname} training`;
      const base = { refType: "training", refId: tr.id, refStartsAt: tr.starts_at, url: "#/meetings", category: "other" as const };
      const t7 = new Date(start.getTime() - 7 * DAY);
      if (due(t7)) for (const m of roster) add({
        ...base, memberId: m.id, kind: "training_7d", channels: ["email"],
        subject: `${label}, ${fmtWhen(start)}`,
        body: `${label}, ${fmtWhen(start)} CT on video.${tr.video_url ? ` Join: ${tr.video_url}` : ""} RSVP in the app.`,
        sendAt: t7.toISOString(),
      });
      const t24 = new Date(start.getTime() - 24 * HOUR);
      if (due(t24)) for (const m of roster) add({
        ...base, memberId: m.id, kind: "training_24h", channels: ["push"],
        subject: `${label} tomorrow`,
        body: `${label} tomorrow at ${fmtWhen(start).split(", ")[1]} CT.${tr.video_url ? " Tap for the link." : ""}`,
        sendAt: t24.toISOString(),
      });
    }

    // ---------------- Get-togethers: 48 hours, push to "yes" and invitees ----------------
    const { data: gts } = await db.from("get_togethers")
      .select("id, title, starts_at, location, visibility, host_id, get_together_rsvps(member_id, status), get_together_invitees(member_id)")
      .eq("group_id", gid).eq("cancelled", false)
      .gt("starts_at", now.toISOString()).lte("starts_at", new Date(now.getTime() + 3 * DAY).toISOString());
    for (const e of gts ?? []) {
      const start = new Date(e.starts_at);
      const t48 = new Date(start.getTime() - 48 * HOUR);
      if (!due(t48)) continue;
      const rs = (e.get_together_rsvps ?? []) as { member_id: string; status: string }[];
      const no = new Set(rs.filter((r) => r.status === "no").map((r) => r.member_id));
      const who = new Set([
        ...rs.filter((r) => r.status === "yes").map((r) => r.member_id),
        ...((e.get_together_invitees ?? []) as { member_id: string }[]).map((i) => i.member_id),
      ]);
      for (const mid of who) {
        if (no.has(mid) || !roster.some((m) => m.id === mid)) continue;
        add({
          memberId: mid, kind: "gettogether_48h", category: "other", channels: ["push"],
          subject: e.title, body: `${e.title}, ${fmtWhen(start)}${e.location ? ` at ${e.location}` : ""}.`,
          url: `#/group/gettogethers/${e.id}`, refType: "get_together", refId: e.id, refStartsAt: e.starts_at,
          sendAt: t48.toISOString(),
        });
      }
    }
  }

  if (opts.dryRun) return json(req, { ok: true, dryRun: true, now: now.toISOString(), items });

  let queued = 0;
  for (let i = 0; i < items.length; i += 200) {
    const { data, error: e } = await db.rpc("enqueue_notifications", { p_items: items.slice(i, i + 200) });
    if (e) return json(req, { error: e.message, queuedSoFar: queued }, 500);
    queued += (data as number) ?? 0;
  }
  return json(req, { ok: true, now: now.toISOString(), considered: items.length, queued });
});
