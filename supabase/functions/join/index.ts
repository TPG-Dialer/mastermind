// join: invite code + pick your name + one-time code -> session token.
//
// POST /functions/v1/join   (every action needs the group's invite code)
//   { "action": "roster", "group": "family", "inviteCode": "SHORE26" }
//     -> 200 { group, members: [{ id, name, role }], smsAvailable }   ("Who are you?" screen)
//
//   { "action": "request-code", group, inviteCode, memberId, "channel"?: "email" | "sms" }
//     -> 200 { sent: true, channel, maskedTo, resendAfter: 30, expiresIn: 600, options, smsAvailable, devCode? }
//        a new 6-digit code was sent to the contact on file (devCode only in dry-run with DEV_SHOW_CODES=true)
//     -> 200 { sent: false, active: true, channel, maskedTo, resendAfter, expiresIn, options, smsAvailable }
//        no channel asked for and a code is still live: go straight to the code screen
//     -> 200 { choose: true, options: [{ channel, maskedTo }], smsAvailable }
//        email and text both possible and no channel given: let the member pick
//     -> 200 { enroll: true, smsAvailable }
//        no email or phone on file: first sign-in. Ask for theirs and call again with selfContact.
//     -> 409 no_channel, 429 resend_wait | too_many_codes, 503 send_failed
//
//   { "action": "request-code", group, inviteCode, memberId, "selfContact": { email, phone? }, "channel"? }
//     First sign-in on trust: only while the member has NO email or phone on file
//     (otherwise 409 contact_exists). The code goes to selfContact.email (or by text to
//     selfContact.phone when channel is "sms" and texting is set up). The contact is held in
//     login_codes.pending_email/pending_phone and saved to member_contacts only by a right
//     verify-code. Same answers and rate limits as above, plus enroll: true;
//     400 bad_email | bad_phone | bad_channel.
//
//   { "action": "verify-code", group, inviteCode, memberId, code, deviceLabel }
//     -> 200 { sessionToken, member: { id, name, role }, groupId, enrolled? }
//        enrolled: true = this was a first sign-in; the contact is now on file and the
//        group's other admins get a "signed in for the first time" notice
//     -> 400 bad_format, 401 wrong_code (attemptsLeft), 409 contact_exists, 410 expired,
//        429 locked | too_many_tries
//
//   wrong invite code -> 401 bad_invite; too many wrong invite codes from one IP -> 429
//
// The browser stores sessionToken and sends it as the x-session-token header on
// every PostgREST call. Only its sha256 is stored (sessions.token_hash). Codes are
// stored salted and hashed (login_codes.code_hash), checked by verify_login_code().
// Deploy with --no-verify-jwt: this is the one public entry point.
import { corsHeaders, json, serviceClient } from "../_shared/http.ts";
import { inviteHash, randomToken, safeEqual, sha256Hex } from "../_shared/crypto.ts";
import { sendEmail, sendSms, smsConfigured } from "../_shared/adapters.ts";

const INVITE_MAX_FAILURES = 10;    // wrong invite codes per IP per 15 minutes
const WINDOW_MINUTES = 15;
const CODE_TTL_MINUTES = 10;
const RESEND_SECONDS = 30;
const CODES_PER_MEMBER_HOUR = 5;
const CODES_PER_IP_HOUR = 15;
const WRONG_CODES_PER_IP = 15;     // per 15 minutes, across members

type Channel = "email" | "sms";
type Body = {
  action?: string; group?: string; inviteCode?: string; memberId?: string; deviceLabel?: string;
  channel?: string; code?: string; selfContact?: { email?: unknown; phone?: unknown } | null;
};
type Db = ReturnType<typeof serviceClient>;

const env = (k: string) => Deno.env.get(k) ?? "";
// Same rules as the member_contacts / login_codes checks in SQL.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const E164_RE = /^\+[1-9][0-9]{7,14}$/;

/** c•••y@gmail.com */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  const local = email.slice(0, at), domain = email.slice(at + 1);
  return `${local.slice(0, 1)}•••${local.length > 1 ? local.slice(-1) : ""}@${domain}`;
}
/** (•••) •••-0119 */
export function maskPhone(phone: string): string {
  return `(•••) •••-${phone.replace(/\D/g, "").slice(-4)}`;
}

/** Six digits, uniform (rejection sampling, no modulo bias). */
function sixDigits(): string {
  const a = new Uint32Array(1);
  do crypto.getRandomValues(a); while (a[0] >= 4_294_000_000);
  return String(a[0] % 1_000_000).padStart(6, "0");
}
/** '<salt>:<hex sha256(salt:code)>'. Must match verify_login_code() in SQL. */
export async function loginCodeHash(code: string, salt = randomToken(12)): Promise<string> {
  return `${salt}:${await sha256Hex(`${salt}:${code}`)}`;
}

function emailFrom(groupName: string): string {
  const name = groupName.replace(/["<>\r\n]/g, "").trim() || "Mastermind";
  const domain = env("EMAIL_FROM_DOMAIN") || "tpgmn.com";
  return `${name} <reminders@${domain}>`;
}

const escHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

function codeEmail(groupName: string, code: string) {
  const subject = `${groupName} sign-in code`;
  const text = `${code}\n\nThat's your ${groupName} sign-in code. Enter it in the app to finish signing in.\n` +
    `It expires in 10 minutes.\n\nIf you didn't ask for this code, you can ignore this email.\n`;
  const g = escHtml(groupName);
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#1b1b1b;max-width:480px">
<p style="margin:0 0 12px">Your ${g} sign-in code:</p>
<p style="margin:0 0 16px;font-size:34px;font-weight:700;letter-spacing:8px">${code}</p>
<p style="margin:0 0 12px">Enter it in the app to finish signing in. It expires in 10 minutes.</p>
<p style="margin:0;color:#666;font-size:14px">If you didn't ask for this code, you can ignore this email.</p></div>`;
  return { subject, text, html };
}
const codeSms = (groupName: string, code: string) => `${groupName}: your sign-in code is ${code}. Expires in 10 minutes.`;

async function countAttempts(db: Db, f: { ip?: string; member?: string; kind: string; ok?: boolean; minutes: number }) {
  let q = db.from("join_attempts").select("id", { count: "exact", head: true })
    .eq("kind", f.kind).gte("created_at", new Date(Date.now() - f.minutes * 60_000).toISOString());
  if (f.ip) q = q.eq("ip_hash", f.ip);
  if (f.member) q = q.eq("member_id", f.member);
  if (f.ok !== undefined) q = q.eq("ok", f.ok);
  const { count } = await q;
  return count ?? 0;
}
const logAttempt = (db: Db, row: { group_id: string; ip_hash: string; ok: boolean; kind: string; member_id?: string }) =>
  db.from("join_attempts").insert(row);

async function createSession(req: Request, db: Db, member: { id: string; name: string; role: string }, group: string, deviceLabel: unknown) {
  const token = randomToken(32);
  const { error } = await db.from("sessions").insert({
    member_id: member.id,
    group_id: group,
    token_hash: await sha256Hex(token),
    device_label: String(deviceLabel ?? "").slice(0, 80),
    user_agent: (req.headers.get("user-agent") ?? "").slice(0, 300),
  });
  if (error) return { error: error.message };
  return { sessionToken: token, member: { id: member.id, name: member.name, role: member.role }, groupId: group };
}

Deno.serve(handle);

export async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { error: "POST only" }, 405);

  let body: Body;
  try { body = await req.json(); } catch { return json(req, { error: "Bad JSON" }, 400); }
  const action = String(body.action ?? "");
  const group = String(body.group ?? "").trim();
  const invite = String(body.inviteCode ?? "").trim();
  if (!["roster", "request-code", "verify-code"].includes(action)) return json(req, { error: "Unknown action" }, 400);
  if (!group || !invite) return json(req, { error: "Enter the invite code from your invite.", code: "bad_invite" }, 400);

  const db = serviceClient();
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  const ipHash = await sha256Hex(`ip:${ip}`);
  const smsAvailable = smsConfigured();

  // Rate limit wrong invite codes.
  if (await countAttempts(db, { ip: ipHash, kind: "invite", ok: false, minutes: WINDOW_MINUTES }) >= INVITE_MAX_FAILURES) {
    return json(req, { error: "Too many tries. Wait 15 minutes and try again.", code: "too_many_tries" }, 429);
  }
  const { data: inv } = await db.from("group_invites").select("code_hash")
    .eq("group_id", group).is("revoked_at", null).maybeSingle();
  if (!inv || !safeEqual(inv.code_hash, await inviteHash(group, invite))) {
    await logAttempt(db, { group_id: group, ip_hash: ipHash, ok: false, kind: "invite" });
    return json(req, { error: "That code doesn't match this group. Check your invite and try again.", code: "bad_invite" }, 401);
  }

  if (action === "roster") {
    const { data: members, error } = await db.from("members").select("id, name, role")
      .eq("group_id", group).is("removed_at", null).order("sort_order").order("name");
    if (error) return json(req, { error: error.message }, 500);
    return json(req, { group, members, smsAvailable });
  }

  const memberId = String(body.memberId ?? "");
  const { data: member } = await db.from("members").select("id, name, role, group_id")
    .eq("id", memberId).eq("group_id", group).is("removed_at", null).maybeSingle();
  if (!member) return json(req, { error: "That name isn't on this group's roster.", code: "not_on_roster" }, 404);

  const { data: contact, error: cErr } = await db.rpc("login_contact", { p_group_id: group, p_member_id: member.id });
  if (cErr || !contact) return json(req, { error: cErr?.message ?? "Couldn't read contacts" }, 500);
  const onFile = { email: (contact.email || null) as string | null, phone: (contact.phone || null) as string | null };

  // ---- request-code
  if (action === "request-code") {
    const hasContact = !!(onFile.email || onFile.phone);
    const self = body.selfContact != null;
    let email = onFile.email, phone = onFile.phone;
    if (self) {
      // First sign-in on trust: only while nothing is on file. After that the destination is locked.
      if (hasContact) {
        return json(req, { error: "You already have an email or phone on file. Tap your name to get a code.", code: "contact_exists" }, 409);
      }
      const sc = body.selfContact as { email?: unknown; phone?: unknown };
      email = String(sc.email ?? "").trim();
      if (!email || email.length > 120 || !EMAIL_RE.test(email)) {
        return json(req, { error: "Check the email address.", code: "bad_email" }, 400);
      }
      const rawPhone = String(sc.phone ?? "").trim();
      phone = rawPhone ? rawPhone.replace(/[\s().-]/g, "") : null;
      if (phone && !E164_RE.test(phone)) {
        return json(req, { error: "Enter a 10-digit US mobile number, or leave it blank.", code: "bad_phone" }, 400);
      }
    } else if (!hasContact) {
      return json(req, { enroll: true, smsAvailable });
    }

    const options: { channel: Channel; maskedTo: string }[] = [];
    if (email) options.push({ channel: "email", maskedTo: maskEmail(email) });
    if (phone && smsAvailable) options.push({ channel: "sms", maskedTo: maskPhone(phone) });
    if (!options.length) {
      return json(req, { error: "Texting isn't set up yet. Ask your admin to add your email.", code: "no_channel" }, 409);
    }
    // A first sign-in sends to the email unless text is asked for: no "choose", no reuse of a live code.
    const want = body.channel == null || body.channel === "" ? (self ? "email" : null) : String(body.channel);
    if (want && !options.some((o) => o.channel === want)) {
      return json(req, { error: want === "sms" ? "Texting isn't available. Use email instead." : "There's no email on file. Use text instead.", code: "bad_channel" }, 400);
    }

    const { data: row } = await db.from("login_codes")
      .select("channel, sent_to_masked, attempts, created_at, expires_at, pending_email, pending_phone")
      .eq("member_id", member.id).maybeSingle();
    // Only a code for this same destination counts (for "still live" and the resend wait):
    // a first-sign-in code to another address, or a stale one, is simply replaced.
    const sameDest = !!row && (self
      ? row.pending_email === email && (row.pending_phone ?? null) === (phone ?? null)
      : row.pending_email == null && row.pending_phone == null);
    const existing = sameDest ? row : null;
    const now = Date.now();
    const age = existing ? (now - Date.parse(existing.created_at)) / 1000 : Infinity;
    const live = !!existing && Date.parse(existing.expires_at) > now && existing.attempts < 5;
    const wait = Math.max(0, Math.ceil(RESEND_SECONDS - age));

    if (!want) {
      if (live) {
        return json(req, {
          sent: false, active: true, channel: existing.channel, maskedTo: existing.sent_to_masked, resendAfter: wait,
          expiresIn: Math.max(0, Math.round((Date.parse(existing.expires_at) - now) / 1000)), options, smsAvailable,
        });
      }
      if (options.length > 1) return json(req, { choose: true, options, smsAvailable });
    }
    const channel: Channel = (want as Channel) ?? options[0].channel;
    if (existing && existing.channel === channel && wait > 0) {
      return json(req, { error: `Wait ${wait} seconds to send another code.`, code: "resend_wait", resendAfter: wait }, 429);
    }
    if (await countAttempts(db, { member: member.id, kind: "code_sent", minutes: 60 }) >= CODES_PER_MEMBER_HOUR ||
        await countAttempts(db, { ip: ipHash, kind: "code_sent", minutes: 60 }) >= CODES_PER_IP_HOUR) {
      return json(req, { error: "Too many codes sent. Wait an hour and try again, or ask your admin.", code: "too_many_codes" }, 429);
    }

    const code = sixDigits();
    const maskedTo = channel === "email" ? maskEmail(email!) : maskPhone(phone!);
    const { error: upErr } = await db.from("login_codes").upsert({
      member_id: member.id, group_id: group, code_hash: await loginCodeHash(code), channel, sent_to_masked: maskedTo,
      expires_at: new Date(now + CODE_TTL_MINUTES * 60_000).toISOString(), attempts: 0, created_at: new Date(now).toISOString(),
      pending_email: self ? email : null, pending_phone: self ? phone : null,
    }, { onConflict: "member_id" });
    if (upErr) return json(req, { error: upErr.message }, 500);
    await logAttempt(db, { group_id: group, ip_hash: ipHash, ok: true, kind: "code_sent", member_id: member.id });

    const { data: g } = await db.from("groups").select("name").eq("id", group).maybeSingle();
    const groupName = g?.name || group;
    const res = channel === "email"
      ? await sendEmail({ to: email!, from: emailFrom(groupName), ...codeEmail(groupName, code) }, { ignoreDryRun: true })
      : await sendSms({ to: phone!, text: codeSms(groupName, code) }, { ignoreDryRun: true });
    const devShow = env("DEV_SHOW_CODES") === "true";
    // In test mode (DEV_SHOW_CODES=true) the code is returned to the app even when sending is in
    // dry-run or fails, so sign-in can be tested before email/SMS are fully set up.
    const showCode = devShow && (res.dry || !res.ok);
    if (!res.ok && !devShow || (res.dry && !devShow)) {
      await db.from("login_codes").delete().eq("member_id", member.id);
      const detail = res.dry
        ? (channel === "email" ? "Email sending isn't set up yet (no RESEND_API_KEY)." : "Texting isn't set up yet.")
        : (res.error ?? "Unknown error");
      console.error(`[join] code not sent: group=${group} member=${member.id} channel=${channel}: ${detail}`);
      return json(req, { error: "We couldn't send the code; ask your admin.", detail, code: "send_failed" }, 503);
    }
    if (!res.ok) console.error(`[join] code send failed (shown in app, DEV_SHOW_CODES=true): ${res.error ?? "unknown"}`);
    if (res.dry) console.log(`[join] dry-run code for ${member.id} returned to the app (DEV_SHOW_CODES=true)`);
    if (self) console.log(`[join] first sign-in code: group=${group} member=${member.id} to ${maskedTo}`);
    return json(req, {
      sent: true, channel, maskedTo, resendAfter: RESEND_SECONDS, expiresIn: CODE_TTL_MINUTES * 60, options, smsAvailable,
      ...(self ? { enroll: true } : {}),
      ...(showCode ? { devCode: code, sendError: res.ok ? undefined : (res.error ?? 'send failed') } : {}),
    });
  }

  // ---- verify-code
  if (await countAttempts(db, { ip: ipHash, kind: "code_wrong", minutes: WINDOW_MINUTES }) >= WRONG_CODES_PER_IP) {
    return json(req, { error: "Too many tries. Wait 15 minutes and try again.", code: "too_many_tries" }, 429);
  }
  const entered = String(body.code ?? "").replace(/\D/g, "");
  if (entered.length !== 6) return json(req, { error: "Enter the 6-digit code.", code: "bad_format" }, 400);
  const { data: v, error: vErr } = await db.rpc("verify_login_code", { p_group_id: group, p_member_id: member.id, p_code: entered });
  if (vErr || !v) return json(req, { error: vErr?.message ?? "Couldn't check the code" }, 500);
  if (v.status === "ok") {
    const s = await createSession(req, db, member, group, body.deviceLabel);
    if ("error" in s) return json(req, { error: s.error }, 500);
    const enrolled = v.enrolled === true;
    await logAttempt(db, { group_id: group, ip_hash: ipHash, ok: true, kind: enrolled ? "self_enroll" : "code_ok", member_id: member.id });
    if (enrolled) console.log(`[join] first sign-in saved the member's own contact: group=${group} member=${member.id}`);
    return json(req, enrolled ? { ...s, enrolled: true } : s);
  }
  if (v.status === "contact_exists") {
    return json(req, { error: "Your sign-in details changed. Tap your name again to get a new code.", code: "contact_exists" }, 409);
  }
  if (v.status === "wrong") {
    await logAttempt(db, { group_id: group, ip_hash: ipHash, ok: false, kind: "code_wrong", member_id: member.id });
    const left = Number(v.attemptsLeft) || 0;
    return json(req, { error: `That code isn't right. ${left} ${left === 1 ? "try" : "tries"} left.`, code: "wrong_code", attemptsLeft: left }, 401);
  }
  if (v.status === "locked") {
    await logAttempt(db, { group_id: group, ip_hash: ipHash, ok: false, kind: "code_wrong", member_id: member.id });
    return json(req, { error: "Too many wrong tries. Send a new code.", code: "locked", attemptsLeft: 0 }, 429);
  }
  return json(req, { error: "That code has expired. Send a new one.", code: "expired" }, 410);
}
