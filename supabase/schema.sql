-- =====================================================================
-- Mastermind app: Supabase schema
-- One project serves both groups ("family" = The Shoreline,
-- "entrepreneur" = Flight Club). Every row carries group_id.
--
-- Run order: schema.sql -> policies.sql -> seed.sql (test data) -> cron.sql
-- Safe to re-run: everything is CREATE ... IF NOT EXISTS / CREATE OR REPLACE.
--
-- Identity without Supabase Auth: the browser sends its session token in
-- the `x-session-token` HTTP header. PostgREST copies request headers into
-- the `request.headers` setting for each request, so current_member_id()
-- (below) can hash the token and look it up in `sessions`. RLS policies in
-- policies.sql call it. See supabase/README.md, "How login works".
--
-- Integrity rule: child rows reference parents by (id, group_id), so a row
-- can never point at a meeting, member or post in another group.
-- =====================================================================

set check_function_bodies = on;
set client_min_messages = warning;

-- ---------------------------------------------------------------------
-- Groups and settings
-- ---------------------------------------------------------------------

create table if not exists public.groups (
  id          text primary key check (id ~ '^[a-z][a-z0-9_-]{1,30}$'),
  name        text not null,
  subtitle    text not null default '',
  tagline     text not null default '',
  timezone    text not null default 'America/Chicago',
  created_at  timestamptz not null default now()
);
comment on table public.groups is
  'One row per mastermind group (family = The Shoreline, entrepreneur = Flight Club). The id is the ?group= value in the app URL.';

create table if not exists public.group_settings (
  group_id             text primary key references public.groups(id) on delete cascade,
  branding             jsonb not null default '{}'::jsonb,   -- colors, logoText/logoMask/logoSvg, nextLabel, enterLabel, dedication
  verse                jsonb not null default '{}'::jsonb,   -- { short, full, ref }
  credit               jsonb not null default '{}'::jsonb,   -- { label, url }
  rules                jsonb not null default '[]'::jsonb check (jsonb_typeof(rules) = 'array'),
  rules_version        int   not null default 1,              -- bump when rules change; members re-agree
  location_default     jsonb not null,                        -- { type: zoom|inperson, label, url, address } from config
  location_override    jsonb,                                 -- admin's saved "usual place"; null = use location_default
  meeting_rule         jsonb not null,                        -- see comment below
  training_rule        jsonb,                                 -- same shape; null = group has no trainings
  agenda_template      jsonb not null default '[]'::jsonb check (jsonb_typeof(agenda_template) = 'array'),
  notification_options jsonb not null default '{}'::jsonb,   -- { oneHourReminder: bool }
  max_admins           int   not null default 2 check (max_admins between 1 and 5),
  realtime_key         text  not null default replace(gen_random_uuid()::text, '-', ''),
  updated_at           timestamptz not null default now()
);
comment on table public.group_settings is
  'Per-group settings: branding, verse, maker credit, ground rules, usual meeting place, meeting/training rules, agenda template, notification options. '
  'meeting_rule/training_rule shape: { "nth": 3, "weekday": 5 (ISO 1=Mon..7=Sun), "start": "07:00", "durationMinutes": 120, '
  '"titleTemplate": "{month} Flight Club", "location": null|{...} }. nth -1 = last. '
  'realtime_key names the content-free broadcast channel members listen on. The invite code is NOT here: see group_invites.';
comment on column public.group_settings.location_override is
  'Set by an admin in Profile > Meeting location. Null means use location_default. A meeting''s own location beats both.';

create table if not exists public.group_invites (
  id          bigint generated always as identity primary key,
  group_id    text not null references public.groups(id) on delete cascade,
  code_hash   text not null,               -- hex sha256 of group_id || ':' || upper(trim(code))
  code_hint   text not null default '',    -- last 2 characters, for admins ("ends in 26")
  created_at  timestamptz not null default now(),
  created_by  text,                        -- member id of the admin who rotated it (null for seed)
  revoked_at  timestamptz
);
create unique index if not exists group_invites_one_active
  on public.group_invites(group_id) where revoked_at is null;
comment on table public.group_invites is
  'Invite codes, hashed. Exactly one active (revoked_at is null) per group. Rotating inserts a new row and revokes the old one, so old codes stop working and the history is kept. '
  'Kept out of group_settings on purpose: members can read group_settings, nobody but the service role can read this table.';

-- ---------------------------------------------------------------------
-- Members and sessions
-- ---------------------------------------------------------------------

create or replace function public.valid_working_genius(wg jsonb) returns boolean
language sql immutable as $$
  select wg is null or (
    jsonb_typeof(wg) = 'object'
    and jsonb_typeof(wg->'geniuses') = 'array' and jsonb_array_length(wg->'geniuses') = 2
    and jsonb_typeof(wg->'competencies') = 'array' and jsonb_array_length(wg->'competencies') = 2
    and jsonb_typeof(wg->'frustrations') = 'array' and jsonb_array_length(wg->'frustrations') = 2
    and not exists (
      select 1 from jsonb_array_elements_text(wg->'geniuses' || (wg->'competencies') || (wg->'frustrations')) l
      where l not in ('W','I','D','G','E','T'))
    and (select count(distinct l) from jsonb_array_elements_text(wg->'geniuses' || (wg->'competencies') || (wg->'frustrations')) l) = 6
  )
$$;
comment on function public.valid_working_genius(jsonb) is
  'Working Genius result: two letters each of geniuses, competencies, frustrations; all six of W I D G E T used once.';

create table if not exists public.members (
  id              text primary key default gen_random_uuid()::text,
  group_id        text not null references public.groups(id) on delete cascade,
  name            text not null check (length(btrim(name)) between 1 and 80),
  role            text not null default 'member' check (role in ('member','admin')),
  bio             text not null default '',
  focus           text not null default '',
  can_help_with   text[] not null default '{}',
  working_genius  jsonb check (public.valid_working_genius(working_genius)),
  sort_order      int  not null default 100,       -- roster and hot seat rotation order
  joined_at       timestamptz not null default now(),
  removed_at      timestamptz,                     -- soft delete: history (commitments, comments) is kept
  removed_by      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (id, group_id)
);
create index if not exists members_group_idx on public.members(group_id, sort_order) where removed_at is null;
comment on table public.members is
  'Roster. role admin|member, at most group_settings.max_admins (2) active admins per group. Removing a member sets removed_at (soft delete) and revokes their sessions; their history stays.';

create table if not exists public.member_contacts (
  member_id   text primary key,
  group_id    text not null,          -- default set below, after current_group_id() exists
  email       text check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone       text check (phone is null or phone ~ '^\+[1-9][0-9]{7,14}$'),  -- E.164, e.g. +15125550123
  updated_at  timestamptz not null default now(),
  foreign key (member_id, group_id) references public.members(id, group_id) on delete cascade
);
comment on table public.member_contacts is
  'Email and mobile number for reminders. Separate from members so RLS can show them only to the member and admins (members can read each other''s profile, not contact details).';

create table if not exists public.sessions (
  id            uuid primary key default gen_random_uuid(),
  member_id     text not null,
  group_id      text not null,
  token_hash    text not null unique,           -- hex sha256 of the token; the token itself is never stored
  device_label  text not null default '',
  user_agent    text not null default '',
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  revoked_at    timestamptz,
  foreign key (member_id, group_id) references public.members(id, group_id) on delete cascade
);
create index if not exists sessions_member_idx on public.sessions(member_id) where revoked_at is null;
comment on table public.sessions is
  'One row per signed-in device. Created by the join Edge Function after invite code + name pick. The browser keeps the random token and sends it as x-session-token. No RLS policies: only SECURITY DEFINER functions and the service role touch it.';

create table if not exists public.join_attempts (
  id          bigint generated always as identity primary key,
  group_id    text,
  ip_hash     text not null,
  ok          boolean not null,
  created_at  timestamptz not null default now()
);
create index if not exists join_attempts_ip_idx on public.join_attempts(ip_hash, created_at desc);
comment on table public.join_attempts is
  'Invite-code attempts, for rate limiting the join function (10 failures per IP per 15 minutes). IPs are stored hashed. Service role only.';

-- ---------------------------------------------------------------------
-- Who is calling? (used by RLS, column defaults and RPCs)
-- ---------------------------------------------------------------------

create or replace function public.request_session_token() returns text
language sql stable as $$
  select nullif(nullif(current_setting('request.headers', true), '')::json ->> 'x-session-token', '')
$$;
comment on function public.request_session_token() is
  'The x-session-token header of the current PostgREST request, or null.';

create or replace function public.hash_token(token text) returns text
language sql immutable as $$
  select encode(sha256(convert_to(token, 'UTF8')), 'hex')
$$;

create or replace function public.hash_invite_code(p_group text, p_code text) returns text
language sql immutable as $$
  select encode(sha256(convert_to(p_group || ':' || upper(btrim(p_code)), 'UTF8')), 'hex')
$$;
comment on function public.hash_invite_code(text, text) is
  'Must match inviteHash() in functions/_shared/crypto.ts.';

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

create or replace function public.current_member() returns public.members
language sql stable security definer set search_path = public, pg_temp as $$
  select m.* from public.members m where m.id = public.current_member_id()
$$;
comment on function public.current_member() is 'The calling member''s members row, or null.';

create or replace function public.current_group_id() returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select m.group_id from public.members m where m.id = public.current_member_id()
$$;
comment on function public.current_group_id() is 'Group of the calling member. Also the default for group_id on insert, so the app never sends it.';

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select m.role = 'admin' from public.members m where m.id = public.current_member_id()), false)
$$;
comment on function public.is_admin() is 'True when the caller is an admin of their group.';

alter table public.member_contacts alter column group_id set default public.current_group_id();

-- ---------------------------------------------------------------------
-- Ground rules
-- ---------------------------------------------------------------------

create table if not exists public.rules_acceptances (
  member_id      text not null,
  group_id       text not null default public.current_group_id(),
  rules_version  int  not null,
  accepted_at    timestamptz not null default now(),
  primary key (member_id, rules_version),
  foreign key (member_id, group_id) references public.members(id, group_id) on delete cascade
);
comment on table public.rules_acceptances is
  'Who agreed to which version of the group''s ground rules. The app asks again when group_settings.rules_version goes up.';

-- ---------------------------------------------------------------------
-- Meetings
-- ---------------------------------------------------------------------

create table if not exists public.meetings (
  id                  text primary key default gen_random_uuid()::text,
  group_id            text not null default public.current_group_id() references public.groups(id) on delete cascade,
  starts_at           timestamptz not null,
  duration_minutes    int not null default 60 check (duration_minutes between 15 and 600),
  title               text not null,
  location            jsonb,           -- null = group default; else { type, label, url, address }
  agenda              jsonb not null default '[]'::jsonb check (jsonb_typeof(agenda) = 'array'),  -- [{ time, item, owner }]
  hot_seat_member_id  text,
  hot_seat_prep       jsonb,           -- { problem, context, whatTried, winLooksLike, submittedAt, editedAt? }
  action_plan         jsonb,           -- { adviceTaken[2-5], nextStep, deadline, goalId, savedAt }
  notes               text not null default '',
  source_key          text,            -- 'rule:YYYY-MM' for the monthly meeting (generated or seeded); null for extra meetings
  manual_time         boolean not null default false,  -- admin moved it; generate-meetings will not re-time it
  cancelled_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (id, group_id),
  unique (group_id, source_key),
  foreign key (hot_seat_member_id, group_id) references public.members(id, group_id),
  check (location is null or (location->>'type') in ('zoom','inperson'))
);
create index if not exists meetings_group_time_idx on public.meetings(group_id, starts_at);
comment on table public.meetings is
  'Monthly mastermind meetings. generate-meetings creates the next 12 months from group_settings.meeting_rule (source_key makes it idempotent). Admins edit agenda, time, place and hot seat; the hot seat person saves prep and action plan through RPCs.';

create table if not exists public.meeting_rsvps (
  meeting_id  text not null,
  member_id   text not null default public.current_member_id(),
  group_id    text not null default public.current_group_id(),
  status      text not null check (status in ('yes','no','maybe')),
  updated_at  timestamptz not null default now(),
  primary key (meeting_id, member_id),
  foreign key (meeting_id, group_id) references public.meetings(id, group_id) on delete cascade,
  foreign key (member_id, group_id) references public.members(id, group_id) on delete cascade
);
comment on table public.meeting_rsvps is 'Going? yes/no/maybe, one per member per meeting.';

create table if not exists public.meeting_attendance (
  meeting_id  text not null,
  member_id   text not null,
  group_id    text not null default public.current_group_id(),
  marked_by   text default public.current_member_id(),
  marked_at   timestamptz not null default now(),
  primary key (meeting_id, member_id),
  foreign key (meeting_id, group_id) references public.meetings(id, group_id) on delete cascade,
  foreign key (member_id, group_id) references public.members(id, group_id) on delete cascade
);
comment on table public.meeting_attendance is 'Who attended a past meeting. Admins mark it.';

-- ---------------------------------------------------------------------
-- Trainings (Flight Club only today; any group with a training_rule)
-- ---------------------------------------------------------------------

create table if not exists public.trainings (
  id                text primary key default gen_random_uuid()::text,
  group_id          text not null default public.current_group_id() references public.groups(id) on delete cascade,
  starts_at         timestamptz not null,
  duration_minutes  int not null default 60 check (duration_minutes between 15 and 600),
  topic             text not null default '',
  description       text not null default '',
  video_url         text check (video_url is null or video_url ~* '^https?://'),     -- where to join
  recording_url     text check (recording_url is null or recording_url ~* '^https?://'),
  source_key        text,
  manual_time       boolean not null default false,
  cancelled_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (id, group_id),
  unique (group_id, source_key)
);
create index if not exists trainings_group_time_idx on public.trainings(group_id, starts_at);
comment on table public.trainings is
  'Video trainings (Flight Club: 3rd Wednesday 12:00 CT). Generated from group_settings.training_rule; an admin sets topic, description, join and recording links.';

create table if not exists public.training_rsvps (
  training_id  text not null,
  member_id    text not null default public.current_member_id(),
  group_id     text not null default public.current_group_id(),
  status       text not null check (status in ('yes','no','maybe')),
  updated_at   timestamptz not null default now(),
  primary key (training_id, member_id),
  foreign key (training_id, group_id) references public.trainings(id, group_id) on delete cascade,
  foreign key (member_id, group_id) references public.members(id, group_id) on delete cascade
);
comment on table public.training_rsvps is 'RSVPs for trainings.';

-- ---------------------------------------------------------------------
-- Get-togethers
-- ---------------------------------------------------------------------

create table if not exists public.get_togethers (
  id          text primary key default gen_random_uuid()::text,
  group_id    text not null default public.current_group_id() references public.groups(id) on delete cascade,
  host_id     text not null default public.current_member_id(),
  title       text not null check (length(btrim(title)) between 1 and 120),
  kind        text not null default 'other' check (kind in ('coffee','lunch','dinner','visit','other')),
  starts_at   timestamptz not null,
  location    text not null default '',
  note        text not null default '',
  visibility  text not null default 'open' check (visibility in ('open','closed')),
  cancelled   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (id, group_id),
  foreign key (host_id, group_id) references public.members(id, group_id) on delete cascade
);
create index if not exists get_togethers_group_time_idx on public.get_togethers(group_id, starts_at);
comment on table public.get_togethers is
  'Coffees, lunches, visits. Anyone hosts. Open = whole group sees it; closed = only host, invitees and admins (enforced by RLS, not the screen).';

create table if not exists public.get_together_invitees (
  get_together_id  text not null,
  member_id        text not null,
  group_id         text not null default public.current_group_id(),
  invited_at       timestamptz not null default now(),
  primary key (get_together_id, member_id),
  foreign key (get_together_id, group_id) references public.get_togethers(id, group_id) on delete cascade,
  foreign key (member_id, group_id) references public.members(id, group_id) on delete cascade
);
comment on table public.get_together_invitees is 'Invitees of a closed get-together.';

create table if not exists public.get_together_rsvps (
  get_together_id  text not null,
  member_id        text not null default public.current_member_id(),
  group_id         text not null default public.current_group_id(),
  status           text not null check (status in ('yes','no','maybe')),
  updated_at       timestamptz not null default now(),
  primary key (get_together_id, member_id),
  foreign key (get_together_id, group_id) references public.get_togethers(id, group_id) on delete cascade,
  foreign key (member_id, group_id) references public.members(id, group_id) on delete cascade
);
comment on table public.get_together_rsvps is 'RSVPs for get-togethers. The host starts as yes.';

-- ---------------------------------------------------------------------
-- Accountability: goals, commitments, check-ins
-- ---------------------------------------------------------------------

create table if not exists public.goals (
  id                  text primary key default gen_random_uuid()::text,
  group_id            text not null default public.current_group_id() references public.groups(id) on delete cascade,
  member_id           text not null default public.current_member_id(),
  period              text not null default '',          -- "Q4 2026", "2027"
  title               text not null check (length(btrim(title)) between 1 and 200),
  why                 text not null default '',
  target_date         date,
  status              text not null default 'active' check (status in ('active','done','paused')),
  accountability_ask  text not null default '',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (id, group_id),
  foreign key (member_id, group_id) references public.members(id, group_id) on delete cascade
);
create index if not exists goals_member_idx on public.goals(group_id, member_id);
comment on table public.goals is 'Longer-range goals (quarter or year). Commitments can point at one.';

create table if not exists public.commitments (
  id                text primary key default gen_random_uuid()::text,
  group_id          text not null default public.current_group_id() references public.groups(id) on delete cascade,
  member_id         text not null default public.current_member_id(),
  meeting_id        text not null,
  text              text not null check (length(btrim(text)) between 1 and 500),
  status            text not null default 'not_started' check (status in ('not_started','in_progress','done')),
  last_update_note  text not null default '',
  goal_id           text,
  done_at           timestamptz,           -- set by trigger when status becomes done
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (meeting_id, member_id),
  foreign key (member_id, group_id) references public.members(id, group_id) on delete cascade,
  foreign key (meeting_id, group_id) references public.meetings(id, group_id) on delete cascade,
  foreign key (goal_id, group_id) references public.goals(id, group_id) on delete set null (goal_id)
);
create index if not exists commitments_group_idx on public.commitments(group_id, meeting_id);
comment on table public.commitments is
  'One commitment per member per meeting (made at that meeting). Scoreboard: kept if done_at is before the next meeting starts.';

create table if not exists public.checkins (
  id            text primary key default gen_random_uuid()::text,
  group_id      text not null default public.current_group_id(),
  meeting_id    text not null,
  member_id     text not null default public.current_member_id(),
  win           text not null default '',
  challenge     text not null default '',
  submitted_at  timestamptz not null default now(),
  edited_at     timestamptz,
  unique (meeting_id, member_id),
  foreign key (meeting_id, group_id) references public.meetings(id, group_id) on delete cascade,
  foreign key (member_id, group_id) references public.members(id, group_id) on delete cascade
);
create index if not exists checkins_group_idx on public.checkins(group_id, meeting_id);
comment on table public.checkins is 'Pre-meeting check-in: a win and a challenge. Due when the meeting starts.';

-- ---------------------------------------------------------------------
-- Asks
-- ---------------------------------------------------------------------

create table if not exists public.asks (
  id           text primary key default gen_random_uuid()::text,
  group_id     text not null default public.current_group_id() references public.groups(id) on delete cascade,
  member_id    text not null default public.current_member_id(),
  title        text not null check (length(btrim(title)) between 1 and 200),
  detail       text not null default '',
  needs        text check (needs is null or needs in ('starting','deciding','finishing','hands','exploring')),
  status       text not null default 'open' check (status in ('open','resolved')),
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz,
  unique (id, group_id),
  foreign key (member_id, group_id) references public.members(id, group_id) on delete cascade
);
create index if not exists asks_group_idx on public.asks(group_id, created_at desc);
comment on table public.asks is 'Requests for help. needs maps to Working Genius (starting -> G/I, deciding -> D, finishing -> T, hands -> E, exploring -> W).';

create table if not exists public.ask_replies (
  id          text primary key default gen_random_uuid()::text,
  ask_id      text not null,
  group_id    text not null default public.current_group_id(),
  member_id   text not null default public.current_member_id(),
  text        text not null check (length(btrim(text)) between 1 and 2000),
  can_help    boolean not null default false,   -- "I can help"
  created_at  timestamptz not null default now(),
  foreign key (ask_id, group_id) references public.asks(id, group_id) on delete cascade,
  foreign key (member_id, group_id) references public.members(id, group_id) on delete cascade
);
create index if not exists ask_replies_ask_idx on public.ask_replies(ask_id, created_at);
comment on table public.ask_replies is 'Replies on an ask. can_help = the "I can help" button (notifies the asker).';

-- ---------------------------------------------------------------------
-- Announcements
-- ---------------------------------------------------------------------

create table if not exists public.announcements (
  id          text primary key default gen_random_uuid()::text,
  group_id    text not null default public.current_group_id() references public.groups(id) on delete cascade,
  author_id   text not null default public.current_member_id(),
  title       text not null check (length(btrim(title)) between 1 and 200),
  body        text not null default '',
  pinned      boolean not null default false,   -- admin only
  important   boolean not null default false,   -- admin only; also emails everyone
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (id, group_id),
  foreign key (author_id, group_id) references public.members(id, group_id) on delete cascade
);
create index if not exists announcements_group_idx on public.announcements(group_id, pinned desc, created_at desc);
comment on table public.announcements is 'Group announcements. Anyone posts; admins pin or mark important (important also emails).';

create table if not exists public.announcement_comments (
  id               text primary key default gen_random_uuid()::text,
  announcement_id  text not null,
  group_id         text not null default public.current_group_id(),
  member_id        text not null default public.current_member_id(),
  text             text not null check (length(btrim(text)) between 1 and 2000),
  created_at       timestamptz not null default now(),
  foreign key (announcement_id, group_id) references public.announcements(id, group_id) on delete cascade,
  foreign key (member_id, group_id) references public.members(id, group_id) on delete cascade
);
create index if not exists announcement_comments_idx on public.announcement_comments(announcement_id, created_at);
comment on table public.announcement_comments is 'Comments on announcements.';

-- ---------------------------------------------------------------------
-- Ideas and resources
-- ---------------------------------------------------------------------

create table if not exists public.ideas (
  id          text primary key default gen_random_uuid()::text,
  group_id    text not null default public.current_group_id() references public.groups(id) on delete cascade,
  member_id   text not null default public.current_member_id(),
  type        text not null default 'idea' check (type in ('idea','link','tool','article','podcast','other')),
  title       text not null check (length(btrim(title)) between 1 and 200),
  note        text not null default '',
  url         text not null default '' check (url = '' or url ~* '^https?://'),
  created_at  timestamptz not null default now(),
  unique (id, group_id),
  foreign key (member_id, group_id) references public.members(id, group_id) on delete cascade
);
create index if not exists ideas_group_idx on public.ideas(group_id, created_at desc);
comment on table public.ideas is 'Idea and resource board: ideas, links, tools, articles, podcasts.';

create table if not exists public.idea_likes (
  idea_id     text not null,
  member_id   text not null default public.current_member_id(),
  group_id    text not null default public.current_group_id(),
  created_at  timestamptz not null default now(),
  primary key (idea_id, member_id),
  foreign key (idea_id, group_id) references public.ideas(id, group_id) on delete cascade,
  foreign key (member_id, group_id) references public.members(id, group_id) on delete cascade
);
comment on table public.idea_likes is 'One like per member per idea.';

create table if not exists public.idea_comments (
  id          text primary key default gen_random_uuid()::text,
  idea_id     text not null,
  group_id    text not null default public.current_group_id(),
  member_id   text not null default public.current_member_id(),
  text        text not null check (length(btrim(text)) between 1 and 2000),
  created_at  timestamptz not null default now(),
  foreign key (idea_id, group_id) references public.ideas(id, group_id) on delete cascade,
  foreign key (member_id, group_id) references public.members(id, group_id) on delete cascade
);
create index if not exists idea_comments_idx on public.idea_comments(idea_id, created_at);
comment on table public.idea_comments is 'Comments on ideas.';

-- ---------------------------------------------------------------------
-- Books
-- ---------------------------------------------------------------------

create table if not exists public.books (
  id            text primary key default gen_random_uuid()::text,
  group_id      text not null default public.current_group_id() references public.groups(id) on delete cascade,
  title         text not null check (length(btrim(title)) between 1 and 200),
  author        text not null default '',
  suggested_by  text not null default public.current_member_id(),
  why           text not null default '',
  group_book    boolean not null default false,   -- admin only, at most one per group
  created_at    timestamptz not null default now(),
  unique (id, group_id),
  foreign key (suggested_by, group_id) references public.members(id, group_id) on delete cascade
);
create unique index if not exists books_one_group_book on public.books(group_id) where group_book;
comment on table public.books is 'Book list. One book at a time can be the group book (set by an admin).';

create table if not exists public.book_comments (
  id          text primary key default gen_random_uuid()::text,
  book_id     text not null,
  group_id    text not null default public.current_group_id(),
  member_id   text not null default public.current_member_id(),
  text        text not null check (length(btrim(text)) between 1 and 2000),
  created_at  timestamptz not null default now(),
  foreign key (book_id, group_id) references public.books(id, group_id) on delete cascade,
  foreign key (member_id, group_id) references public.members(id, group_id) on delete cascade
);
create index if not exists book_comments_idx on public.book_comments(book_id, created_at);
comment on table public.book_comments is 'Comments on books.';

create table if not exists public.reading_list (
  book_id     text not null,
  member_id   text not null default public.current_member_id(),
  group_id    text not null default public.current_group_id(),
  status      text not null check (status in ('want','reading','finished')),
  updated_at  timestamptz not null default now(),
  primary key (book_id, member_id),
  foreign key (book_id, group_id) references public.books(id, group_id) on delete cascade,
  foreign key (member_id, group_id) references public.members(id, group_id) on delete cascade
);
comment on table public.reading_list is 'Each member''s status per book (want, reading, finished). No row = not on their list.';

-- ---------------------------------------------------------------------
-- Notifications (spec: supabase/NOTIFICATIONS.md)
-- ---------------------------------------------------------------------

create table if not exists public.notification_prefs (
  member_id   text primary key,
  group_id    text not null,
  sms         boolean not null default true,
  email       boolean not null default true,
  nudges      boolean not null default true,
  updated_at  timestamptz not null default now(),
  foreign key (member_id, group_id) references public.members(id, group_id) on delete cascade
);
comment on table public.notification_prefs is
  'Per-member toggles. Meeting reminders cannot be turned off: if a toggle removes every channel for one, it falls back to push or email. nudges=false drops nudges entirely.';

create table if not exists public.push_subscriptions (
  id               uuid primary key default gen_random_uuid(),
  member_id        text not null default public.current_member_id(),
  group_id         text not null default public.current_group_id(),
  endpoint         text not null unique check (endpoint ~ '^https://'),
  p256dh           text not null,
  auth             text not null,
  user_agent       text not null default '',
  created_at       timestamptz not null default now(),
  last_success_at  timestamptz,
  disabled_at      timestamptz,          -- set when the push service says 404/410
  foreign key (member_id, group_id) references public.members(id, group_id) on delete cascade
);
create index if not exists push_subscriptions_member_idx on public.push_subscriptions(member_id) where disabled_at is null;
comment on table public.push_subscriptions is 'Web push subscriptions (one per device/browser). Sent with VAPID by send-notifications.';

create table if not exists public.notification_queue (
  id             bigint generated always as identity primary key,
  group_id       text not null references public.groups(id) on delete cascade,
  member_id      text not null,
  kind           text not null,                      -- e.g. meeting_24h, announcement_new (see NOTIFICATIONS.md)
  category       text not null check (category in ('meeting','nudge','event','digest','other')),
  channel        text not null check (channel in ('email','sms','push')),
  dedupe_key     text not null unique,               -- kind:ref:member[:starts_at]:channel
  subject        text not null default '',
  body           text not null,
  url            text not null default '',           -- app hash route, e.g. #/meetings/f-2026-11
  ref_type       text check (ref_type in ('meeting','training','get_together','announcement','ask','idea','book','commitment')),
  ref_id         text,
  ref_starts_at  timestamptz,                        -- event start when queued; skipped if the event moved
  send_after     timestamptz not null default now(), -- already moved out of quiet hours
  status         text not null default 'pending' check (status in ('pending','sending','sent','failed','skipped')),
  attempts       int not null default 0,
  last_error     text,
  locked_at      timestamptz,
  created_at     timestamptz not null default now(),
  sent_at        timestamptz,
  foreign key (member_id, group_id) references public.members(id, group_id) on delete cascade
);
create index if not exists notification_queue_due_idx on public.notification_queue(send_after) where status = 'pending';
create index if not exists notification_queue_member_idx on public.notification_queue(member_id, channel, status);
comment on table public.notification_queue is
  'Outgoing reminders, one row per member per channel. Filled by schedule-notifications (hourly) and by database triggers (event-driven); drained by send-notifications every 5 minutes. dedupe_key makes enqueueing idempotent.';

create table if not exists public.notification_log (
  id           bigint generated always as identity primary key,
  queue_id     bigint references public.notification_queue(id) on delete set null,
  group_id     text not null,
  member_id    text not null,
  kind         text not null,
  category     text not null,
  channel      text not null,
  dedupe_key   text not null,
  status       text not null check (status in ('sent','failed','skipped')),
  provider_id  text,          -- Resend email id, RingCentral message id, push endpoint host
  error        text,
  bundle_size  int not null default 1,
  created_at   timestamptz not null default now()
);
create index if not exists notification_log_member_idx on public.notification_log(member_id, channel, created_at desc);
comment on table public.notification_log is 'Audit of every send attempt outcome. Also used to bundle event pushes (one per member per hour).';

-- ---------------------------------------------------------------------
-- Change feed for realtime / polling
-- ---------------------------------------------------------------------

create table if not exists public.group_activity (
  group_id    text not null references public.groups(id) on delete cascade,
  table_name  text not null,
  changed_at  timestamptz not null default now(),
  primary key (group_id, table_name)
);
comment on table public.group_activity is
  'Last change time per group per table. The app polls it (one tiny request) when Realtime is unavailable, and refetches only the tables that changed.';

-- =====================================================================
-- Triggers
-- =====================================================================

create or replace function public.is_seeding() returns boolean
language sql stable as $$ select coalesce(current_setting('mm.seeding', true), '') = 'on' $$;
comment on function public.is_seeding() is 'seed.sql sets mm.seeding=on so triggers do not queue notifications for sample data.';

create or replace function public.tg_touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['members','group_settings','meetings','trainings','get_togethers','goals',
                           'commitments','announcements','member_contacts','notification_prefs',
                           'meeting_rsvps','training_rsvps','get_together_rsvps','reading_list']
  loop
    execute format('drop trigger if exists touch_updated_at on public.%I', t);
    execute format('create trigger touch_updated_at before update on public.%I for each row execute function public.tg_touch_updated_at()', t);
  end loop;
end $$;

-- Commitment done_at follows status.
create or replace function public.tg_commitment_done_at() returns trigger
language plpgsql as $$
begin
  if new.status = 'done' and (tg_op = 'INSERT' or old.status is distinct from 'done') then
    new.done_at := coalesce(new.done_at, now());
  elsif new.status <> 'done' then
    new.done_at := null;
  end if;
  return new;
end $$;
drop trigger if exists commitment_done_at on public.commitments;
create trigger commitment_done_at before insert or update of status on public.commitments
  for each row execute function public.tg_commitment_done_at();

create or replace function public.tg_checkin_edited() returns trigger
language plpgsql as $$
begin
  new.edited_at := now();
  new.submitted_at := old.submitted_at;
  return new;
end $$;
drop trigger if exists checkin_edited on public.checkins;
create trigger checkin_edited before update on public.checkins
  for each row execute function public.tg_checkin_edited();

create or replace function public.tg_ask_resolved() returns trigger
language plpgsql as $$
begin
  if new.status = 'resolved' and old.status <> 'resolved' then new.resolved_at := now();
  elsif new.status = 'open' then new.resolved_at := null; end if;
  return new;
end $$;
drop trigger if exists ask_resolved on public.asks;
create trigger ask_resolved before update of status on public.asks
  for each row execute function public.tg_ask_resolved();

-- At most max_admins active admins per group.
create or replace function public.tg_members_admin_limit() returns trigger
language plpgsql as $$
declare n int; lim int;
begin
  if new.role = 'admin' and new.removed_at is null then
    select max_admins into lim from public.group_settings where group_id = new.group_id;
    select count(*) into n from public.members
      where group_id = new.group_id and role = 'admin' and removed_at is null and id <> new.id;
    if n >= coalesce(lim, 2) then
      raise exception 'This group already has % admins', coalesce(lim, 2) using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists members_admin_limit on public.members;
create trigger members_admin_limit before insert or update of role, removed_at on public.members
  for each row execute function public.tg_members_admin_limit();

-- Every member gets a prefs row.
create or replace function public.tg_members_prefs() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.notification_prefs(member_id, group_id) values (new.id, new.group_id)
  on conflict (member_id) do nothing;
  return new;
end $$;
drop trigger if exists members_prefs on public.members;
create trigger members_prefs after insert on public.members
  for each row execute function public.tg_members_prefs();

-- Admin-only fields on announcements and books. Only enforced on member
-- requests (current_member_id() not null); the service role is trusted.
create or replace function public.tg_guard_admin_fields() returns trigger
language plpgsql as $$
begin
  if public.current_member_id() is null or public.is_admin() then return new; end if;
  if tg_table_name = 'announcements' then
    if (tg_op = 'INSERT' and (new.pinned or new.important))
       or (tg_op = 'UPDATE' and (new.pinned is distinct from old.pinned or new.important is distinct from old.important)) then
      raise exception 'Only an admin can pin or mark an announcement important' using errcode = 'insufficient_privilege';
    end if;
  elsif tg_table_name = 'books' then
    if (tg_op = 'INSERT' and new.group_book) or (tg_op = 'UPDATE' and new.group_book is distinct from old.group_book) then
      raise exception 'Only an admin can set the group book' using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists guard_admin_fields on public.announcements;
create trigger guard_admin_fields before insert or update on public.announcements
  for each row execute function public.tg_guard_admin_fields();
drop trigger if exists guard_admin_fields on public.books;
create trigger guard_admin_fields before insert or update on public.books
  for each row execute function public.tg_guard_admin_fields();

-- Meetings and trainings: a time change by a person marks manual_time.
create or replace function public.tg_event_manual_time() returns trigger
language plpgsql as $$
begin
  if new.starts_at is distinct from old.starts_at and public.current_member_id() is not null then
    new.manual_time := true;
  end if;
  return new;
end $$;
drop trigger if exists event_manual_time on public.meetings;
create trigger event_manual_time before update of starts_at on public.meetings
  for each row execute function public.tg_event_manual_time();
drop trigger if exists event_manual_time on public.trainings;
create trigger event_manual_time before update of starts_at on public.trainings
  for each row execute function public.tg_event_manual_time();

-- Change feed: bump group_activity and send a content-free Realtime broadcast.
create or replace function public.tg_group_activity() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare g text; k text;
begin
  if public.is_seeding() then return null; end if;
  g := case when tg_op = 'DELETE' then old.group_id else new.group_id end;
  insert into public.group_activity(group_id, table_name, changed_at) values (g, tg_table_name, now())
  on conflict (group_id, table_name) do update set changed_at = excluded.changed_at;
  -- realtime.send exists on Supabase only. Payload carries the table name, never row data.
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is not null then
    select realtime_key into k from public.group_settings where group_id = g;
    if k is not null then
      begin
        execute 'select realtime.send($1, $2, $3, false)'
          using jsonb_build_object('table', tg_table_name), 'change', 'mm-' || k;
      exception when others then null;  -- never fail a write because of realtime
      end;
    end if;
  end if;
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array['members','group_settings','meetings','meeting_rsvps','meeting_attendance',
                           'trainings','training_rsvps','get_togethers','get_together_invitees','get_together_rsvps',
                           'goals','commitments','checkins','asks','ask_replies','announcements',
                           'announcement_comments','ideas','idea_likes','idea_comments','books',
                           'book_comments','reading_list']
  loop
    execute format('drop trigger if exists group_activity on public.%I', t);
    execute format('create trigger group_activity after insert or update or delete on public.%I for each row execute function public.tg_group_activity()', t);
  end loop;
end $$;

-- =====================================================================
-- Notification helpers (used by triggers and by schedule-notifications)
-- =====================================================================

-- 9 PM - 7 AM Central is quiet. Returns the time a message may go out.
-- For a reminder about an event, if 7 AM would be after the event starts,
-- send at 8:30 PM the evening before instead.
create or replace function public.adjust_for_quiet_hours(p_at timestamptz, p_event_start timestamptz default null)
returns timestamptz language plpgsql stable as $$
declare
  tz constant text := 'America/Chicago';
  local_ts timestamp := p_at at time zone tz;
  h int := extract(hour from local_ts);
  next7 timestamptz;
begin
  if h >= 7 and h < 21 then return p_at; end if;
  if h >= 21 then next7 := ((local_ts::date + 1) + time '07:00') at time zone tz;
  else            next7 := (local_ts::date + time '07:00') at time zone tz; end if;
  if p_event_start is not null and next7 >= p_event_start then
    -- 8:30 PM on the local evening before (or of) p_at
    return greatest(now(), ((case when h >= 21 then local_ts::date else local_ts::date - 1 end) + time '20:30') at time zone tz);
  end if;
  return next7;
end $$;
comment on function public.adjust_for_quiet_hours(timestamptz, timestamptz) is
  'Quiet hours 9 PM - 7 AM Central: moves a send time to 7 AM, or to 8:30 PM the evening before if 7 AM would be after the event.';

-- Kinds allowed to use SMS (NOTIFICATIONS.md, "SMS only for").
create or replace function public.sms_allowed(p_kind text) returns boolean
language sql immutable as $$
  select p_kind in ('meeting_24h','meeting_1h','meeting_hotseat_48h','schedule_change')
$$;

-- Turns requested channels into the channels this member will actually get,
-- applying prefs, SMS allowlist, missing phone/push -> email fallback, and
-- "meeting reminders cannot be disabled".
create or replace function public.resolve_channels(p_member_id text, p_kind text, p_category text, p_channels text[])
returns text[] language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  pr   public.notification_prefs;
  c    public.member_contacts;
  has_push  boolean;
  has_phone boolean;
  has_email boolean;
  want_sms  boolean;
  ch   text;
  out_ text[] := '{}';
begin
  select * into pr from public.notification_prefs where member_id = p_member_id;
  select * into c  from public.member_contacts  where member_id = p_member_id;
  has_push  := exists (select 1 from public.push_subscriptions where member_id = p_member_id and disabled_at is null);
  has_phone := c.phone is not null;
  has_email := c.email is not null;

  if p_category = 'nudge' and pr.nudges is false then return '{}'; end if;

  want_sms := 'sms' = any(p_channels) and public.sms_allowed(p_kind) and has_phone and coalesce(pr.sms, true);

  foreach ch in array p_channels loop
    if ch = 'sms' then
      if want_sms then
        out_ := out_ || 'sms'::text;
      elsif has_email and coalesce(pr.email, true) and not ('push' = any(p_channels) and has_push) then
        out_ := out_ || 'email'::text;            -- no phone (or SMS off): email instead, unless push already covers it
      end if;
    elsif ch = 'push' then
      if has_push then out_ := out_ || 'push'::text;
      elsif not want_sms and has_email and (coalesce(pr.email, true) or p_category = 'meeting') then
        out_ := out_ || 'email'::text;            -- no push subscription: email fallback (not needed if SMS goes out)
      end if;
    elsif ch = 'email' then
      if has_email and coalesce(pr.email, true) then out_ := out_ || 'email'::text; end if;
    end if;
  end loop;

  -- Meeting reminders always reach the member somehow.
  if p_category = 'meeting' and cardinality(out_) = 0 then
    if has_push then out_ := array['push'];
    elsif has_email then out_ := array['email'];
    elsif has_phone and public.sms_allowed(p_kind) then out_ := array['sms'];
    end if;
  end if;

  select coalesce(array_agg(distinct x), '{}') into out_ from unnest(out_) x;
  return out_;
end $$;

-- Queue one notification for one member. Returns rows inserted (0 if
-- deduped, filtered by prefs, or the member has no way to be reached).
create or replace function public.enqueue_notification(
  p_member_id text, p_kind text, p_category text, p_channels text[],
  p_subject text, p_body text, p_url text default '',
  p_ref_type text default null, p_ref_id text default null, p_ref_starts_at timestamptz default null,
  p_send_at timestamptz default now(), p_dedupe_base text default null
) returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare
  m public.members;
  ch text;
  n int := 0;
  k int;
  at_ timestamptz;
  base text := coalesce(p_dedupe_base, p_kind || ':' || coalesce(p_ref_id, '') || ':' || p_member_id);
begin
  if public.is_seeding() then return 0; end if;
  select * into m from public.members where id = p_member_id and removed_at is null;
  if not found then return 0; end if;
  at_ := public.adjust_for_quiet_hours(p_send_at, p_ref_starts_at);
  foreach ch in array public.resolve_channels(p_member_id, p_kind, p_category, p_channels) loop
    insert into public.notification_queue(group_id, member_id, kind, category, channel, dedupe_key, subject, body, url,
                                          ref_type, ref_id, ref_starts_at, send_after)
    values (m.group_id, m.id, p_kind, p_category, ch, base || ':' || ch, coalesce(p_subject, ''), p_body, coalesce(p_url, ''),
            p_ref_type, p_ref_id, p_ref_starts_at, at_)
    on conflict (dedupe_key) do nothing;
    get diagnostics k = row_count;
    n := n + k;
  end loop;
  return n;
end $$;
comment on function public.enqueue_notification is
  'Single entry point for queueing. Applies prefs, SMS allowlist, fallbacks and quiet hours. Service role / triggers only.';

-- Bulk form for schedule-notifications: items is a JSON array of objects with
-- memberId, kind, category, channels[], subject, body, url, refType, refId, refStartsAt, sendAt, dedupeBase.
create or replace function public.enqueue_notifications(p_items jsonb) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare it jsonb; n int := 0;
begin
  for it in select * from jsonb_array_elements(p_items) loop
    n := n + public.enqueue_notification(
      it->>'memberId', it->>'kind', it->>'category',
      array(select jsonb_array_elements_text(it->'channels')),
      it->>'subject', it->>'body', coalesce(it->>'url', ''),
      it->>'refType', it->>'refId', (it->>'refStartsAt')::timestamptz,
      coalesce((it->>'sendAt')::timestamptz, now()), it->>'dedupeBase');
  end loop;
  return n;
end $$;

-- Everyone active in a group except one member.
create or replace function public.group_member_ids(p_group text, p_except text default null) returns setof text
language sql stable security definer set search_path = public, pg_temp as $$
  select id from public.members where group_id = p_group and removed_at is null
    and (p_except is null or id <> p_except) order by sort_order, name
$$;

create or replace function public.member_first_name(p_id text) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select split_part(name, ' ', 1) from public.members where id = p_id
$$;

create or replace function public.fmt_central(p_ts timestamptz) returns text
language sql stable as $$
  select trim(to_char(p_ts at time zone 'America/Chicago', 'Dy Mon FMDD, FMHH12:MI AM')) || ' CT'
$$;

-- ---------------------------------------------------------------------
-- Event-driven notification triggers
-- ---------------------------------------------------------------------

create or replace function public.tg_notify_announcement() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare mid text; who text := public.member_first_name(new.author_id);
begin
  if public.is_seeding() then return null; end if;
  for mid in select public.group_member_ids(new.group_id, new.author_id) loop
    perform public.enqueue_notification(mid, 'announcement_new', 'event',
      case when new.important then array['push','email'] else array['push'] end,
      new.title, who || ': ' || new.title, '#/group/announcements/' || new.id,
      'announcement', new.id, null, now(), 'announcement_new:' || new.id || ':' || mid);
  end loop;
  return null;
end $$;
drop trigger if exists notify_announcement on public.announcements;
create trigger notify_announcement after insert on public.announcements
  for each row execute function public.tg_notify_announcement();

-- Comment on your post -> author push. One function for the three comment tables.
create or replace function public.tg_notify_comment() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare owner_id text; title text; ref_t text; ref text; url text;
begin
  if public.is_seeding() then return null; end if;
  if tg_table_name = 'announcement_comments' then
    select author_id, a.title into owner_id, title from public.announcements a where id = new.announcement_id;
    ref_t := 'announcement'; ref := new.announcement_id; url := '#/group/announcements/' || ref;
  elsif tg_table_name = 'idea_comments' then
    select member_id, i.title into owner_id, title from public.ideas i where id = new.idea_id;
    ref_t := 'idea'; ref := new.idea_id; url := '#/group/ideas/' || ref;
  elsif tg_table_name = 'book_comments' then
    select suggested_by, b.title into owner_id, title from public.books b where id = new.book_id;
    ref_t := 'book'; ref := new.book_id; url := '#/group/books/' || ref;
  end if;
  if owner_id is null or owner_id = new.member_id then return null; end if;
  perform public.enqueue_notification(owner_id, 'comment_on_post', 'event', array['push'],
    'New comment', public.member_first_name(new.member_id) || ' commented on "' || title || '"', url,
    ref_t, ref, null, now(), 'comment:' || new.id || ':' || owner_id);
  return null;
end $$;
do $$
declare t text;
begin
  foreach t in array array['announcement_comments','idea_comments','book_comments'] loop
    execute format('drop trigger if exists notify_comment on public.%I', t);
    execute format('create trigger notify_comment after insert on public.%I for each row execute function public.tg_notify_comment()', t);
  end loop;
end $$;

-- Reply on your ask: "I can help" or a plain reply -> asker push.
create or replace function public.tg_notify_ask_reply() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.asks;
begin
  if public.is_seeding() then return null; end if;
  select * into a from public.asks where id = new.ask_id;
  if a.member_id = new.member_id then return null; end if;
  perform public.enqueue_notification(a.member_id,
    case when new.can_help then 'ask_can_help' else 'comment_on_post' end, 'event', array['push'],
    case when new.can_help then 'Someone can help' else 'New reply' end,
    public.member_first_name(new.member_id) ||
      case when new.can_help then ' can help with "' else ' replied to "' end || a.title || '"',
    '#/group/asks/' || a.id, 'ask', a.id, null, now(), 'ask_reply:' || new.id);
  return null;
end $$;
drop trigger if exists notify_ask_reply on public.ask_replies;
create trigger notify_ask_reply after insert on public.ask_replies
  for each row execute function public.tg_notify_ask_reply();

-- Invited to a closed get-together -> invitee push.
create or replace function public.tg_notify_invitee() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.get_togethers;
begin
  if public.is_seeding() then return null; end if;
  select * into e from public.get_togethers where id = new.get_together_id;
  if e.host_id = new.member_id or e.cancelled then return null; end if;
  perform public.enqueue_notification(new.member_id, 'gettogether_invite', 'event', array['push'],
    'You''re invited', public.member_first_name(e.host_id) || ' invited you: ' || e.title || ', ' || public.fmt_central(e.starts_at),
    '#/group/gettogethers/' || e.id, 'get_together', e.id, null, now(), 'gt_invite:' || e.id || ':' || new.member_id);
  return null;
end $$;
drop trigger if exists notify_invitee on public.get_together_invitees;
create trigger notify_invitee after insert on public.get_together_invitees
  for each row execute function public.tg_notify_invitee();

-- Meeting or training moved (time or place) -> everyone, sms + push.
-- Only for events in the next 45 days, so re-timing a whole year from a rule
-- change doesn't text everyone twelve times.
create or replace function public.tg_notify_schedule_change() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare mid text; what text; where_ text; url text; label text;
begin
  if public.is_seeding() then return null; end if;
  if new.cancelled_at is not null or new.starts_at < now() or new.starts_at > now() + interval '45 days' then return null; end if;
  if tg_table_name = 'meetings' then
    if new.starts_at is not distinct from old.starts_at and new.location is not distinct from old.location then return null; end if;
    label := new.title; url := '#/meetings/' || new.id;
    where_ := coalesce(
      case when new.location is null then null
           when new.location->>'type' = 'zoom' then 'Zoom'
           else coalesce(new.location->>'address', 'in person') end, 'usual place');
  else
    if new.starts_at is not distinct from old.starts_at and new.video_url is not distinct from old.video_url then return null; end if;
    label := 'Training' || case when new.topic <> '' then ': ' || new.topic else '' end;
    url := '#/meetings'; where_ := 'video';
  end if;
  what := 'Change: ' || label || ' is now ' || public.fmt_central(new.starts_at) || ' (' || where_ || ').';
  for mid in select public.group_member_ids(new.group_id) loop
    perform public.enqueue_notification(mid, 'schedule_change', 'meeting', array['sms','push'],
      'Schedule change', what, url,
      case when tg_table_name = 'meetings' then 'meeting' else 'training' end, new.id, null, now(),
      'schedule_change:' || new.id || ':' || extract(epoch from new.starts_at)::bigint || ':' || md5(coalesce(new.location::text, '') || coalesce(where_, '')) || ':' || mid);
  end loop;
  return null;
end $$;
drop trigger if exists notify_schedule_change on public.meetings;
create trigger notify_schedule_change after update of starts_at, location on public.meetings
  for each row execute function public.tg_notify_schedule_change();
drop trigger if exists notify_schedule_change on public.trainings;
create trigger notify_schedule_change after update of starts_at, video_url on public.trainings
  for each row execute function public.tg_notify_schedule_change();

-- =====================================================================
-- RPCs called by the app (PostgREST: POST /rest/v1/rpc/<name>)
-- Authorization is checked inside each function.
-- =====================================================================

-- Public (no session needed): branding for the invite screen. Deliberately no
-- rules, location or Zoom link; members read those from group_settings (RLS).
create or replace function public.get_group_config(p_group text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', g.id, 'name', g.name, 'subtitle', g.subtitle, 'tagline', g.tagline,
    'verse', s.verse, 'credit', s.credit,
    'meetingLengthMinutes', coalesce((s.meeting_rule->>'durationMinutes')::int, 60)
  ) || s.branding
  from public.groups g join public.group_settings s on s.group_id = g.id
  where g.id = p_group
$$;

-- Who am I, plus what the app needs right after login.
create or replace function public.get_session_info() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select case when m.id is null then null else jsonb_build_object(
    'memberId', m.id, 'groupId', m.group_id, 'name', m.name, 'role', m.role,
    'realtimeKey', s.realtime_key, 'rulesVersion', s.rules_version,
    'rulesAcceptedAt', (select accepted_at from public.rules_acceptances r
                        where r.member_id = m.id and r.rules_version = s.rules_version))
  end
  from (select (public.current_member()).*) m
  left join public.group_settings s on s.group_id = m.group_id
$$;

create or replace function public.touch_session() returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.sessions set last_seen_at = now()
  where token_hash = public.hash_token(public.request_session_token()) and revoked_at is null
    and last_seen_at < now() - interval '5 minutes'
$$;

create or replace function public.sign_out() returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.sessions set revoked_at = now()
  where token_hash = public.hash_token(public.request_session_token()) and revoked_at is null
$$;

create or replace function public.accept_rules(p_version int) returns timestamptz
language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.members := public.current_member(); ts timestamptz;
begin
  if me.id is null then raise exception 'Not signed in' using errcode = '28000'; end if;
  insert into public.rules_acceptances(member_id, group_id, rules_version) values (me.id, me.group_id, p_version)
  on conflict (member_id, rules_version) do update set accepted_at = public.rules_acceptances.accepted_at
  returning accepted_at into ts;
  return ts;
end $$;

-- Hot seat person (or an admin) saves prep. Keeps the first submittedAt.
create or replace function public.save_hot_seat_prep(p_meeting_id text, p_prep jsonb) returns public.meetings
language plpgsql security definer set search_path = public, pg_temp as $$
declare mt public.meetings; me text := public.current_member_id();
begin
  select * into mt from public.meetings where id = p_meeting_id and group_id = public.current_group_id() for update;
  if not found then raise exception 'Meeting not found' using errcode = 'P0002'; end if;
  if mt.hot_seat_member_id is distinct from me and not public.is_admin() then
    raise exception 'Only the hot seat person or an admin can save prep' using errcode = 'insufficient_privilege';
  end if;
  update public.meetings set hot_seat_prep =
    (p_prep - 'submittedAt' - 'editedAt')
    || jsonb_build_object('submittedAt', coalesce(mt.hot_seat_prep->>'submittedAt', to_jsonb(now())#>>'{}'))
    || case when mt.hot_seat_prep ? 'submittedAt' then jsonb_build_object('editedAt', to_jsonb(now())#>>'{}') else '{}'::jsonb end
  where id = p_meeting_id returning * into mt;
  return mt;
end $$;

-- Saves the action plan and creates/updates the hot seat person's commitment (text = next step).
create or replace function public.save_action_plan(p_meeting_id text, p_plan jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare mt public.meetings; c public.commitments; me text := public.current_member_id();
begin
  select * into mt from public.meetings where id = p_meeting_id and group_id = public.current_group_id() for update;
  if not found then raise exception 'Meeting not found' using errcode = 'P0002'; end if;
  if mt.hot_seat_member_id is null then raise exception 'No hot seat person on this meeting'; end if;
  if mt.hot_seat_member_id is distinct from me and not public.is_admin() then
    raise exception 'Only the hot seat person or an admin can save the action plan' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_plan->>'nextStep'), '') = '' then raise exception 'Next step is required'; end if;
  update public.meetings set action_plan = (p_plan - 'savedAt') || jsonb_build_object('savedAt', to_jsonb(now())#>>'{}')
    where id = p_meeting_id returning * into mt;
  insert into public.commitments(group_id, member_id, meeting_id, text, goal_id)
  values (mt.group_id, mt.hot_seat_member_id, mt.id, p_plan->>'nextStep', nullif(p_plan->>'goalId', ''))
  on conflict (meeting_id, member_id) do update
    set text = excluded.text, goal_id = excluded.goal_id
  returning * into c;
  return jsonb_build_object('meeting', to_jsonb(mt), 'commitment', to_jsonb(c));
end $$;

-- Admin: swap hot seat person and prep between two meetings, fixing the "Hot seat: Name" agenda line.
create or replace function public.swap_hot_seat(p_a text, p_b text) returns setof public.meetings
language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.meetings; b public.meetings; g text := public.current_group_id();
  a_name text; b_name text;
begin
  if not public.is_admin() then raise exception 'Admins only' using errcode = 'insufficient_privilege'; end if;
  select * into a from public.meetings where id = p_a and group_id = g for update;
  select * into b from public.meetings where id = p_b and group_id = g for update;
  if a.id is null or b.id is null then raise exception 'Meeting not found' using errcode = 'P0002'; end if;
  a_name := public.member_first_name(a.hot_seat_member_id);
  b_name := public.member_first_name(b.hot_seat_member_id);
  update public.meetings set hot_seat_member_id = b.hot_seat_member_id, hot_seat_prep = b.hot_seat_prep,
    agenda = public.agenda_swap_owner(a.agenda, a.hot_seat_member_id, b.hot_seat_member_id, a_name, b_name)
    where id = a.id;
  update public.meetings set hot_seat_member_id = a.hot_seat_member_id, hot_seat_prep = a.hot_seat_prep,
    agenda = public.agenda_swap_owner(b.agenda, b.hot_seat_member_id, a.hot_seat_member_id, b_name, a_name)
    where id = b.id;
  return query select * from public.meetings where id in (a.id, b.id) order by starts_at;
end $$;

create or replace function public.agenda_swap_owner(p_agenda jsonb, p_from text, p_to text, p_from_name text, p_to_name text)
returns jsonb language sql immutable as $$
  select coalesce(jsonb_agg(
    case when (it->>'item') ~* '^hot seat' then
      it || jsonb_build_object(
        'owner', case when it->>'owner' = p_from then to_jsonb(p_to) else it->'owner' end,
        'item', case when p_from_name is not null and p_to_name is not null
                     then regexp_replace(it->>'item', '\m' || p_from_name || '\M', p_to_name)
                     else it->>'item' end)
    else it end order by ord), '[]'::jsonb)
  from jsonb_array_elements(p_agenda) with ordinality as t(it, ord)
$$;

-- Admin: only one group book. Pass null to clear.
create or replace function public.set_group_book(p_book_id text) returns setof public.books
language plpgsql security definer set search_path = public, pg_temp as $$
declare g text := public.current_group_id();
begin
  if not public.is_admin() then raise exception 'Admins only' using errcode = 'insufficient_privilege'; end if;
  update public.books set group_book = false where group_id = g and group_book and id is distinct from p_book_id;
  if p_book_id is not null then
    update public.books set group_book = true where group_id = g and id = p_book_id;
  end if;
  return query select * from public.books where group_id = g order by created_at;
end $$;

-- Admin: group's usual meeting place. Null = back to the config default.
create or replace function public.set_group_location(p_location jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.is_admin() then raise exception 'Admins only' using errcode = 'insufficient_privilege'; end if;
  if p_location is not null and (p_location->>'type') not in ('zoom','inperson') then
    raise exception 'location.type must be zoom or inperson';
  end if;
  update public.group_settings set location_override = p_location where group_id = public.current_group_id();
  return p_location;
end $$;

-- Create or edit a get-together, with invitees, in one call.
-- p: { id?, title, kind, datetime, location, note, visibility, invitees: [memberId] }
create or replace function public.save_get_together(p jsonb) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me text := public.current_member_id(); g text := public.current_group_id();
  e public.get_togethers; new_id text;
  inv text[] := coalesce(array(select jsonb_array_elements_text(p->'invitees')), '{}');
begin
  if me is null then raise exception 'Not signed in' using errcode = '28000'; end if;
  if nullif(p->>'id', '') is not null then
    select * into e from public.get_togethers where id = p->>'id' and group_id = g for update;
  end if;
  if e.id is not null then
    if e.host_id <> me and not public.is_admin() then
      raise exception 'Only the host or an admin can edit this' using errcode = 'insufficient_privilege';
    end if;
    update public.get_togethers set
      title = coalesce(p->>'title', title), kind = coalesce(p->>'kind', kind),
      starts_at = coalesce((p->>'datetime')::timestamptz, starts_at),
      location = coalesce(p->>'location', location), note = coalesce(p->>'note', note),
      visibility = coalesce(p->>'visibility', visibility)
    where id = e.id returning * into e;
  else
    insert into public.get_togethers(id, group_id, host_id, title, kind, starts_at, location, note, visibility)
    values (coalesce(nullif(p->>'id', ''), gen_random_uuid()::text), g, me, p->>'title', coalesce(p->>'kind', 'other'),
            (p->>'datetime')::timestamptz, coalesce(p->>'location', ''), coalesce(p->>'note', ''), coalesce(p->>'visibility', 'open'))
    returning * into e;
    insert into public.get_together_rsvps(get_together_id, member_id, group_id, status) values (e.id, me, g, 'yes');
  end if;
  if e.visibility = 'open' then inv := '{}'; end if;
  delete from public.get_together_invitees where get_together_id = e.id and not (member_id = any(inv));
  insert into public.get_together_invitees(get_together_id, member_id, group_id)
    select e.id, x, g from unnest(inv) x
    where x <> e.host_id and exists (select 1 from public.members where id = x and group_id = g and removed_at is null)
  on conflict do nothing;
  return e.id;
end $$;

-- ---------------------------------------------------------------------
-- Admin roster and invite management
-- ---------------------------------------------------------------------

create or replace function public.admin_rotate_invite_code(p_code text default null, p_revoke_sessions boolean default false)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare g text := public.current_group_id(); code text;
begin
  if not public.is_admin() then raise exception 'Admins only' using errcode = 'insufficient_privilege'; end if;
  code := upper(btrim(coalesce(p_code,
    -- 8 characters without look-alikes (no 0/O, 1/I/L)
    (select string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + floor(random() * 31)::int, 1), '')
     from generate_series(1, 8)))));
  if length(code) < 6 then raise exception 'Invite code must be at least 6 characters'; end if;
  update public.group_invites set revoked_at = now() where group_id = g and revoked_at is null;
  insert into public.group_invites(group_id, code_hash, code_hint, created_by)
    values (g, public.hash_invite_code(g, code), right(code, 2), public.current_member_id());
  if p_revoke_sessions then
    update public.sessions set revoked_at = now()
    where group_id = g and revoked_at is null and token_hash <> public.hash_token(public.request_session_token());
  end if;
  return code;  -- shown to the admin once; only the hash is stored
end $$;

create or replace function public.admin_add_member(p_name text, p_role text default 'member',
  p_email text default null, p_phone text default null) returns public.members
language plpgsql security definer set search_path = public, pg_temp as $$
declare g text := public.current_group_id(); m public.members;
begin
  if not public.is_admin() then raise exception 'Admins only' using errcode = 'insufficient_privilege'; end if;
  insert into public.members(group_id, name, role, sort_order)
    values (g, btrim(p_name), coalesce(p_role, 'member'),
            coalesce((select max(sort_order) + 1 from public.members where group_id = g), 1))
    returning * into m;
  if p_email is not null or p_phone is not null then
    insert into public.member_contacts(member_id, group_id, email, phone) values (m.id, g, nullif(p_email, ''), nullif(p_phone, ''));
  end if;
  return m;
end $$;

create or replace function public.admin_remove_member(p_member_id text) returns public.members
language plpgsql security definer set search_path = public, pg_temp as $$
declare g text := public.current_group_id(); m public.members;
begin
  if not public.is_admin() then raise exception 'Admins only' using errcode = 'insufficient_privilege'; end if;
  if p_member_id = public.current_member_id() then raise exception 'You can''t remove yourself'; end if;
  update public.members set removed_at = now(), removed_by = public.current_member_id()
    where id = p_member_id and group_id = g and removed_at is null returning * into m;
  if not found then raise exception 'Member not found' using errcode = 'P0002'; end if;
  update public.sessions set revoked_at = now() where member_id = m.id and revoked_at is null;
  update public.push_subscriptions set disabled_at = now() where member_id = m.id and disabled_at is null;
  delete from public.notification_queue where member_id = m.id and status = 'pending';
  -- Free their future hot seats so the admin can reassign.
  update public.meetings set hot_seat_member_id = null, hot_seat_prep = null
    where group_id = g and hot_seat_member_id = m.id and starts_at > now();
  return m;
end $$;

create or replace function public.admin_restore_member(p_member_id text) returns public.members
language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.members;
begin
  if not public.is_admin() then raise exception 'Admins only' using errcode = 'insufficient_privilege'; end if;
  update public.members set removed_at = null, removed_by = null
    where id = p_member_id and group_id = public.current_group_id() returning * into m;
  if not found then raise exception 'Member not found' using errcode = 'P0002'; end if;
  return m;
end $$;

create or replace function public.admin_update_member(p_member_id text, p jsonb) returns public.members
language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.members;
begin
  if not public.is_admin() then raise exception 'Admins only' using errcode = 'insufficient_privilege'; end if;
  if p_member_id = public.current_member_id() and (p->>'role') = 'member'
     and not exists (select 1 from public.members where group_id = public.current_group_id() and role = 'admin'
                     and removed_at is null and id <> p_member_id) then
    raise exception 'The group needs at least one admin';
  end if;
  update public.members set
    name = coalesce(nullif(btrim(p->>'name'), ''), name),
    role = coalesce(p->>'role', role),
    sort_order = coalesce((p->>'sortOrder')::int, sort_order)
  where id = p_member_id and group_id = public.current_group_id() returning * into m;
  if not found then raise exception 'Member not found' using errcode = 'P0002'; end if;
  if p ? 'email' or p ? 'phone' then
    insert into public.member_contacts(member_id, group_id, email, phone)
      values (m.id, m.group_id, nullif(p->>'email', ''), nullif(p->>'phone', ''))
    on conflict (member_id) do update set
      email = case when p ? 'email' then excluded.email else public.member_contacts.email end,
      phone = case when p ? 'phone' then excluded.phone else public.member_contacts.phone end;
  end if;
  return m;
end $$;

-- ---------------------------------------------------------------------
-- Service-role helpers for send-notifications
-- ---------------------------------------------------------------------

-- Claims due rows (FOR UPDATE SKIP LOCKED) and skips ones that no longer apply:
-- event moved or cancelled, event already started (for pre-event reminders).
create or replace function public.claim_notifications(p_limit int default 200) returns setof public.notification_queue
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- Recover rows stuck in 'sending' (function crashed).
  update public.notification_queue set status = 'pending', locked_at = null
    where status = 'sending' and locked_at < now() - interval '15 minutes';

  with stale as (
    select q.id from public.notification_queue q
    left join public.meetings mt on q.ref_type = 'meeting' and mt.id = q.ref_id
    left join public.trainings tr on q.ref_type = 'training' and tr.id = q.ref_id
    left join public.get_togethers gt on q.ref_type = 'get_together' and gt.id = q.ref_id
    where q.status = 'pending' and q.send_after <= now() and q.ref_starts_at is not null
      and (
        coalesce(mt.starts_at, tr.starts_at, gt.starts_at) is distinct from q.ref_starts_at
        or mt.cancelled_at is not null or tr.cancelled_at is not null or coalesce(gt.cancelled, false)
        or (q.kind not like '%after%' and q.kind <> 'commitment_2w' and now() > q.ref_starts_at)
      )
  ), skipped as (
    update public.notification_queue q set status = 'skipped', last_error = 'event changed, cancelled or already started'
    from stale where q.id = stale.id
    returning q.*
  )
  insert into public.notification_log(queue_id, group_id, member_id, kind, category, channel, dedupe_key, status, error)
    select id, group_id, member_id, kind, category, channel, dedupe_key, 'skipped', last_error from skipped;

  return query
  with due as (
    select id from public.notification_queue
    where status = 'pending' and send_after <= now()
    order by send_after
    limit p_limit
    for update skip locked
  )
  update public.notification_queue q set status = 'sending', locked_at = now(), attempts = attempts + 1
  from due where q.id = due.id
  returning q.*;
end $$;

-- Records the outcome. failed rows retry up to 3 times (10, 20 min later) unless marked permanent.
create or replace function public.finish_notifications(p_results jsonb) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare r jsonb; q public.notification_queue; st text; n int := 0;
begin
  for r in select * from jsonb_array_elements(p_results) loop
    st := r->>'status';  -- sent | failed | skipped | deferred
    if st = 'deferred' then
      update public.notification_queue set status = 'pending', locked_at = null, attempts = greatest(attempts - 1, 0),
        send_after = (r->>'until')::timestamptz where id = (r->>'id')::bigint;
      continue;
    end if;
    update public.notification_queue set
      status = case when st = 'failed' and attempts < 3 and not coalesce((r->>'permanent')::boolean, false) then 'pending' else st end,
      send_after = case when st = 'failed' and attempts < 3 and not coalesce((r->>'permanent')::boolean, false)
                        then now() + attempts * interval '10 minutes' else send_after end,
      last_error = r->>'error', locked_at = null,
      sent_at = case when st = 'sent' then now() else sent_at end
    where id = (r->>'id')::bigint returning * into q;
    if q.id is null then continue; end if;
    if q.status <> 'pending' then
      insert into public.notification_log(queue_id, group_id, member_id, kind, category, channel, dedupe_key, status, provider_id, error, bundle_size)
      values (q.id, q.group_id, q.member_id, q.kind, q.category, q.channel, q.dedupe_key, q.status,
              r->>'providerId', r->>'error', coalesce((r->>'bundleSize')::int, 1));
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- Sign-in codes. Added by migrations_extra/0007_login_verification.sql (kept
-- here so a fresh setup from this file ends up the same). The 180-day session
-- limit from 0007 is in current_member_id() above; the hourly cleanup job is
-- in cron.sql.
-- ---------------------------------------------------------------------
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
