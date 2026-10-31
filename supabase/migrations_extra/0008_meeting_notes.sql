-- 0008: meeting notes, and the Zoom AI Companion feed (The Shoreline).
--
--   meeting_notes            one row per meeting per source ('manual' typed by an
--                              admin, 'zoom' from the zoom-webhook function).
--                              Zoom rows can arrive before they match a meeting
--                              (meeting_id null): only admins see those.
--   group_settings           + zoom_meeting_id: the recurring Zoom meeting's
--                              numeric id. set_group_location() fills it in from
--                              the pasted Zoom link (/j/<digits>).
--   ingest_zoom_summary()    service role only: matches a Zoom summary to a
--                              group and meeting (start within 6 hours) and
--                              upserts the note. Called by functions/zoom-webhook.
--   triggers                 "Notes from <meeting> are in" to the group when a
--                              Zoom note lands on a meeting; "didn't match" to
--                              admins when it doesn't. Change feed for realtime.
--
-- Who can do what (RLS + column grants):
--   read     group members, notes attached to a meeting; admins also unattached ones.
--            The raw Zoom payload (raw, zoom_uuid) is not readable by the app at all.
--   insert   admins, manual notes only.
--   update   admins: title, summary, key points, next steps, which meeting.
--            Zoom notes: summary, key points, next steps and meeting (the title and
--            raw stay as Zoom sent them).
--   delete   admins.
--   zoom     rows are written by the service role only (ingest_zoom_summary).
--
-- Safe to run twice. schema.sql and policies.sql end with the same statements.

-- 1. Zoom meeting id on the group -------------------------------------------
alter table public.group_settings
  add column if not exists zoom_meeting_id text check (zoom_meeting_id ~ '^[0-9]{9,12}$');
comment on column public.group_settings.zoom_meeting_id is
  'Numeric id of the group''s recurring Zoom meeting (from /j/<id> in the Zoom link). The zoom-webhook function matches AI Companion summaries to the group by it. Set by set_group_location().';

-- "https://us06web.zoom.us/j/85123456789?pwd=..." -> '85123456789'. Null for
-- vanity links (/my/name) and the 0000000000 placeholder.
create or replace function public.zoom_meeting_id_from_url(p_url text) returns text
language sql immutable as $$
  select case when m is null or m ~ '^0+$' then null else m end
  from (select substring(coalesce(p_url, '') from '/j/([0-9]{9,12})(?:[^0-9]|$)') as m) t
$$;

-- Admin: group's usual meeting place. Null = back to the config default.
-- Also keeps zoom_meeting_id in step with the Zoom link.
create or replace function public.set_group_location(p_location jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare eff jsonb;
begin
  if not public.is_admin() then raise exception 'Admins only' using errcode = 'insufficient_privilege'; end if;
  if p_location is not null and (p_location->>'type') not in ('zoom','inperson') then
    raise exception 'location.type must be zoom or inperson';
  end if;
  update public.group_settings set location_override = p_location where group_id = public.current_group_id()
    returning coalesce(location_override, location_default) into eff;
  update public.group_settings
    set zoom_meeting_id = case when eff->>'type' = 'zoom' then public.zoom_meeting_id_from_url(eff->>'url') end
    where group_id = public.current_group_id();
  return p_location;
end $$;

-- Backfill from a link that is already saved.
update public.group_settings
  set zoom_meeting_id = public.zoom_meeting_id_from_url(coalesce(location_override, location_default)->>'url')
  where zoom_meeting_id is null and coalesce(location_override, location_default)->>'type' = 'zoom'
    and public.zoom_meeting_id_from_url(coalesce(location_override, location_default)->>'url') is not null;

-- 2. Notes ------------------------------------------------------------------
create or replace function public.valid_note_lists(p_points jsonb, p_steps jsonb) returns boolean
language sql immutable as $$
  select jsonb_typeof(p_points) = 'array' and jsonb_typeof(p_steps) = 'array'
    and jsonb_array_length(p_points) <= 60 and jsonb_array_length(p_steps) <= 60
    and not exists (select 1 from jsonb_array_elements(p_points) e where jsonb_typeof(e) <> 'string')
    and not exists (select 1 from jsonb_array_elements(p_steps) e
                    where jsonb_typeof(e) <> 'object' or coalesce(btrim(e->>'text'), '') = ''
                       or (e ? 'memberId' and jsonb_typeof(e->'memberId') not in ('string', 'null')))
$$;

create table if not exists public.meeting_notes (
  id             text primary key default gen_random_uuid()::text,
  group_id       text not null default public.current_group_id() references public.groups(id) on delete cascade,
  meeting_id     text,                        -- null: a Zoom summary that didn't match a meeting (admins file it)
  source         text not null default 'manual' check (source in ('manual', 'zoom')),
  title          text not null default '' check (length(title) <= 200),
  summary        text not null default '' check (length(summary) <= 30000),   -- markdown-ish: paragraphs, "- " bullets, **bold**, "### " headings
  key_points     jsonb not null default '[]'::jsonb,                          -- [string]
  next_steps     jsonb not null default '[]'::jsonb,                          -- [{ text, memberId? }]
  raw            jsonb,                       -- Zoom: the webhook event and the summary API answer, as received
  zoom_uuid      text,                        -- Zoom meeting instance uuid (one note per instance)
  zoom_topic     text,                        -- Zoom: topic and start, so an admin can tell which call an unmatched note is from
  zoom_start_at  timestamptz,
  created_by     text default public.current_member_id(),   -- null for Zoom
  edited_by      text,                        -- last member to change it (admins editing a Zoom note)
  edited_at      timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (meeting_id, source),
  foreign key (meeting_id, group_id) references public.meetings(id, group_id) on delete set null (meeting_id),
  foreign key (created_by, group_id) references public.members(id, group_id) on delete set null (created_by),
  check (public.valid_note_lists(key_points, next_steps)),
  check (source = 'zoom' or (raw is null and zoom_uuid is null))
);
create index if not exists meeting_notes_group_idx on public.meeting_notes(group_id, created_at);
create unique index if not exists meeting_notes_zoom_uuid_idx on public.meeting_notes(group_id, zoom_uuid) where zoom_uuid is not null;
comment on table public.meeting_notes is
  'Meeting notes. One manual note (admins) and one Zoom AI Companion note (zoom-webhook) per meeting. raw keeps the Zoom payload even after an admin edits the summary.';

-- Member requests (current_member_id() set) are checked here; the service role is trusted.
create or replace function public.tg_meeting_notes_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare me text := public.current_member_id(); clean jsonb;
begin
  if me is null then return new; end if;
  if tg_op = 'INSERT' then
    if new.source <> 'manual' then raise exception 'Only manual notes can be added in the app' using errcode = 'insufficient_privilege'; end if;
    if new.meeting_id is null then raise exception 'Notes belong to a meeting'; end if;
    new.created_by := me;
    new.edited_by := null; new.edited_at := null;
  else
    if new.source is distinct from old.source or new.group_id is distinct from old.group_id
       or new.raw is distinct from old.raw or new.zoom_uuid is distinct from old.zoom_uuid
       or new.created_by is distinct from old.created_by then
      raise exception 'That part of the notes can''t be changed' using errcode = 'insufficient_privilege';
    end if;
    if old.source = 'zoom' and new.title is distinct from old.title then
      raise exception 'A Zoom note keeps its title' using errcode = 'insufficient_privilege';
    end if;
    new.edited_by := me;
    new.edited_at := now();
  end if;
  -- Next steps may only point at members of this group.
  select coalesce(jsonb_agg(case when s ? 'memberId' and not exists (
             select 1 from public.members m where m.id = s->>'memberId' and m.group_id = new.group_id)
           then s - 'memberId' else s end order by ord), '[]'::jsonb)
    into clean from jsonb_array_elements(new.next_steps) with ordinality as t(s, ord);
  new.next_steps := clean;
  return new;
end $$;
drop trigger if exists meeting_notes_guard on public.meeting_notes;
create trigger meeting_notes_guard before insert or update on public.meeting_notes
  for each row execute function public.tg_meeting_notes_guard();

drop trigger if exists touch_updated_at on public.meeting_notes;
create trigger touch_updated_at before update on public.meeting_notes
  for each row execute function public.tg_touch_updated_at();
drop trigger if exists group_activity on public.meeting_notes;
create trigger group_activity after insert or update or delete on public.meeting_notes
  for each row execute function public.tg_group_activity();

-- 3. Notifications ------------------------------------------------------------
-- Zoom note lands on a meeting (on arrival, or when an admin files an unmatched
-- one) -> everyone, push (email when there's no push). Unmatched -> admins.
create or replace function public.tg_notify_meeting_notes() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare mid text; t text; what text;
begin
  if public.is_seeding() or new.source <> 'zoom' then return null; end if;
  if new.meeting_id is null then
    if tg_op <> 'INSERT' then return null; end if;
    what := coalesce(nullif(new.zoom_topic, ''), 'A Zoom call')
      || case when new.zoom_start_at is not null then ' (' || public.fmt_central(new.zoom_start_at) || ')' else '' end;
    for mid in select id from public.members where group_id = new.group_id and role = 'admin' and removed_at is null loop
      perform public.enqueue_notification(mid, 'notes_unmatched', 'event', array['push', 'email'],
        'Zoom notes need a meeting', 'Zoom notes arrived but didn''t match a meeting: ' || what || '. Open Meetings to file them.',
        '#/meetings', null, new.id, null, now(), 'notes_unmatched:' || new.id || ':' || mid);
    end loop;
    return null;
  end if;
  if tg_op = 'UPDATE' and old.meeting_id is not distinct from new.meeting_id then return null; end if;
  select title into t from public.meetings where id = new.meeting_id;
  for mid in select public.group_member_ids(new.group_id) loop
    perform public.enqueue_notification(mid, 'notes_ready', 'event', array['push'],
      'Meeting notes', 'Notes from ' || coalesce(t, 'the meeting') || ' are in', '#/meetings/' || new.meeting_id || '/notes',
      'meeting', new.meeting_id, null, now(), 'notes_ready:' || new.meeting_id || ':' || mid);
  end loop;
  return null;
end $$;
drop trigger if exists notify_meeting_notes on public.meeting_notes;
create trigger notify_meeting_notes after insert or update of meeting_id on public.meeting_notes
  for each row execute function public.tg_notify_meeting_notes();

-- 4. Zoom ingest (service role only) ---------------------------------------------
-- A next step that starts with a member's name ("Corey Claflin will...", "Faith:
-- ...") is assigned to them. First names only count when they're unique in the group.
create or replace function public.note_step_member(p_group text, p_text text) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  with ms as (
    select id, lower(name) as full_, lower(split_part(name, ' ', 1)) as first_
    from public.members where group_id = p_group and removed_at is null
  ), hit as (
    select id, 1 as rank, length(full_) as len from ms
      where lower(btrim(p_text)) ~ ('^' || regexp_replace(full_, '([^[:alnum:] ])', '\\\1', 'g') || '\M')
    union all
    select id, 2, length(first_) from ms m
      where lower(btrim(p_text)) ~ ('^' || regexp_replace(first_, '([^[:alnum:]])', '\\\1', 'g') || '\M')
        and (select count(*) from ms x where x.first_ = m.first_) = 1
  )
  select id from hit order by rank, len desc limit 1
$$;

-- p: { zoomMeetingId, uuid, topic, startTime, endTime, title, summary,
--      keyPoints: [string], nextSteps: [string], raw }
-- Returns { status: 'matched' | 'unmatched' | 'ignored', groupId?, meetingId?, noteId?, updated? }.
-- ignored = the Zoom meeting belongs to no group (any other call Corey hosts).
create or replace function public.ingest_zoom_summary(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  zid   text := nullif(regexp_replace(coalesce(p->>'zoomMeetingId', ''), '[^0-9]', '', 'g'), '');
  st    timestamptz := nullif(p->>'startTime', '')::timestamptz;
  g     text;
  mt    public.meetings;
  ex    public.meeting_notes;
  steps jsonb;
  pts   jsonb;
  ttl   text;
  n     public.meeting_notes;
begin
  if zid is null then return jsonb_build_object('status', 'ignored', 'reason', 'no meeting id'); end if;
  select group_id into g from public.group_settings where zoom_meeting_id = zid limit 1;
  if g is null then   -- a meeting that has its own Zoom link
    select group_id into g from public.meetings
      where location->>'type' = 'zoom' and public.zoom_meeting_id_from_url(location->>'url') = zid
      order by starts_at desc limit 1;
  end if;
  if g is null then return jsonb_build_object('status', 'ignored', 'reason', 'no group uses this Zoom meeting'); end if;

  if st is not null then
    select * into mt from public.meetings
      where group_id = g and cancelled_at is null and abs(extract(epoch from starts_at - st)) <= 6 * 3600
      order by abs(extract(epoch from starts_at - st)), starts_at limit 1;
  end if;

  select coalesce(jsonb_agg(to_jsonb(btrim(x)) order by o), '[]'::jsonb) into pts
    from jsonb_array_elements_text(coalesce(p->'keyPoints', '[]'::jsonb)) with ordinality as t(x, o) where btrim(x) <> '';
  select coalesce(jsonb_agg(jsonb_build_object('text', btrim(x))
           || coalesce(jsonb_build_object('memberId', public.note_step_member(g, x)), '{}'::jsonb) order by o), '[]'::jsonb)
    into steps
    from jsonb_array_elements_text(coalesce(p->'nextSteps', '[]'::jsonb)) with ordinality as t(x, o) where btrim(x) <> '';
  steps := (select coalesce(jsonb_agg(case when e->'memberId' = 'null'::jsonb then e - 'memberId' else e end), '[]'::jsonb)
            from jsonb_array_elements(steps) e);
  ttl := left(coalesce(nullif(btrim(p->>'title'), ''), case when mt.id is not null then mt.title || ' notes' end,
                       nullif(btrim(p->>'topic'), ''), 'Zoom meeting notes'), 200);

  -- The same Zoom instance again (Zoom retries, or a re-sent summary), else this meeting's Zoom note.
  if nullif(p->>'uuid', '') is not null then
    select * into ex from public.meeting_notes where group_id = g and zoom_uuid = p->>'uuid';
  end if;
  if ex.id is null and mt.id is not null then
    select * into ex from public.meeting_notes where meeting_id = mt.id and source = 'zoom';
  end if;

  if ex.id is not null then
    -- An admin's edits win over a re-sent summary; raw always takes the latest.
    update public.meeting_notes set
      -- file an unmatched note now, unless that meeting already has a Zoom note
      meeting_id = coalesce(ex.meeting_id, case when not exists (
        select 1 from public.meeting_notes o where o.meeting_id = mt.id and o.source = 'zoom' and o.id <> ex.id) then mt.id end),
      title = case when ex.edited_at is null then ttl else title end,
      summary = case when ex.edited_at is null then left(coalesce(p->>'summary', ''), 30000) else summary end,
      key_points = case when ex.edited_at is null then pts else key_points end,
      next_steps = case when ex.edited_at is null then steps else next_steps end,
      raw = p->'raw', zoom_uuid = coalesce(nullif(p->>'uuid', ''), zoom_uuid),
      zoom_topic = coalesce(nullif(p->>'topic', ''), zoom_topic), zoom_start_at = coalesce(st, zoom_start_at)
    where id = ex.id returning * into n;
  else
    insert into public.meeting_notes(group_id, meeting_id, source, title, summary, key_points, next_steps,
                                     raw, zoom_uuid, zoom_topic, zoom_start_at, created_by)
    values (g, mt.id, 'zoom', ttl, left(coalesce(p->>'summary', ''), 30000), pts, steps,
            p->'raw', nullif(p->>'uuid', ''), nullif(p->>'topic', ''), st, null)
    returning * into n;
  end if;
  return jsonb_build_object('status', case when n.meeting_id is null then 'unmatched' else 'matched' end,
    'groupId', g, 'meetingId', n.meeting_id, 'noteId', n.id, 'updated', ex.id is not null);
end $$;
comment on function public.ingest_zoom_summary(jsonb) is
  'Called by functions/zoom-webhook (service role). Matches a Zoom AI Companion summary to a group (group_settings.zoom_meeting_id, or a meeting''s own Zoom link) and to the group meeting starting within 6 hours, then upserts the meeting_notes row.';

-- 5. Privileges and policies ---------------------------------------------------
alter table public.meeting_notes enable row level security;
revoke all on public.meeting_notes from anon, authenticated;
grant select (id, group_id, meeting_id, source, title, summary, key_points, next_steps, zoom_topic, zoom_start_at,
              created_by, edited_by, edited_at, created_at, updated_at) on public.meeting_notes to anon;
grant insert (id, meeting_id, title, summary, key_points, next_steps) on public.meeting_notes to anon;
grant update (meeting_id, title, summary, key_points, next_steps) on public.meeting_notes to anon;
grant delete on public.meeting_notes to anon;

revoke all on function public.ingest_zoom_summary(jsonb) from public, anon, authenticated;
revoke all on function public.note_step_member(text, text) from public, anon, authenticated;
revoke all on function public.tg_meeting_notes_guard() from public, anon, authenticated;
revoke all on function public.tg_notify_meeting_notes() from public, anon, authenticated;
revoke all on function public.zoom_meeting_id_from_url(text) from public, anon, authenticated;
revoke all on function public.valid_note_lists(jsonb, jsonb) from public;
grant execute on function public.valid_note_lists(jsonb, jsonb) to anon;
grant execute on function public.set_group_location(jsonb) to anon;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on public.meeting_notes to service_role;
    grant execute on function public.ingest_zoom_summary(jsonb) to service_role;
    grant execute on function public.note_step_member(text, text) to service_role;
    grant execute on function public.zoom_meeting_id_from_url(text) to service_role;
    grant execute on function public.valid_note_lists(jsonb, jsonb) to service_role;
  end if;
end $$;

drop policy if exists mm_notes_select on public.meeting_notes;
create policy mm_notes_select on public.meeting_notes for select to anon
  using (group_id = (select public.current_group_id()) and (meeting_id is not null or (select public.is_admin())));
drop policy if exists mm_notes_insert on public.meeting_notes;
create policy mm_notes_insert on public.meeting_notes for insert to anon
  with check (group_id = (select public.current_group_id()) and (select public.is_admin()) and source = 'manual');
drop policy if exists mm_notes_update on public.meeting_notes;
create policy mm_notes_update on public.meeting_notes for update to anon
  using (group_id = (select public.current_group_id()) and (select public.is_admin()))
  with check (group_id = (select public.current_group_id()) and (select public.is_admin()));
drop policy if exists mm_notes_delete on public.meeting_notes;
create policy mm_notes_delete on public.meeting_notes for delete to anon
  using (group_id = (select public.current_group_id()) and (select public.is_admin()));
