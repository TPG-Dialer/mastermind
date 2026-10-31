// join: invite code + pick your name -> session token.
//
// POST /functions/v1/join
//   { "action": "roster", "group": "family", "inviteCode": "FAMILY2026" }
//     -> 200 { group, members: [{ id, name, role }] }        (for the "Who are you?" screen)
//   { "action": "join", "group": "family", "inviteCode": "FAMILY2026", "memberId": "m3", "deviceLabel": "Jake's iPhone" }
//     -> 200 { sessionToken, member: { id, name, role }, groupId }
//   wrong code -> 401, too many wrong codes from one IP -> 429
//
// The browser stores sessionToken and sends it as the x-session-token header on
// every PostgREST call. Only its sha256 is stored (sessions.token_hash).
// Deploy with --no-verify-jwt: this is the one public entry point.
import { corsHeaders, json, serviceClient } from "../_shared/http.ts";
import { inviteHash, randomToken, safeEqual, sha256Hex } from "../_shared/crypto.ts";

const MAX_FAILURES = 10;          // per IP
const WINDOW_MINUTES = 15;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { error: "POST only" }, 405);

  let body: { action?: string; group?: string; inviteCode?: string; memberId?: string; deviceLabel?: string };
  try { body = await req.json(); } catch { return json(req, { error: "Bad JSON" }, 400); }
  const action = body.action ?? "join";
  const group = String(body.group ?? "").trim();
  const code = String(body.inviteCode ?? "").trim();
  if (!group || !code) return json(req, { error: "Enter the invite code from your invite." }, 400);
  if (action !== "roster" && action !== "join") return json(req, { error: "Unknown action" }, 400);

  const db = serviceClient();
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  const ipHash = await sha256Hex(`ip:${ip}`);

  // Rate limit wrong codes.
  const since = new Date(Date.now() - WINDOW_MINUTES * 60_000).toISOString();
  const { count } = await db.from("join_attempts").select("id", { count: "exact", head: true })
    .eq("ip_hash", ipHash).eq("ok", false).gte("created_at", since);
  if ((count ?? 0) >= MAX_FAILURES) {
    return json(req, { error: "Too many tries. Wait 15 minutes and try again." }, 429);
  }

  const { data: invite } = await db.from("group_invites").select("code_hash")
    .eq("group_id", group).is("revoked_at", null).maybeSingle();
  const ok = !!invite && safeEqual(invite.code_hash, await inviteHash(group, code));
  if (!ok) {
    await db.from("join_attempts").insert({ group_id: group, ip_hash: ipHash, ok: false });
    return json(req, { error: "That code doesn't match this group. Check your invite and try again." }, 401);
  }

  if (action === "roster") {
    const { data: members, error } = await db.from("members").select("id, name, role")
      .eq("group_id", group).is("removed_at", null).order("sort_order").order("name");
    if (error) return json(req, { error: error.message }, 500);
    return json(req, { group, members });
  }

  const memberId = String(body.memberId ?? "");
  const { data: member } = await db.from("members").select("id, name, role, group_id")
    .eq("id", memberId).eq("group_id", group).is("removed_at", null).maybeSingle();
  if (!member) return json(req, { error: "That name isn't on this group's roster." }, 404);

  const token = randomToken(32);
  const { error } = await db.from("sessions").insert({
    member_id: member.id,
    group_id: group,
    token_hash: await sha256Hex(token),
    device_label: String(body.deviceLabel ?? "").slice(0, 80),
    user_agent: (req.headers.get("user-agent") ?? "").slice(0, 300),
  });
  if (error) return json(req, { error: error.message }, 500);
  await db.from("join_attempts").insert({ group_id: group, ip_hash: ipHash, ok: true });

  return json(req, { sessionToken: token, member: { id: member.id, name: member.name, role: member.role }, groupId: group });
});
