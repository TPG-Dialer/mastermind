// send-notifications: runs every 5 minutes (cron.sql). Claims due rows from
// notification_queue, sends them, and records the outcome.
//
// - claim_notifications() (SQL) already skipped rows whose event moved,
//   was cancelled or already started.
// - Event pushes (new announcement, comments, "I can help", invites) are
//   bundled: at most one per member per hour. Extra ones wait and go out
//   together as "3 new updates".
// - Failed sends retry up to 3 times (finish_notifications in SQL).
// - Expired push subscriptions (404/410) are disabled.
//
// Secrets: see _shared/adapters.ts. DRY_RUN=true logs instead of sending.
import { corsHeaders, cronAuthorized, json, serviceClient, appLink } from "../_shared/http.ts";
import { sendEmail, sendPush, sendSms, type SendResult } from "../_shared/adapters.ts";
import { HOUR } from "../_shared/time.ts";

interface Row {
  id: number; group_id: string; member_id: string; kind: string; category: string; channel: "email" | "sms" | "push";
  dedupe_key: string; subject: string; body: string; url: string;
}
interface Result {
  id: number; status: "sent" | "failed" | "skipped" | "deferred";
  providerId?: string; error?: string; until?: string; bundleSize?: number; permanent?: boolean; // permanent = don't retry
}

const BUNDLE_WINDOW = HOUR;

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

function emailHtml(groupName: string, subject: string, body: string, link: string) {
  return `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#1b2430">
  <p style="font-size:13px;color:#667;margin:0 0 8px">${escapeHtml(groupName)}</p>
  <h2 style="font-size:20px;margin:0 0 12px">${escapeHtml(subject)}</h2>
  <p style="font-size:15px;line-height:1.5;white-space:pre-line">${escapeHtml(body)}</p>
  <p><a href="${escapeHtml(link)}" style="display:inline-block;background:#1F4D3A;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Open the app</a></p>
  <p style="font-size:12px;color:#889">You get this because you're in ${escapeHtml(groupName)}. Change reminders in the app under Profile.</p>
</div>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (!cronAuthorized(req)) return json(req, { error: "Forbidden" }, 403);
  const db = serviceClient();

  const { data: claimed, error } = await db.rpc("claim_notifications", { p_limit: 200 });
  if (error) return json(req, { error: error.message }, 500);
  const rows = (claimed ?? []) as Row[];
  if (!rows.length) return json(req, { ok: true, sent: 0 });

  const memberIds = [...new Set(rows.map((r) => r.member_id))];
  const [{ data: contacts }, { data: subs }, { data: groups }, { data: recent }] = await Promise.all([
    db.from("member_contacts").select("member_id, email, phone").in("member_id", memberIds),
    db.from("push_subscriptions").select("id, member_id, endpoint, p256dh, auth").in("member_id", memberIds).is("disabled_at", null),
    db.from("groups").select("id, name"),
    // Last event push per member, for bundling.
    db.from("notification_log").select("member_id, created_at")
      .in("member_id", memberIds).eq("channel", "push").eq("category", "event").eq("status", "sent")
      .gte("created_at", new Date(Date.now() - BUNDLE_WINDOW).toISOString()),
  ]);
  const contact = (id: string) => (contacts ?? []).find((c) => c.member_id === id);
  const subsOf = (id: string) => (subs ?? []).filter((s) => s.member_id === id);
  const groupName = (id: string) => (groups ?? []).find((g) => g.id === id)?.name ?? "Mastermind";
  const lastEventPush = new Map<string, number>();
  for (const r of recent ?? []) {
    const t = new Date(r.created_at).getTime();
    if (t > (lastEventPush.get(r.member_id) ?? 0)) lastEventPush.set(r.member_id, t);
  }

  const results: Result[] = [];

  async function pushTo(memberId: string, payload: { title: string; body: string; url: string; tag?: string }): Promise<SendResult> {
    const list = subsOf(memberId);
    if (!list.length) return { ok: false, error: "no push subscription" };
    const outcomes = await Promise.all(list.map(async (s) => {
      const r = await sendPush(s, payload);
      if (r.gone) await db.from("push_subscriptions").update({ disabled_at: new Date().toISOString() }).eq("id", s.id);
      else if (r.ok) await db.from("push_subscriptions").update({ last_success_at: new Date().toISOString() }).eq("id", s.id);
      return r;
    }));
    const ok = outcomes.find((o) => o.ok);
    return ok ?? outcomes[0];
  }

  // ---------- Event pushes: bundle per member ----------
  const eventPush = rows.filter((r) => r.channel === "push" && r.category === "event");
  const byMember = new Map<string, Row[]>();
  for (const r of eventPush) byMember.set(r.member_id, [...(byMember.get(r.member_id) ?? []), r]);
  for (const [mid, list] of byMember) {
    const last = lastEventPush.get(mid);
    if (last && Date.now() - last < BUNDLE_WINDOW) {
      const until = new Date(last + BUNDLE_WINDOW).toISOString();
      for (const r of list) results.push({ id: r.id, status: "deferred", until });
      continue;
    }
    const g = list[0].group_id;
    const payload = list.length === 1
      ? { title: list[0].subject || groupName(g), body: list[0].body, url: appLink(g, list[0].url), tag: list[0].kind }
      : {
        title: `${list.length} new updates in ${groupName(g)}`,
        body: list.slice(0, 3).map((r) => r.body).join("\n") + (list.length > 3 ? `\n+${list.length - 3} more` : ""),
        url: appLink(g, "#/home"), tag: "bundle",
      };
    const res = await pushTo(mid, payload);
    list.forEach((r, i) => results.push(res.ok
      ? { id: r.id, status: "sent", providerId: i === 0 ? res.id : `bundled:${list[0].id}`, bundleSize: i === 0 ? list.length : 0 }
      : { id: r.id, status: res.error === "no push subscription" ? "skipped" : "failed", error: res.error, permanent: res.retry === false }));
  }

  // ---------- Everything else: one by one ----------
  const rest = rows.filter((r) => !(r.channel === "push" && r.category === "event"));
  const CHUNK = 10;
  for (let i = 0; i < rest.length; i += CHUNK) {
    await Promise.all(rest.slice(i, i + CHUNK).map(async (r) => {
      const link = appLink(r.group_id, r.url);
      const gname = groupName(r.group_id);
      let res: SendResult;
      if (r.channel === "email") {
        const to = contact(r.member_id)?.email;
        if (!to) { results.push({ id: r.id, status: "skipped", error: "no email" }); return; }
        res = await sendEmail({
          to, subject: r.subject || gname, text: `${r.body}\n\n${link}`,
          html: emailHtml(gname, r.subject || gname, r.body, link), idempotencyKey: r.dedupe_key,
        });
      } else if (r.channel === "sms") {
        const to = contact(r.member_id)?.phone;
        if (!to) { results.push({ id: r.id, status: "skipped", error: "no phone" }); return; }
        res = await sendSms({ to, text: `${r.body} ${link}` });
      } else {
        res = await pushTo(r.member_id, { title: r.subject || gname, body: r.body, url: link, tag: r.kind });
        if (!res.ok && res.error === "no push subscription") {
          results.push({ id: r.id, status: "skipped", error: res.error }); return;
        }
      }
      results.push(res.ok ? { id: r.id, status: "sent", providerId: res.id }
        : { id: r.id, status: "failed", error: res.error, permanent: res.retry === false });
    }));
  }

  const { error: e2 } = await db.rpc("finish_notifications", { p_results: results });
  if (e2) return json(req, { error: e2.message }, 500);
  const count = (s: string) => results.filter((r) => r.status === s).length;
  return json(req, { ok: true, claimed: rows.length, sent: count("sent"), failed: count("failed"), skipped: count("skipped"), deferred: count("deferred") });
});
