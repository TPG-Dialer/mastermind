-- 0007: login verification (one-time codes by email or text).
--
-- Tapping your name on a new device now sends a 6-digit code to your email
-- (or phone, when SMS is set up); only the right code creates the session.
-- The join function does the work; this file adds what it stores and checks:
--
--   login_codes          one active code per member, hash only, 10 min, 5 tries
--   join_attempts        + member_id and kind, so code requests and wrong codes
--                          are rate limited per member and per IP like invite codes
--   login_contact()      the member's email/phone and whether anyone in the
--                          group has a contact yet (the first-admin bootstrap)
--   verify_login_code()  checks a code atomically (counts tries, locks at 5,
--                          deletes the code when it matches)
--   current_member_id()  sessions now lapse after 180 days without use
--   cron                 hourly delete of expired codes
--
-- Service role only: no RLS policies on login_codes, functions not granted to anon.
-- Safe to run twice.

-- 1. Codes ---------------------------------------------------------------
create table if not exists public.login_codes (
  member_id       text primary key,              -- one active code per member: a new request replaces it
  group_id        text not null,
  code_hash       text not null,                 -- '<salt>:<hex sha256(salt || ':' || code)>'; the code itself is never stored
  channel         text not null check (channel in ('email', 'sms')),
  sent_to_masked  text not null default '',      -- 'c•••y@gmail.com' / '(•••) •••-0119', for logs and support
  expires_at      timestamptz not null,
  attempts        int  not null default 0,       -- wrong tries; locked at 5
  created_at      timestamptz not null default now(),
  foreign key (member_id, group_id) references public.members(id, group_id) on delete cascade
);
create index if not exists login_codes_expires_idx on public.login_codes(expires_at);
comment on table public.login_codes is
  'Sign-in codes sent by the join function (request-code), checked by verify_login_code(). One row per member, hashed with a per-code salt, 10 minute life, 5 tries. Deleted on success; expired rows are removed hourly by cron. Service role only.';

alter table public.login_codes enable row level security;
revoke all on public.login_codes from anon, authenticated;

-- 2. Rate limiting: reuse join_attempts --------------------------------------
-- kind: 'invite' (invite code checked), 'code_sent', 'code_wrong', 'code_ok', 'bootstrap'.
alter table public.join_attempts add column if not exists member_id text;
alter table public.join_attempts add column if not exists kind text not null default 'invite';
create index if not exists join_attempts_member_idx on public.join_attempts(member_id, kind, created_at desc) where member_id is not null;
create index if not exists join_attempts_ip_kind_idx on public.join_attempts(ip_hash, kind, created_at desc);
comment on table public.join_attempts is
  'Login attempts, for rate limiting the join function. kind invite: invite-code checks (10 failures per IP per 15 min). code_sent: sign-in codes sent (5 per member and 15 per IP per hour). code_wrong: wrong sign-in codes (15 per IP per 15 min). bootstrap: a code-free join because nobody in the group had a contact yet. IPs are stored hashed. Service role only.';

-- 3. Who can get a code, and the bootstrap rule ------------------------------
create or replace function public.login_contact(p_group_id text, p_member_id text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'email', (select c.email from public.member_contacts c where c.member_id = p_member_id and c.group_id = p_group_id),
    'phone', (select c.phone from public.member_contacts c where c.member_id = p_member_id and c.group_id = p_group_id),
    'groupHasContact', exists (
      select 1 from public.member_contacts c
      join public.members m on m.id = c.member_id and m.group_id = c.group_id
      where c.group_id = p_group_id and m.removed_at is null
        and (nullif(btrim(c.email), '') is not null or nullif(btrim(c.phone), '') is not null))
  )
$$;
comment on function public.login_contact(text, text) is
  'For the join function: the member''s email and phone, and whether any active member of the group has one. While nobody has, the group is still being set up and the first sign-in needs no code.';

-- 4. Checking a code ---------------------------------------------------------
-- Returns { status, attemptsLeft }. status: 'ok' (code deleted), 'wrong' (one
-- try used), 'locked' (5 wrong tries), 'expired' or 'none'. Takes a row lock,
-- so parallel guesses can't get past the counter.
drop function if exists public.verify_login_code(text, text, text);
create or replace function public.verify_login_code(p_group_id text, p_member_id text, p_code text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c    public.login_codes;
  salt text;
begin
  select * into c from public.login_codes
  where member_id = p_member_id and group_id = p_group_id
  for update;
  if not found then return jsonb_build_object('status', 'none', 'attemptsLeft', 0); end if;
  if c.expires_at <= now() then return jsonb_build_object('status', 'expired', 'attemptsLeft', 0); end if;
  if c.attempts >= 5 then return jsonb_build_object('status', 'locked', 'attemptsLeft', 0); end if;
  salt := split_part(c.code_hash, ':', 1);
  if c.code_hash = salt || ':' || encode(sha256(convert_to(salt || ':' || btrim(coalesce(p_code, '')), 'UTF8')), 'hex') then
    delete from public.login_codes where member_id = c.member_id;
    return jsonb_build_object('status', 'ok', 'attemptsLeft', 5 - c.attempts);
  end if;
  update public.login_codes set attempts = attempts + 1 where member_id = c.member_id;
  return jsonb_build_object('status', case when c.attempts + 1 >= 5 then 'locked' else 'wrong' end,
                            'attemptsLeft', greatest(0, 4 - c.attempts));
end $$;
comment on function public.verify_login_code(text, text, text) is
  'Checks a sign-in code for the join function. Hash format must match loginCodeHash() in functions/join/index.ts.';

revoke all on function public.login_contact(text, text) from public, anon, authenticated;
revoke all on function public.verify_login_code(text, text, text) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.login_contact(text, text) to service_role;
    grant execute on function public.verify_login_code(text, text, text) to service_role;
    grant all on public.login_codes to service_role;
  end if;
end $$;

-- 5. Remember a device for 180 days ------------------------------------------
-- A session lapses after 180 days without use (touch_session moves
-- last_seen_at forward each time the app opens). Then the member signs in
-- again with a code.
create or replace function public.current_member_id() returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select s.member_id
  from public.sessions s
  join public.members m on m.id = s.member_id
  where s.token_hash = public.hash_token(public.request_session_token())
    and s.revoked_at is null
    and s.last_seen_at > now() - interval '180 days'
    and m.removed_at is null
$$;
comment on function public.current_member_id() is
  'Member id for the x-session-token on this request, or null (no token, revoked session, unused for 180 days, removed member). SECURITY DEFINER because sessions has no RLS policies. Policies wrap it as (select current_member_id()) so it runs once per statement.';

-- 6. Housekeeping: expired codes, hourly (only where pg_cron exists) -----------
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    perform cron.schedule('mm-login-codes-cleanup', '17 * * * *',
      $job$ delete from public.login_codes where expires_at < now() - interval '1 hour';
            delete from public.sessions where revoked_at is null and last_seen_at < now() - interval '270 days'; $job$);
  end if;
end $$;
