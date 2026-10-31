// CORS, JSON responses, the service-role client, and the cron guard.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";

// ALLOWED_ORIGINS: comma list, e.g. "https://corey.github.io,http://localhost:8000". Unset = any origin.
const allowed = (Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allow = allowed.length === 0 ? "*" : (allowed.includes(origin) ? origin : allowed[0]);
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-session-token, x-cron-secret",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}

/** Service-role client: bypasses RLS. Only ever used inside Edge Functions. */
export function serviceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing (Supabase sets these automatically)");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Scheduled functions accept only calls carrying CRON_SECRET (sent by cron.sql). */
export function cronAuthorized(req: Request): boolean {
  const secret = Deno.env.get("CRON_SECRET");
  if (!secret) return false;
  return req.headers.get("x-cron-secret") === secret;
}

export function appLink(groupId: string, hash = ""): string {
  // Each group has its own address (APP_URL_FAMILY / APP_URL_ENTREPRENEUR); APP_URL is the fallback with ?group=.
  const perGroup = Deno.env.get(`APP_URL_${groupId.toUpperCase()}`);
  if (perGroup) return `${perGroup.replace(/\/?$/, "/")}${hash}`;
  const base = (Deno.env.get("APP_URL") ?? "https://PLACEHOLDER.github.io/mastermind/").replace(/\/?$/, "/");
  return `${base}?group=${encodeURIComponent(groupId)}${hash}`;
}
