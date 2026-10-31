-- 0005: contact details, profile setup and admin roster tools.
--
-- Already allowed by policies.sql (checked, unchanged):
--   member_contacts: read by the member and admins only; insert/update by the
--                    member for their own row, or by an admin for anyone in the group.
--   notification_prefs: the member updates their own row (admins can read).
--   members: the member updates their own profile fields; admins anyone's.
--
-- Tightened here: the update policy on member_contacts only pinned group_id
-- in WITH CHECK, so a member could PATCH their own row's member_id to someone
-- else's id. Now the new row must still be yours (or you're an admin).
--
-- Idempotent: safe to run on a project where policies.sql already has this
-- (policies.sql ends with the same statements, for fresh setups).

drop policy if exists mm_contacts_update on public.member_contacts;
create policy mm_contacts_update on public.member_contacts for update to anon
  using (group_id = (select public.current_group_id())
         and (member_id = (select public.current_member_id()) or (select public.is_admin())))
  with check (group_id = (select public.current_group_id())
              and (member_id = (select public.current_member_id()) or (select public.is_admin())));
