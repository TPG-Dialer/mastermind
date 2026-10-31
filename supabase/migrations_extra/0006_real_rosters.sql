-- 0006: real rosters and settings for both groups.
--
-- Replaces the sample data from seed.sql with the real members, meeting
-- rules, usual meeting places and invite codes:
--   The Shoreline (family): 3rd Wednesday 7:30 PM Central, 60 min, Zoom
--                           (link not set yet: an admin pastes it in
--                           Profile > Meeting location).
--   Flight Club (entrepreneur): 3rd Friday 7:00 AM Central, 120 min, in person
--                           at Vendella; trainings 3rd Wednesday noon, 60 min.
--
-- Keeps the groups and group_settings rows (branding, verse, dedication,
-- realtime key) and updates them. Everything else for both groups goes:
-- meetings, trainings, get-togethers, announcements, ideas, books, asks,
-- goals, commitments, check-ins, notifications, sessions and members
-- (deleting a member cascades to their RSVPs, comments, likes, reading list,
-- contacts, prefs, push subscriptions and rules acceptances).
--
-- Hot seat order = sort_order. generate-meetings (called at the end) gives
-- the first new meeting to sort_order 1 and goes down the list from there.
--
-- Safe to run twice: each group is only reset if its marker member
-- ('fam-corey' / 'fc-corey') isn't there yet, so a re-run never wipes real
-- data added after the first run. The generate-meetings call only fills gaps.
--
-- Member contacts are not created here: the app upserts them (profile setup
-- asks each member for email and phone on first sign-in), and a member with
-- no row simply has no email/SMS yet. notification_prefs rows are created by
-- the members_prefs trigger.

begin;
set local mm.seeding = 'on';   -- no notifications or change-feed pings while resetting

do $$
declare
  g text;
begin
  foreach g in array array['family', 'entrepreneur'] loop
    if exists (select 1 from public.members
               where id = case g when 'family' then 'fam-corey' else 'fc-corey' end) then
      raise notice '0006: % already has the real roster, skipping', g;
      continue;
    end if;
    if not exists (select 1 from public.group_settings where group_id = g) then
      raise exception '0006: group_settings row for % is missing', g;
    end if;

    -- 1. Wipe the samples. Meetings go before members (hot_seat_member_id
    --    has no cascade); member deletes cascade the rest.
    delete from public.notification_queue where group_id = g;
    delete from public.notification_log   where group_id = g;
    delete from public.get_togethers      where group_id = g;
    delete from public.announcements      where group_id = g;
    delete from public.ideas              where group_id = g;
    delete from public.books              where group_id = g;
    delete from public.asks               where group_id = g;
    delete from public.checkins           where group_id = g;
    delete from public.commitments        where group_id = g;
    delete from public.goals              where group_id = g;
    delete from public.meetings           where group_id = g;
    delete from public.trainings          where group_id = g;
    delete from public.sessions           where group_id = g;
    delete from public.push_subscriptions where group_id = g;
    delete from public.members            where group_id = g;
    delete from public.group_activity     where group_id = g;
  end loop;
end $$;

-- 2. Members. sort_order is the roster and hot seat order.
insert into public.members (id, group_id, name, role, sort_order)
select v.id, v.group_id, v.name, v.role, v.sort_order
from (values
  ('fam-tristin',  'family',       'Tristin Burdick',  'member', 1),
  ('fam-faith',    'family',       'Faith Heil',       'member', 2),
  ('fam-jaymie',   'family',       'Jaymie Heil',      'member', 3),
  ('fam-braxton',  'family',       'Braxton Claflin',  'member', 4),
  ('fam-corey',    'family',       'Corey Claflin',    'admin',  5),
  ('fc-angelo',    'entrepreneur', 'Angelo Marasigan', 'member', 1),
  ('fc-sarah',     'entrepreneur', 'Sarah Marasigan',  'member', 2),
  ('fc-jeffrey',   'entrepreneur', 'Jeffrey Miller',   'admin',  3),
  ('fc-nathaniel', 'entrepreneur', 'Nathaniel Bliss',  'member', 4),
  ('fc-vasiliy',   'entrepreneur', 'Vasiliy Shvets',   'member', 5),
  ('fc-ryan',      'entrepreneur', 'Ryan',             'member', 6),
  ('fc-corey',     'entrepreneur', 'Corey Stevens',    'admin',  7)
) as v(id, group_id, name, role, sort_order)
where not exists (select 1 from public.members m where m.group_id = v.group_id);
-- (The guard above only matches a group that was just emptied, so a re-run inserts nothing.)

-- 3. Settings. Only for a group whose roster was just loaded (marker members
--    created in this transaction), so a re-run keeps later admin changes.
update public.group_settings s set
  meeting_rule      = '{"nth":3,"weekday":3,"start":"19:30","durationMinutes":60,"titleTemplate":"{month} Shoreline"}'::jsonb,
  training_rule     = null,
  location_default  = '{"type":"zoom","label":"Zoom","url":null,"address":null}'::jsonb,
  location_override = null,
  credit            = '{"label":"Built by TPG","url":"https://tpgmn.com"}'::jsonb,
  rules             = '["What''s said in the room stays in the room. Ask before sharing someone''s story.","Show up. If you can''t make it, tell Corey before the day of.","Check in before the meeting starts so we can read wins and challenges ahead of time.","Hot seat prep is in 24 hours before the meeting.","Phones face down during the meeting, except to take notes.","Advice is a gift. Say thank you, then decide for yourself.","Everyone leaves with one commitment, and we follow up on it."]'::jsonb,
  agenda_template   = '[{"time":5,"item":"Opening prayer and wins of the month","owner":"fam-corey"},{"time":10,"item":"Commitment check-in, round the table","owner":"all"},{"time":25,"item":"Hot seat: {hotSeatName}","owner":"{hotSeat}"},{"time":15,"item":"Open discussion","owner":"all"},{"time":5,"item":"New commitments and close","owner":"fam-corey"}]'::jsonb
where s.group_id = 'family'
  and exists (select 1 from public.members m where m.id = 'fam-corey' and m.created_at = now());

update public.group_settings s set
  meeting_rule      = '{"nth":3,"weekday":5,"start":"07:00","durationMinutes":120,"titleTemplate":"{month} Flight Club"}'::jsonb,
  training_rule     = '{"nth":3,"weekday":3,"start":"12:00","durationMinutes":60,"titleTemplate":"Flight Club Training"}'::jsonb,
  location_default  = '{"type":"inperson","label":"Vendella Euro Boutique & Coffee Haus","url":null,"address":"1440 Duckwood Dr Ste 600, Eagan, MN 55122"}'::jsonb,
  location_override = null,
  credit            = '{"label":"Built by TPG","url":"https://tpgmn.com"}'::jsonb,
  rules             = '["Confidential means confidential. Names, numbers and stories stay in the room.","Attend every session. Miss two in a row and an admin will call you.","Check in by the start of the meeting. Hot seat prep is due 24 hours before.","Start at 7:00 sharp and end on time.","Give experience, not opinions. Say what you did, not what someone should do.","Leave with one commitment you can finish before the next session."]'::jsonb,
  agenda_template   = '[{"time":10,"item":"Opening prayer and devotional","owner":"fc-jeffrey"},{"time":10,"item":"Quick wins, one sentence each","owner":"all"},{"time":25,"item":"Commitment check-in","owner":"all"},{"time":45,"item":"Hot seat: {hotSeatName}","owner":"{hotSeat}"},{"time":20,"item":"Teaching","owner":"all"},{"time":10,"item":"New commitments and closing prayer","owner":"all"}]'::jsonb
where s.group_id = 'entrepreneur'
  and exists (select 1 from public.members m where m.id = 'fc-corey' and m.created_at = now());

-- 4. Invite codes: revoke the demo ones, add the real ones (hash only).
--    Same "just loaded" guard, so a re-run doesn't undo a later rotation.
update public.group_invites i set revoked_at = now()
where i.revoked_at is null
  and exists (select 1 from public.members m
              where m.id = case i.group_id when 'family' then 'fam-corey' when 'entrepreneur' then 'fc-corey' end
                and m.created_at = now());
insert into public.group_invites (group_id, code_hash, code_hint)
select v.g, public.hash_invite_code(v.g, v.code), right(v.code, 2)
from (values ('family', 'SHORE26', 'fam-corey'), ('entrepreneur', 'FLIGHT26', 'fc-corey')) as v(g, code, marker)
where exists (select 1 from public.members m where m.id = v.marker and m.created_at = now())
  and not exists (select 1 from public.group_invites i where i.group_id = v.g and i.revoked_at is null);

-- 5. Twelve months of meetings (and Flight Club trainings) with the hot seat
--    rotation in sort_order. pg_net sends the request after this commits,
--    so the function sees the new roster and rules.
select public.mm_call_function('generate-meetings');

commit;
