-- =====================================================================
-- Mastermind app: privileges and row-level security
-- Run after schema.sql. Safe to re-run.
--
-- Who is asking: the app calls PostgREST with the project's anon key, so
-- every request runs as the `anon` role. The member is identified by the
-- x-session-token header through current_member_id() (schema.sql).
-- No token, a revoked token, or a removed member = current_member_id() is
-- null = every policy below is false = nothing visible.
--
-- Rules:
--   * Nobody sees another group:    group_id = current_group_id() everywhere.
--   * Members edit only their rows: member_id = current_member_id().
--   * Admins edit anything in their group: is_admin().
--   * Closed get-togethers: host, invitees and admins only.
--   * Contact details: the member and admins only.
--   * Sessions, invites, queue, log, join attempts: no policies (service role only).
--
-- Policies wrap the helpers in (select ...) so Postgres evaluates them once
-- per statement instead of once per row.
-- =====================================================================

set client_min_messages = warning;

-- ---------------------------------------------------------------------
-- 1. Privileges. Start from nothing, then grant what the app needs.
--    (Supabase grants everything to anon by default; RLS would still
--    protect rows, but column grants also stop a member from changing
--    fields like role, group_id or created_at.)
-- ---------------------------------------------------------------------

revoke all on all tables    in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
-- Future objects too (Supabase's default privileges would otherwise re-grant).
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on functions from public, anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

grant usage on schema public to anon, authenticated;

-- Readable tables (rows filtered by RLS).
grant select on
  public.groups, public.group_settings, public.members, public.member_contacts, public.rules_acceptances,
  public.meetings, public.meeting_rsvps, public.meeting_attendance,
  public.trainings, public.training_rsvps,
  public.get_togethers, public.get_together_invitees, public.get_together_rsvps,
  public.goals, public.commitments, public.checkins,
  public.asks, public.ask_replies, public.announcements, public.announcement_comments,
  public.ideas, public.idea_likes, public.idea_comments,
  public.books, public.book_comments, public.reading_list,
  public.notification_prefs, public.push_subscriptions, public.group_activity
to anon;

-- Writes. Column lists = the only fields the app may set directly.
grant update (branding, verse, credit, rules, rules_version, meeting_rule, training_rule,
              agenda_template, notification_options) on public.group_settings to anon;
grant update (bio, focus, can_help_with, working_genius) on public.members to anon;
grant insert (member_id, email, phone), update (member_id, email, phone) on public.member_contacts to anon;

grant insert (id, starts_at, duration_minutes, title, location, agenda, hot_seat_member_id, notes),
      update (starts_at, duration_minutes, title, location, agenda, hot_seat_member_id, notes, cancelled_at),
      delete on public.meetings to anon;
-- Upserts (PostgREST merge-duplicates) SET every column sent, so key columns need UPDATE too;
-- the WITH CHECK policies still pin member_id to the caller.
grant insert (meeting_id, member_id, status), update (meeting_id, member_id, status), delete on public.meeting_rsvps to anon;
grant insert (meeting_id, member_id), delete on public.meeting_attendance to anon;

grant insert (id, starts_at, duration_minutes, topic, description, video_url, recording_url),
      update (starts_at, duration_minutes, topic, description, video_url, recording_url, cancelled_at),
      delete on public.trainings to anon;
grant insert (training_id, member_id, status), update (training_id, member_id, status), delete on public.training_rsvps to anon;

-- get_togethers / invitees are written through save_get_together(); cancel is a plain update.
grant update (cancelled) on public.get_togethers to anon;
grant insert (get_together_id, member_id, status), update (get_together_id, member_id, status), delete on public.get_together_rsvps to anon;

grant insert (id, member_id, period, title, why, target_date, status, accountability_ask),
      update (period, title, why, target_date, status, accountability_ask), delete on public.goals to anon;
grant insert (id, member_id, meeting_id, text, status, last_update_note, goal_id),
      update (text, status, last_update_note, goal_id), delete on public.commitments to anon;
grant insert (id, meeting_id, member_id, win, challenge), update (meeting_id, member_id, win, challenge) on public.checkins to anon;

grant insert (id, title, detail, needs), update (title, detail, needs, status), delete on public.asks to anon;
grant insert (id, ask_id, text, can_help), delete on public.ask_replies to anon;

grant insert (id, title, body, pinned, important), update (title, body, pinned, important), delete on public.announcements to anon;
grant insert (id, announcement_id, text), delete on public.announcement_comments to anon;

grant insert (id, type, title, note, url), update (type, title, note, url), delete on public.ideas to anon;
grant insert (idea_id), delete on public.idea_likes to anon;
grant insert (id, idea_id, text), delete on public.idea_comments to anon;

grant insert (id, title, author, why), update (title, author, why), delete on public.books to anon;
grant insert (id, book_id, text), delete on public.book_comments to anon;
grant insert (book_id, member_id, status), update (book_id, member_id, status), delete on public.reading_list to anon;

grant update (sms, email, nudges) on public.notification_prefs to anon;
grant insert (endpoint, p256dh, auth, user_agent), delete on public.push_subscriptions to anon;

-- Functions the app (or RLS evaluated as anon) may call.
grant execute on function
  public.request_session_token(), public.hash_token(text),
  public.current_member_id(), public.current_member(), public.current_group_id(), public.is_admin(),
  public.valid_working_genius(jsonb), public.is_seeding(),
  public.get_group_config(text), public.get_session_info(), public.touch_session(), public.sign_out(),
  public.accept_rules(int),
  public.save_hot_seat_prep(text, jsonb), public.save_action_plan(text, jsonb),
  public.swap_hot_seat(text, text), public.agenda_swap_owner(jsonb, text, text, text, text),
  public.set_group_book(text), public.set_group_location(jsonb), public.save_get_together(jsonb),
  public.admin_rotate_invite_code(text, boolean), public.admin_add_member(text, text, text, text),
  public.admin_remove_member(text), public.admin_restore_member(text), public.admin_update_member(text, jsonb)
to anon;
-- Trigger functions run as the table owner, so anon needs no EXECUTE on them.
-- enqueue_*, resolve_channels, claim/finish_notifications: service role only.
grant execute on all functions in schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- ---------------------------------------------------------------------
-- 2. Helpers used by policies
-- ---------------------------------------------------------------------

-- Visible = open, or caller is host, invitee or admin. SECURITY DEFINER so the
-- invitee lookup doesn't recurse through get_together_invitees' own policy.
create or replace function public.can_see_get_together(p_id text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.get_togethers e
    where e.id = p_id and e.group_id = public.current_group_id()
      and (e.visibility = 'open' or e.host_id = public.current_member_id() or public.is_admin()
           or exists (select 1 from public.get_together_invitees i
                      where i.get_together_id = e.id and i.member_id = public.current_member_id())))
$$;
grant execute on function public.can_see_get_together(text) to anon;

-- ---------------------------------------------------------------------
-- 3. Enable RLS on every table (including service-only ones: no policy = no access)
-- ---------------------------------------------------------------------

do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
end $$;
-- Not FORCE: SECURITY DEFINER helpers run as the table owner and must be able
-- to read sessions/invites (which have no policies). The service role used by
-- Edge Functions has BYPASSRLS.

-- Drop our policies before (re)creating them, so this file is re-runnable.
do $$
declare p record;
begin
  for p in select policyname, tablename from pg_policies where schemaname = 'public' and policyname like 'mm_%' loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 4. Policies
-- ---------------------------------------------------------------------

-- groups / settings
create policy mm_groups_select on public.groups for select to anon
  using (id = (select public.current_group_id()));

create policy mm_settings_select on public.group_settings for select to anon
  using (group_id = (select public.current_group_id()));
create policy mm_settings_update on public.group_settings for update to anon
  using (group_id = (select public.current_group_id()) and (select public.is_admin()))
  with check (group_id = (select public.current_group_id()));

-- members: whole group can read the roster (incl. removed, for history);
-- you edit your own profile, admins edit anyone's profile fields.
create policy mm_members_select on public.members for select to anon
  using (group_id = (select public.current_group_id()));
create policy mm_members_update on public.members for update to anon
  using (group_id = (select public.current_group_id())
         and (id = (select public.current_member_id()) or (select public.is_admin())))
  with check (group_id = (select public.current_group_id()));

create policy mm_contacts_select on public.member_contacts for select to anon
  using (group_id = (select public.current_group_id())
         and (member_id = (select public.current_member_id()) or (select public.is_admin())));
create policy mm_contacts_insert on public.member_contacts for insert to anon
  with check (group_id = (select public.current_group_id())
              and (member_id = (select public.current_member_id()) or (select public.is_admin())));
create policy mm_contacts_update on public.member_contacts for update to anon
  using (group_id = (select public.current_group_id())
         and (member_id = (select public.current_member_id()) or (select public.is_admin())))
  with check (group_id = (select public.current_group_id()));

create policy mm_rules_select on public.rules_acceptances for select to anon
  using (group_id = (select public.current_group_id()));
-- (accepting goes through accept_rules())

-- Pattern macros, written out per table below:
--   group read:  group_id = my group
--   own write:   member_id = me, or admin
--   admin write: admin

-- meetings: group reads; admins write. Prep and action plan go through RPCs.
create policy mm_meetings_select on public.meetings for select to anon
  using (group_id = (select public.current_group_id()));
create policy mm_meetings_insert on public.meetings for insert to anon
  with check (group_id = (select public.current_group_id()) and (select public.is_admin()));
create policy mm_meetings_update on public.meetings for update to anon
  using (group_id = (select public.current_group_id()) and (select public.is_admin()))
  with check (group_id = (select public.current_group_id()));
create policy mm_meetings_delete on public.meetings for delete to anon
  using (group_id = (select public.current_group_id()) and (select public.is_admin()));

create policy mm_meeting_rsvps_select on public.meeting_rsvps for select to anon
  using (group_id = (select public.current_group_id()));
create policy mm_meeting_rsvps_insert on public.meeting_rsvps for insert to anon
  with check (group_id = (select public.current_group_id())
              and (member_id = (select public.current_member_id()) or (select public.is_admin())));
create policy mm_meeting_rsvps_update on public.meeting_rsvps for update to anon
  using (group_id = (select public.current_group_id())
         and (member_id = (select public.current_member_id()) or (select public.is_admin())))
  with check (group_id = (select public.current_group_id()));
create policy mm_meeting_rsvps_delete on public.meeting_rsvps for delete to anon
  using (group_id = (select public.current_group_id())
         and (member_id = (select public.current_member_id()) or (select public.is_admin())));

create policy mm_attendance_select on public.meeting_attendance for select to anon
  using (group_id = (select public.current_group_id()));
create policy mm_attendance_insert on public.meeting_attendance for insert to anon
  with check (group_id = (select public.current_group_id()) and (select public.is_admin()));
create policy mm_attendance_delete on public.meeting_attendance for delete to anon
  using (group_id = (select public.current_group_id()) and (select public.is_admin()));

-- trainings: same as meetings
create policy mm_trainings_select on public.trainings for select to anon
  using (group_id = (select public.current_group_id()));
create policy mm_trainings_insert on public.trainings for insert to anon
  with check (group_id = (select public.current_group_id()) and (select public.is_admin()));
create policy mm_trainings_update on public.trainings for update to anon
  using (group_id = (select public.current_group_id()) and (select public.is_admin()))
  with check (group_id = (select public.current_group_id()));
create policy mm_trainings_delete on public.trainings for delete to anon
  using (group_id = (select public.current_group_id()) and (select public.is_admin()));

create policy mm_training_rsvps_select on public.training_rsvps for select to anon
  using (group_id = (select public.current_group_id()));
create policy mm_training_rsvps_insert on public.training_rsvps for insert to anon
  with check (group_id = (select public.current_group_id())
              and (member_id = (select public.current_member_id()) or (select public.is_admin())));
create policy mm_training_rsvps_update on public.training_rsvps for update to anon
  using (group_id = (select public.current_group_id())
         and (member_id = (select public.current_member_id()) or (select public.is_admin())))
  with check (group_id = (select public.current_group_id()));
create policy mm_training_rsvps_delete on public.training_rsvps for delete to anon
  using (group_id = (select public.current_group_id())
         and (member_id = (select public.current_member_id()) or (select public.is_admin())));

-- get-togethers: closed ones only for host, invitees, admins
create policy mm_gt_select on public.get_togethers for select to anon
  using (group_id = (select public.current_group_id()) and public.can_see_get_together(id));
create policy mm_gt_update on public.get_togethers for update to anon
  using (group_id = (select public.current_group_id())
         and (host_id = (select public.current_member_id()) or (select public.is_admin())))
  with check (group_id = (select public.current_group_id()));
-- (create/edit with invitees goes through save_get_together())

create policy mm_gt_invitees_select on public.get_together_invitees for select to anon
  using (group_id = (select public.current_group_id()) and public.can_see_get_together(get_together_id));

create policy mm_gt_rsvps_select on public.get_together_rsvps for select to anon
  using (group_id = (select public.current_group_id()) and public.can_see_get_together(get_together_id));
create policy mm_gt_rsvps_insert on public.get_together_rsvps for insert to anon
  with check (group_id = (select public.current_group_id()) and public.can_see_get_together(get_together_id)
              and (member_id = (select public.current_member_id()) or (select public.is_admin())));
create policy mm_gt_rsvps_update on public.get_together_rsvps for update to anon
  using (group_id = (select public.current_group_id())
         and (member_id = (select public.current_member_id()) or (select public.is_admin())))
  with check (group_id = (select public.current_group_id()) and public.can_see_get_together(get_together_id));
create policy mm_gt_rsvps_delete on public.get_together_rsvps for delete to anon
  using (group_id = (select public.current_group_id())
         and (member_id = (select public.current_member_id()) or (select public.is_admin())));

-- goals and commitments: own, or admin for anyone in the group
create policy mm_goals_select on public.goals for select to anon
  using (group_id = (select public.current_group_id()));
create policy mm_goals_insert on public.goals for insert to anon
  with check (group_id = (select public.current_group_id())
              and (member_id = (select public.current_member_id()) or (select public.is_admin())));
create policy mm_goals_update on public.goals for update to anon
  using (group_id = (select public.current_group_id())
         and (member_id = (select public.current_member_id()) or (select public.is_admin())))
  with check (group_id = (select public.current_group_id()));
create policy mm_goals_delete on public.goals for delete to anon
  using (group_id = (select public.current_group_id())
         and (member_id = (select public.current_member_id()) or (select public.is_admin())));

create policy mm_commitments_select on public.commitments for select to anon
  using (group_id = (select public.current_group_id()));
create policy mm_commitments_insert on public.commitments for insert to anon
  with check (group_id = (select public.current_group_id())
              and (member_id = (select public.current_member_id()) or (select public.is_admin())));
create policy mm_commitments_update on public.commitments for update to anon
  using (group_id = (select public.current_group_id())
         and (member_id = (select public.current_member_id()) or (select public.is_admin())))
  with check (group_id = (select public.current_group_id()));
create policy mm_commitments_delete on public.commitments for delete to anon
  using (group_id = (select public.current_group_id())
         and (member_id = (select public.current_member_id()) or (select public.is_admin())));

create policy mm_checkins_select on public.checkins for select to anon
  using (group_id = (select public.current_group_id()));
create policy mm_checkins_insert on public.checkins for insert to anon
  with check (group_id = (select public.current_group_id()) and member_id = (select public.current_member_id()));
create policy mm_checkins_update on public.checkins for update to anon
  using (group_id = (select public.current_group_id())
         and (member_id = (select public.current_member_id()) or (select public.is_admin())))
  with check (group_id = (select public.current_group_id()));

-- asks and replies: authored content is always your own (admins can't post as someone)
create policy mm_asks_select on public.asks for select to anon
  using (group_id = (select public.current_group_id()));
create policy mm_asks_insert on public.asks for insert to anon
  with check (group_id = (select public.current_group_id()) and member_id = (select public.current_member_id()));
create policy mm_asks_update on public.asks for update to anon
  using (group_id = (select public.current_group_id())
         and (member_id = (select public.current_member_id()) or (select public.is_admin())))
  with check (group_id = (select public.current_group_id()));
create policy mm_asks_delete on public.asks for delete to anon
  using (group_id = (select public.current_group_id())
         and (member_id = (select public.current_member_id()) or (select public.is_admin())));

create policy mm_ask_replies_select on public.ask_replies for select to anon
  using (group_id = (select public.current_group_id()));
create policy mm_ask_replies_insert on public.ask_replies for insert to anon
  with check (group_id = (select public.current_group_id()) and member_id = (select public.current_member_id()));
create policy mm_ask_replies_delete on public.ask_replies for delete to anon
  using (group_id = (select public.current_group_id())
         and (member_id = (select public.current_member_id()) or (select public.is_admin())));

-- announcements (pinned/important guarded by trigger: admins only)
create policy mm_ann_select on public.announcements for select to anon
  using (group_id = (select public.current_group_id()));
create policy mm_ann_insert on public.announcements for insert to anon
  with check (group_id = (select public.current_group_id()) and author_id = (select public.current_member_id()));
create policy mm_ann_update on public.announcements for update to anon
  using (group_id = (select public.current_group_id())
         and (author_id = (select public.current_member_id()) or (select public.is_admin())))
  with check (group_id = (select public.current_group_id()));
create policy mm_ann_delete on public.announcements for delete to anon
  using (group_id = (select public.current_group_id())
         and (author_id = (select public.current_member_id()) or (select public.is_admin())));

create policy mm_ann_comments_select on public.announcement_comments for select to anon
  using (group_id = (select public.current_group_id()));
create policy mm_ann_comments_insert on public.announcement_comments for insert to anon
  with check (group_id = (select public.current_group_id()) and member_id = (select public.current_member_id()));
create policy mm_ann_comments_delete on public.announcement_comments for delete to anon
  using (group_id = (select public.current_group_id())
         and (member_id = (select public.current_member_id()) or (select public.is_admin())));

-- ideas, likes, comments
create policy mm_ideas_select on public.ideas for select to anon
  using (group_id = (select public.current_group_id()));
create policy mm_ideas_insert on public.ideas for insert to anon
  with check (group_id = (select public.current_group_id()) and member_id = (select public.current_member_id()));
create policy mm_ideas_update on public.ideas for update to anon
  using (group_id = (select public.current_group_id())
         and (member_id = (select public.current_member_id()) or (select public.is_admin())))
  with check (group_id = (select public.current_group_id()));
create policy mm_ideas_delete on public.ideas for delete to anon
  using (group_id = (select public.current_group_id())
         and (member_id = (select public.current_member_id()) or (select public.is_admin())));

create policy mm_idea_likes_select on public.idea_likes for select to anon
  using (group_id = (select public.current_group_id()));
create policy mm_idea_likes_insert on public.idea_likes for insert to anon
  with check (group_id = (select public.current_group_id()) and member_id = (select public.current_member_id()));
create policy mm_idea_likes_delete on public.idea_likes for delete to anon
  using (group_id = (select public.current_group_id()) and member_id = (select public.current_member_id()));

create policy mm_idea_comments_select on public.idea_comments for select to anon
  using (group_id = (select public.current_group_id()));
create policy mm_idea_comments_insert on public.idea_comments for insert to anon
  with check (group_id = (select public.current_group_id()) and member_id = (select public.current_member_id()));
create policy mm_idea_comments_delete on public.idea_comments for delete to anon
  using (group_id = (select public.current_group_id())
         and (member_id = (select public.current_member_id()) or (select public.is_admin())));

-- books (group_book guarded by trigger: admins only, via set_group_book())
create policy mm_books_select on public.books for select to anon
  using (group_id = (select public.current_group_id()));
create policy mm_books_insert on public.books for insert to anon
  with check (group_id = (select public.current_group_id()) and suggested_by = (select public.current_member_id()));
create policy mm_books_update on public.books for update to anon
  using (group_id = (select public.current_group_id())
         and (suggested_by = (select public.current_member_id()) or (select public.is_admin())))
  with check (group_id = (select public.current_group_id()));
create policy mm_books_delete on public.books for delete to anon
  using (group_id = (select public.current_group_id())
         and (suggested_by = (select public.current_member_id()) or (select public.is_admin())));

create policy mm_book_comments_select on public.book_comments for select to anon
  using (group_id = (select public.current_group_id()));
create policy mm_book_comments_insert on public.book_comments for insert to anon
  with check (group_id = (select public.current_group_id()) and member_id = (select public.current_member_id()));
create policy mm_book_comments_delete on public.book_comments for delete to anon
  using (group_id = (select public.current_group_id())
         and (member_id = (select public.current_member_id()) or (select public.is_admin())));

create policy mm_reading_select on public.reading_list for select to anon
  using (group_id = (select public.current_group_id()));
create policy mm_reading_insert on public.reading_list for insert to anon
  with check (group_id = (select public.current_group_id()) and member_id = (select public.current_member_id()));
create policy mm_reading_update on public.reading_list for update to anon
  using (group_id = (select public.current_group_id()) and member_id = (select public.current_member_id()))
  with check (group_id = (select public.current_group_id()));
create policy mm_reading_delete on public.reading_list for delete to anon
  using (group_id = (select public.current_group_id()) and member_id = (select public.current_member_id()));

-- notification prefs and push subscriptions: your own (admins can read prefs)
create policy mm_prefs_select on public.notification_prefs for select to anon
  using (group_id = (select public.current_group_id())
         and (member_id = (select public.current_member_id()) or (select public.is_admin())));
create policy mm_prefs_update on public.notification_prefs for update to anon
  using (member_id = (select public.current_member_id()))
  with check (member_id = (select public.current_member_id()));

create policy mm_push_select on public.push_subscriptions for select to anon
  using (member_id = (select public.current_member_id()));
create policy mm_push_insert on public.push_subscriptions for insert to anon
  with check (member_id = (select public.current_member_id()) and group_id = (select public.current_group_id()));
create policy mm_push_delete on public.push_subscriptions for delete to anon
  using (member_id = (select public.current_member_id()));

-- change feed
create policy mm_activity_select on public.group_activity for select to anon
  using (group_id = (select public.current_group_id()));

-- No policies (service role only): group_invites, sessions, join_attempts,
-- notification_queue, notification_log.
