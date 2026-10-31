-- =====================================================================
-- Mastermind app: scheduled jobs (pg_cron + pg_net -> Edge Functions)
-- Run once, after the functions are deployed. Safe to re-run: cron.schedule
-- with an existing job name updates that job.
--
-- Before running: fill in the two values in step 1 (your project URL and the
-- same CRON_SECRET you set with `supabase secrets set`). They are stored in
-- Supabase Vault, not in this file or in the job definitions.
-- All cron times are UTC.
-- =====================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 1. Secrets in Vault. Replace both placeholders, then run.
do $$
declare
  project_url text := 'https://YOUR-PROJECT-REF.supabase.co';   -- Project Settings > API > Project URL
  cron_secret text := 'PASTE-THE-SAME-CRON_SECRET-HERE';         -- same value as the function secret
begin
  if project_url like '%YOUR-PROJECT-REF%' or cron_secret like 'PASTE-%' then
    raise exception 'Edit cron.sql step 1 first: set project_url and cron_secret';
  end if;
  if exists (select 1 from vault.secrets where name = 'mm_project_url') then
    perform vault.update_secret((select id from vault.secrets where name = 'mm_project_url'), project_url);
  else
    perform vault.create_secret(project_url, 'mm_project_url', 'Mastermind: Supabase project URL');
  end if;
  if exists (select 1 from vault.secrets where name = 'mm_cron_secret') then
    perform vault.update_secret((select id from vault.secrets where name = 'mm_cron_secret'), cron_secret);
  else
    perform vault.create_secret(cron_secret, 'mm_cron_secret', 'Mastermind: x-cron-secret for scheduled functions');
  end if;
end $$;

-- 2. One helper that calls an Edge Function with the secret header.
create or replace function public.mm_call_function(p_name text, p_body jsonb default '{}'::jsonb) returns bigint
language sql security definer set search_path = public, pg_temp as $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'mm_project_url') || '/functions/v1/' || p_name,
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'mm_cron_secret')),
    body    := p_body,
    timeout_milliseconds := 55000
  )
$$;
revoke all on function public.mm_call_function(text, jsonb) from public, anon, authenticated;

-- 3. Jobs
-- Queue scheduled reminders: every hour at :05.
select cron.schedule('mm-schedule-notifications', '5 * * * *',
  $$ select public.mm_call_function('schedule-notifications') $$);

-- Send whatever is due: every 5 minutes.
select cron.schedule('mm-send-notifications', '*/5 * * * *',
  $$ select public.mm_call_function('send-notifications') $$);

-- Keep 12 months of meetings and trainings ahead: 1st of each month, 11:00 UTC (5-6 AM Central).
select cron.schedule('mm-generate-meetings', '0 11 1 * *',
  $$ select public.mm_call_function('generate-meetings') $$);

-- Housekeeping, Sundays 09:00 UTC: old queue rows, logs, join attempts, dead sessions.
select cron.schedule('mm-cleanup', '0 9 * * 0', $$
  delete from public.notification_queue where status in ('sent','skipped','failed') and created_at < now() - interval '60 days';
  delete from public.notification_log   where created_at < now() - interval '365 days';
  delete from public.join_attempts      where created_at < now() - interval '30 days';
  delete from public.sessions           where revoked_at is not null and revoked_at < now() - interval '90 days';
$$);

-- Check: select jobname, schedule, active from cron.job where jobname like 'mm-%';
-- Runs:  select * from cron.job_run_details order by start_time desc limit 20;
-- HTTP:  select * from net._http_response order by created desc limit 20;
-- Stop:  select cron.unschedule('mm-send-notifications');
