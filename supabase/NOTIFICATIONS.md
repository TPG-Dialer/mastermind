# Notifications spec

This is what `schedule-notifications`, the database triggers and `send-notifications` implement. If you change the plan, change it here first.

All times are Central (America/Chicago). Every message also links into the app.

## Pipeline

1. **Queue.** Scheduled reminders are queued by `schedule-notifications`, which runs hourly at :05. Event-driven messages are queued by database triggers the moment something happens. Both go through one SQL function, `enqueue_notification()`, which:
   - applies the member's preferences, the SMS allowlist and the fallbacks below
   - moves the send time out of quiet hours
   - writes one `notification_queue` row per channel
   - dedupes on `dedupe_key`, so queueing the same reminder twice does nothing
2. **Send.** `send-notifications` runs every 5 minutes. It claims due rows and re-checks each one, skipping it if the event moved, was cancelled or already started. Then it sends, bundles event pushes, and records every outcome in `notification_log`. Failures retry up to 3 times, 10 and 20 minutes apart.
3. **Channels.**
   - Email: Resend.
   - SMS: RingCentral.
   - Web push: VAPID.
   - The in-app reminder line on Home stays as it is.

## Scheduled reminders

| Kind | When | Who | Channels | Category |
|---|---|---|---|---|
| `meeting_7d` | 7 days before a meeting | everyone | email + push | meeting |
| `meeting_hotseat_48h` | 48 hours before | hot seat person | SMS + push | meeting |
| `meeting_24h` | 24 hours before | everyone | SMS + push | meeting |
| `meeting_admin_digest` | 24 hours before | admins | email | digest |
| `meeting_1h` | 1 hour before | everyone, The Shoreline only | push + SMS | meeting |
| `meeting_day_after_commitment` | 10 AM the day after | anyone without a commitment for that meeting | push | nudge |
| `meeting_day_after_action_plan` | 10 AM the day after | hot seat person, if no action plan | push | nudge |
| `commitment_2w` | 10 AM, 14 days after | each commitment not done | push | nudge |
| `training_7d` | 7 days before a training | everyone in the group (Flight Club) | email | other |
| `training_24h` | 24 hours before a training | everyone in the group | push | other |
| `gettogether_48h` | 48 hours before | RSVP "yes" plus invitees (not anyone who said no) | push | other |

What the messages contain:
- `meeting_hotseat_48h` says the prep is due in 24 hours, or that it's in.
- `meeting_24h` includes the Zoom link or the address. It adds "Check in before it starts" if the member hasn't checked in, unless they turned nudges off.
- The admin digest lists the headcount, hot seat prep status, who hasn't RSVPed and who hasn't checked in.
- The hot seat person gets the action plan nudge instead of the commitment nudge, because saving the action plan creates their commitment.
- The one-hour reminder is on for The Shoreline through `group_settings.notification_options.oneHourReminder`. Flight Club has it off.

## Event-driven (database triggers)

| Kind | Trigger | Who | Channels |
|---|---|---|---|
| `announcement_new` | new announcement | everyone except the author | push, plus email if marked important (admin) |
| `ask_can_help` | "I can help" reply on your ask | the asker | push |
| `comment_on_post` | comment on your announcement, idea or book, or a plain reply on your ask | the author | push |
| `gettogether_invite` | you're invited to a closed get-together | the invitee | push |
| `schedule_change` | meeting or training time or place changes (admin edit, or a rule change re-timing it) | everyone | SMS + push |
| `notes_ready` | Zoom AI Companion notes land on a meeting (on arrival, or when an admin files unmatched ones) | everyone | push (email if no push) |
| `notes_unmatched` | Zoom notes arrived but didn't match a meeting | admins | push + email |

Notes an admin types in the app don't notify anyone; Home shows "Notes from {meeting}" until each person opens them.

Schedule changes only notify for events in the next 45 days, so re-timing a whole year at once doesn't text everyone twelve times.

## Rules

- **SMS only for:** `meeting_24h`, `meeting_1h` (The Shoreline), `meeting_hotseat_48h` and `schedule_change`. The list lives in `sms_allowed()` in schema.sql. Any other kind never sends SMS.
- **Email fallback:**
  - No push subscription: the push part goes by email, unless SMS is already going out for the same reminder.
  - No phone, or SMS off: the SMS part goes by email, unless push already covers it.
- **Preferences** (`notification_prefs`): `sms`, `email` and `nudges`, all on by default.
  - `nudges = false` drops every nudge.
  - Meeting reminders cannot be turned off. If the toggles would remove every channel, the reminder still goes by push, else email, else SMS (if that kind allows SMS).
  - Push has no toggle. You opt in by allowing notifications on a device, and opt out by turning them off there.
- **Quiet hours:** 9 PM to 7 AM Central. Anything due then waits until 7 AM. For a reminder about an event that starts before 7 AM, it goes at 8:30 PM the evening before instead.
- **Bundling:** event pushes go out at most once per member per hour. The first goes immediately. Any more within the hour wait and go out together as "3 new updates in Flight Club", showing the first three lines.
- **Stale reminders are dropped.** A queued reminder remembers the event's start time. If the event moves or is cancelled, the old reminder is skipped and the new time gets its own reminders on the next hourly run. Pre-event reminders are also skipped once the event has started.
- **Removed members** get nothing. Removing someone deletes their pending queue rows and disables their push subscriptions.

## Testing without accounts

Set the function secret `DRY_RUN=true`. Nothing is sent, and each message is printed to the function's logs. A channel whose credentials aren't set also falls back to dry-run, so you can turn channels on one at a time.

To preview what the hourly job would queue at a given moment, call `schedule-notifications` with `{"now": "2026-11-19T19:05:00-06:00", "dryRun": true}`. Use the `x-cron-secret` header.
