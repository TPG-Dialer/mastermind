// zoom-webhook: Zoom AI Companion meeting summaries -> meeting notes (The Shoreline).
//
// Zoom calls POST /functions/v1/zoom-webhook (Event Subscriptions on the
// "Mastermind notes" Server-to-Server OAuth app; see supabase/ZOOM.md).
//
//   Every request is signed: x-zm-signature = "v0=" + hex HMAC-SHA256(secret,
//   "v0:{x-zm-request-timestamp}:{raw body}"), with ZOOM_WEBHOOK_SECRET_TOKEN.
//   Wrong or missing signature, or a timestamp more than 5 minutes off -> 401.
//
//   endpoint.url_validation  { payload: { plainToken } }
//     -> 200 { plainToken, encryptedToken: hex HMAC-SHA256(secret, plainToken) }
//
//   meeting.summary_completed  { payload: { object: { meeting_id, meeting_uuid,
//       meeting_topic, meeting_start_time, summary_overview?, summary_details?,
//       next_steps?, ... } } }
//     Uses the summary in the payload when it is there; otherwise fetches
//     GET https://api.zoom.us/v2/meetings/{uuid}/meeting_summary with a
//     Server-to-Server OAuth token (ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID,
//     ZOOM_CLIENT_SECRET). Then ingest_zoom_summary() (SQL) matches the Zoom
//     meeting id to a group (group_settings.zoom_meeting_id) and to the group
//     meeting starting within 6 hours, and upserts the meeting_notes row. The
//     database triggers queue "Notes from {meeting} are in" for the group, or
//     "Zoom notes arrived but didn't match a meeting" for the admins.
//     -> 200 { ok, status: matched | unmatched | ignored, ... }
//        ignored = a Zoom meeting no group uses (Corey's other calls): nothing stored.
//     -> 200 { ok, queued: true } when the work takes longer than Zoom's 3-second
//        limit; it carries on in the background (EdgeRuntime.waitUntil).
//     -> 500 when the summary can't be fetched or saved in time, so Zoom retries.
//
//   any other event -> 200 { ok, ignored }
//
// Deploy with --no-verify-jwt: Zoom doesn't send a Supabase JWT; the signature is the check.
import { json, serviceClient } from "../_shared/http.ts";
import { hmacSha256Hex, safeEqual } from "../_shared/crypto.ts";

const env = (k: string) => (Deno.env.get(k) ?? "").trim();
const MAX_SKEW_SECONDS = 300;
const ZOOM_API = "https://api.zoom.us/v2";
const ZOOM_OAUTH = "https://zoom.us/oauth/token";

// deno-lint-ignore no-explicit-any
type Json = any;

export interface NoteParts { title: string; summary: string; keyPoints: string[]; nextSteps: string[] }

/** True when the x-zm-signature header is right for this body and the timestamp is fresh. */
export async function verifySignature(headers: Headers, rawBody: string, secret: string, nowMs = Date.now()): Promise<boolean> {
  const sig = headers.get("x-zm-signature") ?? "";
  const ts = headers.get("x-zm-request-timestamp") ?? "";
  if (!sig || !/^\d{9,13}$/.test(ts)) return false;
  const tsSec = ts.length > 11 ? Math.floor(Number(ts) / 1000) : Number(ts);   // seconds (Zoom), tolerate ms
  if (Math.abs(nowMs / 1000 - tsSec) > MAX_SKEW_SECONDS) return false;
  const expected = `v0=${await hmacSha256Hex(secret, `v0:${ts}:${rawBody}`)}`;
  return safeEqual(sig, expected);
}

const str = (x: unknown): string => (typeof x === "string" ? x.trim() : typeof x === "number" ? String(x) : "");
const nonEmpty = (x: unknown) => str(x) !== "";

/** A list item from Zoom: a string, or { label, summary } / { text } / { content }. */
function itemText(x: Json): string {
  if (typeof x === "string") return x.trim();
  if (!x || typeof x !== "object") return "";
  const label = str(x.label ?? x.title ?? x.topic);
  const body = str(x.summary ?? x.text ?? x.content ?? x.detail ?? x.description);
  if (label && body) return `${label}: ${body}`;
  return body || label;
}
function list(x: Json): string[] {
  if (Array.isArray(x)) return x.map(itemText).filter(Boolean);
  if (typeof x === "string") return x.split(/\n+/).map((s) => s.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim()).filter(Boolean);
  return [];
}

/** Summary fields from a webhook object or a meeting_summary API answer. edited_summary (host edits in Zoom) wins. */
export function noteParts(o: Json): NoteParts {
  const src = o ?? {};
  const ed = src.edited_summary && typeof src.edited_summary === "object" ? src.edited_summary : {};
  const pick = (k: string) => (ed[k] !== undefined && ed[k] !== null && (Array.isArray(ed[k]) ? ed[k].length : nonEmpty(ed[k])) ? ed[k] : src[k]);
  const overview = str(pick("summary_overview"));
  const details = list(pick("summary_details"));
  const steps = list(pick("next_steps"));
  const content = str(pick("summary_content"));
  return {
    title: str(src.summary_title),
    summary: overview || (details.length || steps.length ? "" : content),
    keyPoints: details,
    nextSteps: steps,
  };
}
export const hasSummary = (p: NoteParts) => !!(p.summary || p.keyPoints.length || p.nextSteps.length);

/** Meeting UUIDs that start with "/" or contain "//" must be encoded twice (Zoom API rule). */
export function encodeMeetingUuid(uuid: string): string {
  const once = encodeURIComponent(uuid);
  return uuid.startsWith("/") || uuid.includes("//") ? encodeURIComponent(once) : once;
}

let zoomToken: { value: string; expires: number } | null = null;
async function zoomAccessToken(): Promise<string> {
  if (zoomToken && zoomToken.expires > Date.now() + 60_000) return zoomToken.value;
  const account = env("ZOOM_ACCOUNT_ID"), id = env("ZOOM_CLIENT_ID"), secret = env("ZOOM_CLIENT_SECRET");
  if (!account || !id || !secret) throw new Error("Zoom API credentials not set (ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET)");
  const res = await fetch(`${ZOOM_OAUTH}?grant_type=account_credentials&account_id=${encodeURIComponent(account)}`, {
    method: "POST",
    headers: { "Authorization": `Basic ${btoa(`${id}:${secret}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error(`zoom oauth ${res.status}: ${body.reason ?? body.error ?? "error"}`);
  zoomToken = { value: body.access_token, expires: Date.now() + (Number(body.expires_in) || 3600) * 1000 };
  return zoomToken.value;
}

/** GET /meetings/{id}/meeting_summary (uuid preferred: the numeric id of a recurring meeting is every instance). */
export async function fetchSummary(uuid: string, meetingId: string): Promise<Json> {
  const key = uuid ? encodeMeetingUuid(uuid) : encodeURIComponent(meetingId);
  if (!key) throw new Error("no meeting id to fetch the summary for");
  const token = await zoomAccessToken();
  const res = await fetch(`${ZOOM_API}/meetings/${key}/meeting_summary`, { headers: { "Authorization": `Bearer ${token}` } });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) zoomToken = null;
  if (!res.ok) throw new Error(`zoom meeting_summary ${res.status}: ${body.message ?? "error"}`);
  return body;
}

/** Everything after the signature check for meeting.summary_completed. */
export async function handleSummary(event: Json): Promise<Json> {
  const o = (event && event.payload && event.payload.object) || {};
  const meetingId = str(o.meeting_id ?? o.id);
  const uuid = str(o.meeting_uuid ?? o.uuid);
  let parts = noteParts(o);
  let fetched: Json = null;
  if (!hasSummary(parts)) {
    fetched = await fetchSummary(uuid, meetingId);
    parts = noteParts(fetched);
  }
  const f = fetched ?? {};
  const p = {
    zoomMeetingId: meetingId || str(f.meeting_id),
    uuid: uuid || str(f.meeting_uuid),
    topic: str(o.meeting_topic ?? o.topic) || str(f.meeting_topic),
    startTime: str(o.meeting_start_time ?? o.start_time) || str(f.meeting_start_time),
    endTime: str(o.meeting_end_time ?? o.end_time) || str(f.meeting_end_time),
    title: parts.title,
    summary: parts.summary,
    keyPoints: parts.keyPoints,
    nextSteps: parts.nextSteps,
    raw: { event, summary: fetched },
  };
  const db = serviceClient();
  const { data, error } = await db.rpc("ingest_zoom_summary", { p });
  if (error) throw new Error(`ingest_zoom_summary: ${error.message}`);
  console.log(`[zoom-webhook] summary for zoom meeting ${p.zoomMeetingId}: ${data?.status}${data?.meetingId ? ` -> ${data.meetingId}` : ""}`);
  return data;
}

// Zoom wants an answer within 3 seconds. Work that takes longer keeps running after the reply.
const INLINE_MS = () => Number(env("ZOOM_INLINE_MS")) || 2500;
function waitUntil(p: Promise<unknown>) {
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt && typeof rt.waitUntil === "function") rt.waitUntil(p);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(req, { error: "POST only" }, 405);
  const secret = env("ZOOM_WEBHOOK_SECRET_TOKEN");
  if (!secret) {
    console.error("[zoom-webhook] ZOOM_WEBHOOK_SECRET_TOKEN is not set");
    return json(req, { error: "Not configured" }, 503);
  }
  const raw = await req.text();
  if (!(await verifySignature(req.headers, raw, secret))) return json(req, { error: "Bad signature" }, 401);
  let event: Json;
  try { event = JSON.parse(raw); } catch { return json(req, { error: "Bad JSON" }, 400); }

  if (event?.event === "endpoint.url_validation") {
    const plain = str(event?.payload?.plainToken);
    // Never sign something shaped like a signature message.
    if (!plain || plain.length > 256 || plain.startsWith("v0")) return json(req, { error: "Bad plainToken" }, 400);
    return json(req, { plainToken: plain, encryptedToken: await hmacSha256Hex(secret, plain) });
  }

  if (event?.event !== "meeting.summary_completed") return json(req, { ok: true, ignored: String(event?.event ?? "") });

  const work = handleSummary(event).then((r) => ({ ok: true as const, r }), (e) => ({ ok: false as const, e }));
  let timer: number | undefined;
  const late = new Promise<null>((res) => { timer = setTimeout(() => res(null), INLINE_MS()) as unknown as number; });
  const first = await Promise.race([work, late]);
  clearTimeout(timer);
  if (first === null) {
    waitUntil(work.then((x) => { if (!x.ok) console.error(`[zoom-webhook] background: ${String(x.e)}`); }));
    return json(req, { ok: true, queued: true });
  }
  if (!first.ok) {
    console.error(`[zoom-webhook] ${String(first.e)}`);
    return json(req, { error: "Couldn't save the summary" }, 500);
  }
  return json(req, Object.assign({ ok: true }, first.r));
});
