-- 0009: first sign-in on trust, locked afterwards (replaces the "bootstrap" join).
--
-- A member with no email and no phone on file adds their own email (and
-- optionally a mobile) on the sign-in screen. The code goes there; only when
-- the code is right does that contact get saved. From then on codes go only to
-- the contact on file, and the sign-in screen can't change it.
--
--   members                    + enrolled_at, enrolled_by ('self' | 'admin'): when
--                                the member's sign-in contact was first put on file,
--                                and by whom. Backfilled as 'admin' for contacts
--                                that already exist.
--   login_codes                + pending_email, pending_phone: the self-supplied
--                                contact a code was sent to. Written to
--                                member_contacts only by verify_login_code().
--   login_contact()            the member's email and phone (blank = none). The
--                                group-wide "anyone has a contact" flag is gone.
--   verify_login_code()        on a right code with a pending contact: saves it
--                                (only if the member still has none, else status
--                                'contact_exists'), marks enrolled 'self', and
--                                queues a notice to the group's other admins.
--   complete_self_enrollment() that step, service role only.
--   tg_member_contacts_enrolled  contact added by an admin -> enrolled 'admin'; by
--                                the member -> 'self'; contact removed -> cleared.
--   admin_reset_member_signin()  admins of the member's group: clears the contact
--                                row and pending code, signs the member out
--                                everywhere, disables their push, drops pending
--                                reminders. The person enrolls again next time.
--
-- Safe to run twice. schema.sql and policies.sql end with the same statements.

-- 1. Columns ----------------------------------------------------------------
alter table public.members add column if not exists enrolled_at timestamptz;
alter table public.members add column if not exists enrolled_by text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'members_enrolled_by_check' and conrelid = 'public.members'::regclass) then
    alter table public.members add constraint members_enrolled_by_check check (enrolled_by is null or enrolled_by in ('self', 'admin'));
  end if;
end $$;
comment on column public.members.enrolled_at is
  'When this member''s sign-in contact (email or phone) was first put on file. Null = none on file: the next sign-in adds one on trust (join request-code with selfContact).';
comment on column public.members.enrolled_by is
  '''self'' = the member added it (first sign-in, or their own profile), ''admin'' = an admin entered it.';

update public.members m set enrolled_at = c.updated_at, enrolled_by = 'admin'
  from public.member_contacts c
  where c.member_id = m.id and m.enrolled_at is null
    and (nullif(btrim(c.email), '') is not null or nullif(btrim(c.phone), '') is not null);

alter table public.login_codes add column if not exists pending_email text;
alter table public.login_codes add column if not exists pending_phone text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'login_codes_pending_email_check' and conrelid = 'public.login_codes'::regclass) then
    alter table public.login_codes add constraint login_codes_pending_email_check
      check (pending_email is null or (length(pending_email) <= 120 and pending_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'login_codes_pending_phone_check' and conrelid = 'public.login_codes'::regclass) then
    alter table public.login_codes add constraint login_codes_pending_phone_check
      check (pending_phone is null or pending_phone ~ '^\+[1-9][0-9]{7,14}$');
  end if;
end $$;
comment on column public.login_codes.pending_email is
  'First sign-in only: the email the member typed. Saved to member_contacts by verify_login_code() when the code is right.';
comment on column public.login_codes.pending_phone is
  'First sign-in only: the mobile the member typed (E.164), optional.';
comment on table public.join_attempts is
  'Login attempts, for rate limiting the join function. kind invite: invite-code checks (10 failures per IP per 15 min). code_sent: sign-in codes sent (5 per member and 15 per IP per hour). code_wrong: wrong sign-in codes (15 per IP per 15 min). code_ok: signed in with a code. self_enroll: first sign-in that saved the member''s own email/phone. IPs are stored hashed. Service role only.';

-- 2. Who gets a code ------------------------------------------------------------
create or replace function public.login_contact(p_group_id text, p_member_id text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'email', (select nullif(btrim(c.email), '') from public.member_contacts c where c.member_id = p_member_id and c.group_id = p_group_id),
    'phone', (select nullif(btrim(c.phone), '') from public.member_contacts c where c.member_id = p_member_id and c.group_id = p_group_id)
  )
$$;
comment on function public.login_contact(text, text) is
  'For the join function: the member''s email and phone on file (null when blank). Neither = first sign-in: the member adds their own.';

-- 3. Masks for the admin notice (same shapes as maskEmail/maskPhone in functions/join).
create or replace function public.mask_email(p text) returns text
language sql immutable as $$
  select case when p is null or position('@' in p) = 0 then p else
    left(l, 1) || '•••' || case when length(l) > 1 then right(l, 1) else '' end || '@' || d end
  from (select substring(p from '^(.*)@[^@]*$') as l, substring(p from '@([^@]*)$') as d) t
$$;
create or replace function public.mask_phone(p text) returns text
language sql immutable as $$
  select case when p is null then null else '(•••) •••-' || right(regexp_replace(p, '[^0-9]', '', 'g'), 4) end
$$;

-- 4. Saving a self-supplied contact ------------------------------------------------
-- Returns false (and changes nothing) when the member already has a contact or
-- is gone. Locks the member row, so two devices racing can't both enroll.
create or replace function public.complete_self_enrollment(p_group_id text, p_member_id text, p_email text, p_phone text)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  m     public.members;
  used  text;
  aid   text;
begin
  select * into m from public.members
    where id = p_member_id and group_id = p_group_id and removed_at is null for update;
  if not found then return false; end if;
  if exists (select 1 from public.member_contacts c where c.member_id = m.id
             and (nullif(btrim(c.email), '') is not null or nullif(btrim(c.phone), '') is not null)) then
    return false;
  end if;
  if nullif(btrim(p_email), '') is null and nullif(btrim(p_phone), '') is null then return false; end if;

  -- Mark first, so the member_contacts trigger leaves it as 'self'.
  update public.members set enrolled_at = now(), enrolled_by = 'self' where id = m.id;
  insert into public.member_contacts(member_id, group_id, email, phone)
    values (m.id, m.group_id, nullif(btrim(p_email), ''), nullif(btrim(p_phone), ''))
  on conflict (member_id) do update set email = excluded.email, phone = excluded.phone;
  insert into public.notification_prefs(member_id, group_id) values (m.id, m.group_id)
  on conflict (member_id) do nothing;

  used := concat_ws(' and ', public.mask_email(nullif(btrim(p_email), '')), public.mask_phone(nullif(btrim(p_phone), '')));
  for aid in select id from public.members
             where group_id = m.group_id and role = 'admin' and removed_at is null and id <> m.id loop
    perform public.enqueue_notification(aid, 'self_enrolled', 'event', array['push'],
      'First sign-in', m.name || ' signed in for the first time using ' || used
        || '. If that''s not them, open Members and reset their sign-in.',
      '#/group/members/' || m.id, null, null, null, now(),
      'self_enrolled:' || m.id || ':' || floor(extract(epoch from now()))::bigint || ':' || aid);
  end loop;
  return true;
end $$;
comment on function public.complete_self_enrollment(text, text, text, text) is
  'Called by verify_login_code() when a first-sign-in code is right: saves the member''s own email/phone (only if none is on file), marks enrolled_by = self, queues "signed in for the first time" to the other admins. Service role only.';

-- 5. Checking a code (now also finishes a first sign-in) -------------------------------
-- status: 'ok' (code deleted; enrolled true when it saved a pending contact),
-- 'contact_exists' (a pending contact, but one got on file meanwhile: code
-- deleted, no session), 'wrong', 'locked', 'expired', 'none'.
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
    if c.pending_email is not null or c.pending_phone is not null then
      if not public.complete_self_enrollment(p_group_id, p_member_id, c.pending_email, c.pending_phone) then
        return jsonb_build_object('status', 'contact_exists', 'attemptsLeft', 0);
      end if;
      return jsonb_build_object('status', 'ok', 'attemptsLeft', 5 - c.attempts, 'enrolled', true);
    end if;
    return jsonb_build_object('status', 'ok', 'attemptsLeft', 5 - c.attempts);
  end if;
  update public.login_codes set attempts = attempts + 1 where member_id = c.member_id;
  return jsonb_build_object('status', case when c.attempts + 1 >= 5 then 'locked' else 'wrong' end,
                            'attemptsLeft', greatest(0, 4 - c.attempts));
end $$;
comment on function public.verify_login_code(text, text, text) is
  'Checks a sign-in code for the join function. Hash format must match loginCodeHash() in functions/join/index.ts. A first-sign-in code (pending_email/pending_phone) also saves that contact via complete_self_enrollment().';

-- 6. Enrolled marker follows the contact row -------------------------------------------
create or replace function public.tg_member_contacts_enrolled() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare me text := public.current_member_id(); mid text; has_new boolean;
begin
  mid := case when tg_op = 'DELETE' then old.member_id else new.member_id end;
  has_new := tg_op <> 'DELETE' and (nullif(btrim(new.email), '') is not null or nullif(btrim(new.phone), '') is not null);
  if has_new then
    update public.members set enrolled_at = now(),
      enrolled_by = case when me is not null and me = mid then 'self' else 'admin' end
    where id = mid and enrolled_at is null;
  else
    update public.members set enrolled_at = null, enrolled_by = null where id = mid and enrolled_at is not null;
  end if;
  return null;
end $$;
drop trigger if exists member_contacts_enrolled on public.member_contacts;
create trigger member_contacts_enrolled after insert or update or delete on public.member_contacts
  for each row execute function public.tg_member_contacts_enrolled();

-- 7. Admin: reset someone's sign-in ------------------------------------------------------
create or replace function public.admin_reset_member_signin(p_member_id text) returns public.members
language plpgsql security definer set search_path = public, pg_temp as $$
declare g text := public.current_group_id(); m public.members;
begin
  if not public.is_admin() then raise exception 'Admins only' using errcode = 'insufficient_privilege'; end if;
  if p_member_id = public.current_member_id() then raise exception 'You can''t reset your own sign-in'; end if;
  select * into m from public.members where id = p_member_id and group_id = g for update;
  if not found then raise exception 'Member not found' using errcode = 'P0002'; end if;
  delete from public.member_contacts where member_id = m.id;
  delete from public.login_codes where member_id = m.id;
  update public.sessions set revoked_at = now() where member_id = m.id and revoked_at is null;
  update public.push_subscriptions set disabled_at = now() where member_id = m.id and disabled_at is null;
  delete from public.notification_queue where member_id = m.id and status = 'pending';
  update public.members set enrolled_at = null, enrolled_by = null where id = m.id returning * into m;
  return m;
end $$;
comment on function public.admin_reset_member_signin(text) is
  'Admins of the member''s group: removes the member''s email/phone, any pending code, signs them out on every device and disables their push. Their next sign-in adds a contact again (first sign-in on trust).';

-- 8. Privileges ----------------------------------------------------------------------------
revoke all on function public.login_contact(text, text) from public, anon, authenticated;
revoke all on function public.verify_login_code(text, text, text) from public, anon, authenticated;
revoke all on function public.complete_self_enrollment(text, text, text, text) from public, anon, authenticated;
revoke all on function public.tg_member_contacts_enrolled() from public, anon, authenticated;
revoke all on function public.mask_email(text) from public, anon, authenticated;
revoke all on function public.mask_phone(text) from public, anon, authenticated;
revoke all on function public.admin_reset_member_signin(text) from public, anon, authenticated;
grant execute on function public.admin_reset_member_signin(text) to anon;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.login_contact(text, text) to service_role;
    grant execute on function public.verify_login_code(text, text, text) to service_role;
    grant execute on function public.complete_self_enrollment(text, text, text, text) to service_role;
    grant execute on function public.mask_email(text) to service_role;
    grant execute on function public.mask_phone(text) to service_role;
    grant execute on function public.admin_reset_member_signin(text) to service_role;
  end if;
end $$;
