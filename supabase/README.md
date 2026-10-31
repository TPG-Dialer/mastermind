# Supabase backend

The real backend for the Mastermind app: one Supabase project for both groups (The Shoreline = `family`, Flight Club = `entrepreneur`). Nothing here changes the prototype. It keeps running on JSON and localStorage until the swap described at the end.

## What's in this folder

| File | What it is |
|---|---|
| `schema.sql` | Tables, indexes, triggers, and the functions the app calls |
| `policies.sql` | Who can see and change what (row-level security) |
| `seed.sql` | The prototype's sample data. Generated, don't edit by hand |
| `seed/generate.py` | Rebuilds `seed.sql` from `config/*.json` and `data/*.json` |
| `cron.sql` | The schedule: reminders hourly, sending every 5 minutes, meetings monthly |
| `functions/join` | Invite code + pick your name, returns a session |
| `functions/schedule-notifications` | Queues reminders that are coming due |
| `functions/send-notifications` | Sends queued email, SMS and push |
| `functions/generate-meetings` | Keeps 12 months of meetings and trainings on the calendar |
| `functions/_shared` | Code the functions share (time math, adapters, hashing) |
| `NOTIFICATIONS.md` | The reminder plan these functions implement |

Also outside this folder: `../api-supabase.js` (the app's data layer for Supabase) and `../config/supabase.js` (project URL and key).

## How login works (no passwords)

1. A member opens the private link and types the group's invite code.
2. The app calls the `join` function. It checks the code against a hash in `group_invites` and returns the roster.
3. The member taps their name. `join` creates a row in `sessions` and gives the phone a long random token. Only the token's hash is stored.
4. Every request to the database sends that token in an `x-session-token` header.
5. Supabase's API (PostgREST) makes request headers readable inside Postgres. The function `current_member_id()` hashes the token, looks it up in `sessions` and returns the member. Every security rule in `policies.sql` is written in terms of `current_member_id()`, `current_group_id()` and `is_admin()`.

Why a header and not a token passed to every function: with the header, the app can read and write tables directly (filters, joins, upserts) and the database still knows who's asking on every row. Passing the token as a function argument would mean writing a database function for every screen.

No token, a revoked token, or a removed member means `current_member_id()` is empty, and every rule says no.

Sign out, a removed member and a rotated code with "sign everyone out" all revoke sessions instantly.

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

7. **Deploy the four functions.** Replace `YOUR-REF` with your project ref:
   ```
   npx supabase functions deploy join --project-ref YOUR-REF --no-verify-jwt
   npx supabase functions deploy schedule-notifications --project-ref YOUR-REF --no-verify-jwt
   npx supabase functions deploy send-notifications --project-ref YOUR-REF --no-verify-jwt
   npx supabase functions deploy generate-meetings --project-ref YOUR-REF --no-verify-jwt
   ```
   `--no-verify-jwt` is on purpose. `join` is the public front door. The other three check their own `CRON_SECRET`.

8. **Set the function secrets.** Make up a long random `CRON_SECRET`, for example from a password manager, 40+ characters.
   ```
   npx supabase secrets set --project-ref YOUR-REF CRON_SECRET=your-long-random-string DRY_RUN=true APP_URL=https://YOUR-GITHUB-USER.github.io/mastermind/ ALLOWED_ORIGINS=https://YOUR-GITHUB-USER.github.io,http://localhost:8000
   ```
   `DRY_RUN=true` means nothing is actually sent yet; messages are written to the function logs (Edge Functions > send-notifications > Logs). Remove it when you're ready (step 13).

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

Until the admin screens are built, these are one-liners. Every app-side function (`admin_*`) also exists in `api-supabase.js` for when the screens come.

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
4. Remove `inviteCode` and the Zoom link from `config/<group>.json`. That file is public on GitHub Pages; the database copy is the private one.

To start without `seed.sql` at all, run `python3 supabase/seed/generate.py` after editing the JSON, or ask Fable for a settings-only seed.

## Switching the app to Supabase

This hasn't been done yet; the prototype still uses `api` in `app.js`. When it's time:

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

`resetDemo` becomes harmless in Supabase mode: it only clears the phone's cached copy. Hide that button when `api.backend === 'supabase'`.

## Testing a fresh setup

In the browser console on the app, after step 11:
```js
await MASTERMIND_API.verifyInvite('FAMILY2026')   // roster
await MASTERMIND_API.join('m3')                   // Jake
await MASTERMIND_API.getSession()                 // { memberId: 'm3', ... }
(await MASTERMIND_API.getGetTogethers()).length   // Jake hosts the closed one, so 4
```
If `getSession()` returns null right after `join`, the `x-session-token` header isn't reaching the database. Check that the project URL is right and that the request in the Network tab carries the header.

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
