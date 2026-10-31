# Supabase backend

The real backend for the Mastermind app: one Supabase project for both groups (The Shoreline = `family`, Flight Club = `entrepreneur`). The app uses it by default; `?backend=local` runs the old demo on JSON and localStorage.

## What's in this folder

| File | What it is |
|---|---|
| `schema.sql` | Tables, indexes, triggers, and the functions the app calls |
| `policies.sql` | Who can see and change what (row-level security) |
| `seed.sql` | The prototype's sample data. Generated, don't edit by hand |
| `seed/generate.py` | Rebuilds `seed.sql` from `config/*.json` and `data/*.json` |
| `cron.sql` | The schedule: reminders hourly, sending every 5 minutes, meetings monthly |
| `migrations_extra/` | SQL added after the first deploy, one numbered file per change (see below) |
| `functions/join` | Invite code + pick your name + a one-time code by email or text, returns a session |
| `functions/schedule-notifications` | Queues reminders that are coming due |
| `functions/send-notifications` | Sends queued email, SMS and push |
| `functions/generate-meetings` | Keeps 12 months of meetings and trainings on the calendar |
| `functions/zoom-webhook` | Zoom AI Companion summaries -> meeting notes (setup: `ZOOM.md`) |
| `functions/_shared` | Code the functions share (time math, adapters, hashing) |
| `NOTIFICATIONS.md` | The reminder plan these functions implement |
| `ZOOM.md` | Step-by-step: connect Zoom so meeting summaries come in |

Also outside this folder: `../api-supabase.js` (the app's data layer for Supabase) and `../config/supabase.js` (project URL and key).

## How login works (no passwords)

1. A member opens the private link and types the group's invite code.
2. The app calls the `join` function (`roster`). It checks the code against a hash in `group_invites` and returns the roster, plus `smsAvailable` (true when all four RingCentral secrets are set).
3. The member taps their name. `join` (`request-code`) makes a 6-digit code, stores only a salted hash in `login_codes` (10 minutes, 5 tries, one per member), and sends it to the email or phone on file:
   - by email through Resend, from `"<group name> <reminders@EMAIL_FROM_DOMAIN>"` (default domain `tpgmn.com`), subject "<group> sign-in code";
   - or by text through RingCentral: "<group>: your sign-in code is 123456. Expires in 10 minutes."
   With both an email and a phone (and texting set up) it first answers `{ choose: true, options }` and the member picks.
4. The member types the code. `join` (`verify-code`) checks it with `verify_login_code()` (row lock, counts tries, deletes the code on success), then creates a row in `sessions` and gives the phone a long random token. Only the token's hash is stored.
5. Every request to the database sends that token in an `x-session-token` header.
6. Supabase's API (PostgREST) makes request headers readable inside Postgres. The function `current_member_id()` hashes the token, looks it up in `sessions` and returns the member. Every security rule in `policies.sql` is written in terms of `current_member_id()`, `current_group_id()` and `is_admin()`. A session that hasn't been used for 180 days stops working (the app touches it each time it opens).

First sign-in on trust, locked afterwards (admins and members alike; there is no code-free sign-in):
- **No email or phone on file:** `request-code` answers `{ enroll: true }` and the app shows "First time here?": email (required) and mobile (optional). The app calls `request-code` again with `selfContact: { email, phone }`. The code goes to that email (or by text when the member asks for it, gave a phone and texting is set up). The typed contact is held only in `login_codes.pending_email` / `pending_phone`.
- **Right code:** `verify_login_code()` saves that contact to `member_contacts` (only if the member still has none; otherwise 409 `contact_exists` and no session), makes sure the reminder toggles row exists, sets `members.enrolled_at = now()`, `enrolled_by = 'self'`, and queues `self_enrolled` to the group's other admins: "{Name} signed in for the first time using c•••y@gmail.com. If that's not them, open Members and reset their sign-in." (push, email when there's no push). Logged as `join_attempts.kind = 'self_enroll'`.
- **From then on** codes go only to the contact on file. `selfContact` for a member who has one is refused (409 `contact_exists`), so nobody can redirect someone else's code from the sign-in screen. The member can still change their email and phone in Profile once signed in (they can't clear both).
- **Admin reset:** Group > Members > a member > Reset sign-in (`admin_reset_member_signin()`, admins of that group, not yourself) removes the member's email and phone and any pending code, signs them out on every device, disables their push and drops their pending reminders. Their next sign-in is a first sign-in again. Members' rows show "Enrolled Oct 31, 2026 (self)" or "(admin)" to admins; contacts an admin enters count as `admin`.
- If the only admin is the one signing in for the first time, nobody gets the notice. Enter the first admin's email in the database (or another admin's) before handing out the invite if you want one.
- Phone only on file while texting isn't set up: 409 "Texting isn't set up yet. Ask your admin to add your email."

Other failures:
- **Sending fails or is in dry-run:** the code is thrown away and the app shows "We couldn't send the code; ask your admin." with the reason. Exception: with the secret `DEV_SHOW_CODES=true`, a dry-run code is returned to the app (`devCode`) and shown on screen, for testing before email is live.
- **Sign-in codes ignore `DRY_RUN`.** A channel with credentials sends codes even while reminders are still in dry-run, because a code that is never delivered locks the member out.
- **Rate limits** (`join_attempts`, by `kind`), the same for first sign-ins: 10 wrong invite codes per IP per 15 minutes; 5 codes per member and 15 per IP per hour; resend after 30 seconds to the same place (switching email/text, or correcting the typed email on a first sign-in, is allowed right away); 15 wrong codes per IP per 15 minutes; 5 wrong tries per code.

Why a header and not a token passed to every function: with the header, the app can read and write tables directly (filters, joins, upserts) and the database still knows who's asking on every row. Passing the token as a function argument would mean writing a database function for every screen.

No token, a revoked token, or a removed member means `current_member_id()` is empty, and every rule says no.

Sign out, a removed member, Reset sign-in and a rotated code with "sign everyone out" all revoke sessions instantly.

## Setup

You need the Supabase project (your existing account is fine), Node.js on your computer, and this repo. Commands below work in Windows PowerShell; `npx supabase` downloads the Supabase command-line tool the first time.

1. **Create the project.** In supabase.com, go to New project. Name it "mastermind", pick a strong database password and save it, and choose region **Central US** (closest to both groups).

2. **Note two values.** In Project Settings > API, copy:
   - the **Project URL** (`https://abcd1234.supabase.co`). The part before `.supabase.co` is your **project ref**.
   - the **anon** key, or the **publishable** key if the project shows the new API Keys page.

3. **Create the tables.** Open SQL Editor > New query, paste all of `schema.sql`, then Run. You should see "Success. No rows returned".

4. **Turn on the security rules.** New query, paste `policies.sql`, Run.

5. **Load the sample data** (optional, for testing). New query, paste `seed.sql`, Run.
   - This loads both groups' settings, the demo invite codes (`FAMILY2026`, `FOUNDERS2026`) and the fake members and history.
   - Re-running it wipes both groups and reloads the samples, so don't run it once real members are in.
   - Without sample data you still need the two groups. See "Starting with the real roster" below.

6. **Log in to the command-line tool.** In a terminal in the `mastermind` folder:
   ```
   npx supabase login
   ```

7. **Deploy the functions.** Replace `YOUR-REF` with your project ref:
   ```
   npx supabase functions deploy join --project-ref YOUR-REF --no-verify-jwt
   npx supabase functions deploy schedule-notifications --project-ref YOUR-REF --no-verify-jwt
   npx supabase functions deploy send-notifications --project-ref YOUR-REF --no-verify-jwt
   npx supabase functions deploy generate-meetings --project-ref YOUR-REF --no-verify-jwt
   npx supabase functions deploy zoom-webhook --project-ref YOUR-REF --no-verify-jwt
   ```
   `--no-verify-jwt` is on purpose. `join` is the public front door. `zoom-webhook` checks Zoom's signature. The other three check their own `CRON_SECRET`.

8. **Set the function secrets.** Make up a long random `CRON_SECRET`, for example from a password manager, 40+ characters.
   ```
   npx supabase secrets set --project-ref YOUR-REF CRON_SECRET=your-long-random-string DRY_RUN=true APP_URL=https://YOUR-GITHUB-USER.github.io/mastermind/ ALLOWED_ORIGINS=https://YOUR-GITHUB-USER.github.io,http://localhost:8000
   ```
   `DRY_RUN=true` means no reminders are actually sent yet; messages are written to the function logs (Edge Functions > send-notifications > Logs). Remove it when you're ready (step 13).
   The deploy workflow also sets `DEV_SHOW_CODES=true`: until email is set up, sign-in codes are shown in the app instead of sent. **Remove it at launch:** delete the `DEV_SHOW_CODES=true` line from `.github/workflows/supabase-deploy.yml`, then run `npx supabase secrets unset --project-ref YOUR-REF DEV_SHOW_CODES` (setting secrets never removes old ones).

9. **Turn on the schedule.**
   - Open `cron.sql`. In step 1, replace the project URL and paste the same `CRON_SECRET`.
   - Paste the whole file into the SQL Editor and Run.
   - It turns on the `pg_cron` and `pg_net` extensions, stores both values in Supabase Vault, and creates four jobs.
   - Check them with: `select jobname, schedule from cron.job;`

10. **Fill the calendar.** Generate 12 months of meetings (and Flight Club trainings) from each group's rule now, instead of waiting for the 1st of the month. In the SQL Editor:
    ```sql
    select public.mm_call_function('generate-meetings');
    ```
    Then `select id, title, starts_at from meetings order by starts_at;`.
    - The sample meetings already cover Nov to Jan, so generated ones start in February.
    - The Shoreline's sample meetings are still on the old placeholder Sundays at 3 PM. To move future sample meetings onto the 3rd-Wednesday rule, use `select public.mm_call_function('generate-meetings', '{"reflow": true}');`.

11. **Point the app at the project.** In `config/supabase.js`, set `url` and `anonKey` to the two values from step 2. Both are safe to publish: the key only allows what the security rules allow, and the rules require a session.

12. **Swap the app over.** See "Switching the app to Supabase" below.

13. **Turn on real sending, one channel at a time.** A channel with no credentials stays in dry-run, so you can do email first.
    - **Email (Resend).** Create an account at resend.com and verify a sending domain (your own domain works). Then:
      `npx supabase secrets set --project-ref YOUR-REF RESEND_API_KEY=re_... "EMAIL_FROM=Flight Club <reminders@yourdomain.com>"`
      Sign-in codes start going out as soon as `RESEND_API_KEY` is set (they don't wait for `DRY_RUN` to be removed). They come from `"The Shoreline <reminders@tpgmn.com>"` / `"Flight Club <reminders@tpgmn.com>"`: the group's name plus `reminders@` and `EMAIL_FROM_DOMAIN` (optional secret, default `tpgmn.com`, which must be the domain verified in Resend). Then remove `DEV_SHOW_CODES` (step 8).
    - **SMS (RingCentral).**
      1. In developers.ringcentral.com, create a REST API app with JWT auth and the SMS scope.
      2. Create a JWT credential for your user.
      3. Register your number for business texting (10DLC). Carriers block unregistered app texting.
      4. Set the secrets:
         `npx supabase secrets set --project-ref YOUR-REF RINGCENTRAL_CLIENT_ID=... RINGCENTRAL_CLIENT_SECRET=... RINGCENTRAL_JWT=... RINGCENTRAL_FROM_NUMBER=+1512...`
    - **Push.**
      1. Run `npx web-push generate-vapid-keys` once.
      2. Set the keys:
         `npx supabase secrets set --project-ref YOUR-REF VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:you@yourdomain.com`
      3. Put the public key in `config/supabase.js` as `vapidPublicKey`.
    - Then remove dry-run: `npx supabase secrets unset --project-ref YOUR-REF DRY_RUN`.

## Everyday admin tasks (SQL Editor)

The app now does the common ones for admins: Group > Members > Add a member, New invite code, and on a member's page, their contact details and Remove from the group. These SQL one-liners still work and cover the rest.

**Set or change an invite code.** The old code stops working at once; people already signed in stay signed in.
```sql
update group_invites set revoked_at = now() where group_id = 'family' and revoked_at is null;
insert into group_invites (group_id, code_hash, code_hint)
values ('family', hash_invite_code('family', 'SHORE-7K3Q'), '3Q');
```
Codes aren't case sensitive. To also sign everyone out, add:
`update sessions set revoked_at = now() where group_id = 'family' and revoked_at is null;`

**Add a member.** Phone in +1 format, or leave it null. The group can have at most 2 admins.
```sql
with m as (
  insert into members (group_id, name, role, sort_order)
  values ('family', 'Jane Doe', 'member', 11) returning id, group_id)
insert into member_contacts (member_id, group_id, email, phone)
select id, group_id, 'jane@example.com', '+15125550123' from m;
```

**Remove a member.** Soft delete: history stays, sessions end, future hot seats are freed.
```sql
update members set removed_at = now() where id = 'm10';
update sessions set revoked_at = now() where member_id = 'm10' and revoked_at is null;
update meetings set hot_seat_member_id = null, hot_seat_prep = null where hot_seat_member_id = 'm10' and starts_at > now();
```

**Change the meeting rule** (day/time). Then re-time future meetings nobody moved by hand:
```sql
update group_settings set meeting_rule = '{"nth":3,"weekday":3,"start":"19:30","durationMinutes":60,"titleTemplate":"{month} Shoreline"}'
where group_id = 'family';
select public.mm_call_function('generate-meetings', '{"reflow": true}');
```
`weekday` is 1 = Monday to 7 = Sunday; `nth` 3 = third, -1 = last.

**See what's been sent:** `select created_at, member_id, kind, channel, status, error from notification_log order by id desc limit 50;`

## Starting with the real roster

When Corey sends the rosters, wipe the samples for that group but keep its settings:
```sql
begin;
set local mm.seeding = 'on';            -- no notifications while cleaning up
delete from meetings  where group_id = 'family';
delete from trainings where group_id = 'family';
delete from members   where group_id = 'family';  -- also removes their posts, commitments, RSVPs...
commit;
```
Then:
1. Add the real members as above.
2. Set a new invite code.
3. Run `generate-meetings`.
4. `config/<group>.json` no longer has the invite code or the Zoom link (it's public on GitHub Pages; the database copy is the private one). Keep it that way. Set the real Zoom link in the app: Profile > Meeting location.

To start without `seed.sql` at all, run `python3 supabase/seed/generate.py` after editing the JSON, or ask Fable for a settings-only seed.

## Changing the database after the first deploy

The deploy workflow (`.github/workflows/supabase-deploy.yml`) turns `schema.sql`, `policies.sql`, `seed.sql` and `cron.sql` into four migrations. Those have already run on the live project, and `supabase db push` never re-runs a migration, so editing those files alone changes nothing there.

For a change:
1. Add `supabase/migrations_extra/NNNN_what.sql` with the next number (`0005`, `0006`, ...). Make it safe to run twice (`create or replace`, `drop policy if exists`, `if not exists`). The workflow copies it to `migrations/20261031000NNN_what.sql`, after the original four.
2. Also append the same SQL to `schema.sql` or `policies.sql`, so a fresh setup from those files ends up the same.

`0005_contacts_admin.sql`: the update rule on `member_contacts` now also checks the new row, so a member can't move their contact row to another member's id. Everything else the profile setup and admin screens need was already allowed: members read and write their own contact row, admins read and write anyone's in their group, members update their own reminder toggles and profile.

`0007_login_verification.sql`: sign-in codes. Adds `login_codes` (service role only, no policies), `member_id` and `kind` columns on `join_attempts` for per-member and per-IP limits, `login_contact()` (a member's email/phone) and `verify_login_code()` (both service role only), the 180-day limit in `current_member_id()`, and an hourly cron job `mm-login-codes-cleanup` that deletes expired codes (and sessions unused for 270 days). `schema.sql` and `cron.sql` have the same changes for fresh setups.

`0008_meeting_notes.sql`: meeting notes. Adds `meeting_notes` (one `manual` and one `zoom` note per meeting; `raw` keeps the Zoom payload and isn't readable by the app; unattached Zoom notes are admins-only), `group_settings.zoom_meeting_id` (filled by `set_group_location()` from `/j/<digits>` in the Zoom link, and backfilled from a saved link), `ingest_zoom_summary()` (service role only: matches a summary to the group and to the meeting starting within 6 hours, upserts the note, assigns next steps that start with a member's name), and triggers that queue `notes_ready` (group) and `notes_unmatched` (admins). Admins write manual notes and edit any note's summary, points, steps and meeting; a Zoom note keeps its title. `schema.sql` and `policies.sql` end with the same statements.

`0009_self_enroll.sql`: first sign-in on trust, replacing 0007's code-free "bootstrap" join. Adds `members.enrolled_at` / `enrolled_by` (`self` | `admin`; backfilled as `admin` for contacts already on file, kept in step by a trigger on `member_contacts`), `login_codes.pending_email` / `pending_phone`, `complete_self_enrollment()` (service role only; called by `verify_login_code()`, which now also saves a first sign-in's contact and queues the `self_enrolled` notice), `mask_email()` / `mask_phone()`, and `admin_reset_member_signin()` (the app may call it; it checks admin and group itself). `login_contact()` no longer reports whether anyone in the group has a contact. Deploy the `join` function together with it. `schema.sql` and `policies.sql` end with the same statements.

The `zoom-webhook` function (deployed with `--no-verify-jwt`; Zoom's signature is the check) needs `ZOOM_WEBHOOK_SECRET_TOKEN`, and `ZOOM_ACCOUNT_ID` / `ZOOM_CLIENT_ID` / `ZOOM_CLIENT_SECRET` when a webhook arrives without the summary in it. The deploy workflow sets all four from GitHub secrets (empty is fine until Zoom is set up). Steps for Corey: `ZOOM.md`.

`0006_real_rosters.sql`: replaces the sample data in both groups with the real rosters (ids like `fam-corey`, `fc-jeffrey`; sort order = hot seat order), sets the real meeting rules and usual places, the Flight Club training rule, and new invite codes, then calls `generate-meetings`. Each group is reset only once (it skips a group that already has its `fam-corey` / `fc-corey` member), so running it again never wipes real data. `seed.sql` is still the sample data for a fresh test setup.

## Switching the app to Supabase (done)

Done on 2026-10-31. For the record, these were the steps:

1. **index.html.** Add one line just above `<script src="app.js"></script>`:
   ```html
   <script src="config/supabase.js"></script><script src="api-supabase.js"></script>
   ```
2. **app.js, line 34.** Let a provided api win:
   `const api = window.MASTERMIND_API || (function () {`
3. **app.js, the login screens.** The invite code is now checked by the server, so three handlers change:
   - Invite form (`renderInvite`): make the submit handler `async`. Replace the `cfg.inviteCode` comparison with
     `try { state.members = await api.verifyInvite(code); } catch (e) { return renderInvite(e.message); }`
     before `renderWho()`.
   - Name tap (`renderWho`): make the click handler `async`. Before `store.set('user', ...)`, call
     `await api.join(b.dataset.member); state.config = await api.getConfig(); await loadData();`
   - Switch user and "Not you?": call `api.signOut()`, then show the invite screen. Signing in as someone else needs the code again.
4. **Rules.** Optional, keeps agreement on the server: in the "I agree" handler also call `api.acceptRules(state.config.rulesVersion)`.
5. **Live updates.**
   - Add `window.addEventListener('mastermind:remote-change', async () => { await refresh(); rerender(); })`. Skip it while a sheet is open, like the 30-second timer does.
   - Add `window.addEventListener('mastermind:sync-error', (e) => toast("Couldn't save: " + e.detail.message))`.
6. **sw.js.** Add a `push` handler that shows `event.data.json()` with `self.registration.showNotification(title, { body, data: { url } })`. Add a `notificationclick` handler that opens `data.url`. Add both new files to the cache list and bump `VERSION`.

`resetDemo` becomes harmless in Supabase mode: it only clears the phone's cached copy. The button is hidden when `api.backend === 'supabase'`.

Beyond those steps, the app also: shows a profile setup screen after the rules when email or phone is missing (`updateMyContact`, `updateNotificationPrefs`, `updateMyProfile`), has the admin roster tools in Members, keeps a cached copy for offline use, and turns every failed call into a toast instead of a broken screen. See the main README, "Supabase backend".

## Testing a fresh setup

In the browser console on the app (not with `?backend=local`, which leaves `MASTERMIND_API` unset):
```js
await MASTERMIND_API.verifyInvite('FAMILY2026')   // roster
await MASTERMIND_API.requestCode('m3')            // { sent, channel, maskedTo, ... } (devCode with DEV_SHOW_CODES)
await MASTERMIND_API.verifyCode('m3', '123456')   // the code from the email (or devCode)
await MASTERMIND_API.getSession()                 // { memberId: 'm3', ... }
(await MASTERMIND_API.getGetTogethers()).length   // Jake hosts the closed one, so 4
```
A member with no email or phone gets `{ enroll: true }`; then `await MASTERMIND_API.requestCode('m3', null, { email: 'you@example.com' })` and `verifyCode` as above (the answer has `enrolled: true`).
If `getSession()` returns null right after `verifyCode`, the `x-session-token` header isn't reaching the database. Check that the project URL is right and that the request in the Network tab carries the header.

Preview the next reminders without sending (PowerShell; use `curl.exe`, not the `curl` alias):
```
curl.exe -X POST https://YOUR-REF.supabase.co/functions/v1/schedule-notifications -H "x-cron-secret: YOUR-SECRET" -H "Content-Type: application/json" -d "{\"now\":\"2026-11-19T19:05:00-06:00\",\"dryRun\":true}"
```

## Notes and limits

- **Realtime.**
  - Live updates use Supabase Realtime "broadcast" pings that only say which table changed, never what's in it. The app then refetches through the normal security rules.
  - The channel name comes from `group_settings.realtime_key`, which only signed-in members can read.
  - Supabase's row-level realtime (`postgres_changes`) isn't used, because it needs Supabase Auth logins.
  - If Realtime can't connect, the app polls `group_activity` every 30 seconds.
- **Removed members** don't come back from `getMembers()`. Their old posts show as "Unassigned" until the screens learn about removed members.
- **Push on iPhone** only works after the app is added to the Home Screen (iOS 16.4+).
- **Edge Function imports** pin `npm:@supabase/supabase-js@2.45.4` and `npm:web-push@3.6.7`. If `web-push` won't run in the Edge runtime, `_shared/adapters.ts` says what to swap in.
