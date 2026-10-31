// Channel adapters: email (Resend), SMS (RingCentral), web push (VAPID).
// Each returns { ok, id?, error?, gone? }. With DRY_RUN=true, or when a
// channel's credentials are not set, nothing is sent and the message is logged
// instead, so the pipeline can be tested before any account exists.
import webpush from "npm:web-push@3.6.7";

export interface SendResult { ok: boolean; id?: string; error?: string; gone?: boolean; retry?: boolean }

const env = (k: string) => Deno.env.get(k) ?? "";
const dryRun = () => env("DRY_RUN") === "true";

function dry(channel: string, to: string, text: string): SendResult {
  console.log(`[dry-run ${channel}] to=${to} :: ${text.slice(0, 160)}`);
  return { ok: true, id: `dry-run-${channel}` };
}

// ---------------------------------------------------------------------
// Email: Resend  (https://resend.com/docs/api-reference/emails/send-email)
// Secrets: RESEND_API_KEY, EMAIL_FROM (e.g. "Flight Club <reminders@yourdomain.com>")
// TODO(Corey): create a Resend account, verify the sending domain, set both secrets.
// ---------------------------------------------------------------------
export async function sendEmail(msg: {
  to: string; subject: string; text: string; html?: string; idempotencyKey?: string; replyTo?: string;
}): Promise<SendResult> {
  const key = env("RESEND_API_KEY");
  const from = env("EMAIL_FROM");
  if (dryRun() || !key || !from) return dry("email", msg.to, `${msg.subject} | ${msg.text}`);
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(msg.idempotencyKey ? { "Idempotency-Key": msg.idempotencyKey.slice(0, 256) } : {}),
    },
    body: JSON.stringify({
      from, to: [msg.to], subject: msg.subject, text: msg.text,
      ...(msg.html ? { html: msg.html } : {}),
      ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.ok) return { ok: true, id: body.id };
  return { ok: false, error: `resend ${res.status}: ${body.message ?? body.name ?? "error"}`, retry: res.status >= 500 || res.status === 429 };
}

// ---------------------------------------------------------------------
// SMS: RingCentral  (JWT auth flow, then POST .../extension/~/sms)
// Secrets: RINGCENTRAL_CLIENT_ID, RINGCENTRAL_CLIENT_SECRET, RINGCENTRAL_JWT,
//          RINGCENTRAL_FROM_NUMBER (E.164, an SMS-enabled number on the account),
//          RINGCENTRAL_SERVER_URL (optional, default https://platform.ringcentral.com)
// TODO(Corey): in the RingCentral developer console create a "REST API App" with
// JWT auth and the SMS permission, generate a JWT credential for your user, and
// register the number for business texting (10DLC) or carriers will block it.
// ---------------------------------------------------------------------
let rcToken: { value: string; expires: number } | null = null;

async function ringCentralToken(): Promise<string> {
  if (rcToken && rcToken.expires > Date.now() + 60_000) return rcToken.value;
  const server = env("RINGCENTRAL_SERVER_URL") || "https://platform.ringcentral.com";
  const basic = btoa(`${env("RINGCENTRAL_CLIENT_ID")}:${env("RINGCENTRAL_CLIENT_SECRET")}`);
  const res = await fetch(`${server}/restapi/oauth/token`, {
    method: "POST",
    headers: { "Authorization": `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: env("RINGCENTRAL_JWT"),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`ringcentral auth ${res.status}: ${body.error_description ?? body.message ?? "error"}`);
  rcToken = { value: body.access_token, expires: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return rcToken.value;
}

export async function sendSms(msg: { to: string; text: string }): Promise<SendResult> {
  const ready = env("RINGCENTRAL_CLIENT_ID") && env("RINGCENTRAL_CLIENT_SECRET") && env("RINGCENTRAL_JWT") &&
    env("RINGCENTRAL_FROM_NUMBER");
  if (dryRun() || !ready) return dry("sms", msg.to, msg.text);
  try {
    const server = env("RINGCENTRAL_SERVER_URL") || "https://platform.ringcentral.com";
    const token = await ringCentralToken();
    const res = await fetch(`${server}/restapi/v1.0/account/~/extension/~/sms`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: { phoneNumber: env("RINGCENTRAL_FROM_NUMBER") },
        to: [{ phoneNumber: msg.to }],
        text: msg.text.slice(0, 1000),
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) rcToken = null;
    if (res.ok) return { ok: true, id: String(body.id ?? "") };
    return {
      ok: false, error: `ringcentral ${res.status}: ${body.message ?? body.errorCode ?? "error"}`,
      retry: res.status >= 500 || res.status === 429 || res.status === 401,
    };
  } catch (e) {
    return { ok: false, error: String(e), retry: true };
  }
}

// ---------------------------------------------------------------------
// Web push: VAPID  (payload encryption per RFC 8291 is done by the web-push library)
// Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT ("mailto:you@yourdomain.com")
// Generate keys once: npx web-push generate-vapid-keys
// The public key also goes in config/supabase.js (vapidPublicKey) for the browser.
// If npm:web-push misbehaves in the Edge runtime, swap this function for
// jsr:@negrel/webpush, which is written for Deno; the call shape is the same idea.
// ---------------------------------------------------------------------
let vapidSet = false;

export async function sendPush(
  sub: { endpoint: string; p256dh: string; auth: string },
  payload: { title: string; body: string; url: string; tag?: string },
): Promise<SendResult> {
  const pub = env("VAPID_PUBLIC_KEY"), priv = env("VAPID_PRIVATE_KEY");
  if (dryRun() || !pub || !priv) return dry("push", new URL(sub.endpoint).host, `${payload.title} | ${payload.body}`);
  if (!vapidSet) {
    webpush.setVapidDetails(env("VAPID_SUBJECT") || "mailto:PLACEHOLDER@example.com", pub, priv);
    vapidSet = true;
  }
  try {
    const res = await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      { TTL: 6 * 3600, urgency: "normal" },
    );
    return { ok: true, id: `${new URL(sub.endpoint).host}:${res.statusCode}` };
  } catch (e) {
    const code = (e as { statusCode?: number }).statusCode ?? 0;
    // 404/410 = subscription expired or the user turned notifications off.
    return { ok: false, gone: code === 404 || code === 410, error: `push ${code}: ${(e as Error).message}`, retry: code >= 500 || code === 429 };
  }
}
