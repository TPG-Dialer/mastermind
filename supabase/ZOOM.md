# Zoom meeting notes (The Shoreline)

After each Shoreline call, Zoom's AI Companion writes a meeting summary. These steps send that summary into the app automatically. It shows up under the meeting in **Meetings** with a small "From Zoom AI Companion" label, and everyone gets a "Notes from November Shoreline are in" notification.

It takes about 15 minutes. You need your Zoom Pro account and access to the GitHub repo's settings.

## A. Turn on AI Companion summaries in Zoom

1. Sign in at **zoom.us**, then open **Settings** (left menu).
2. Open the **AI Companion** tab.
3. Turn on **Meeting summary with AI Companion**.
4. Under it, turn on **Automatically start meeting summary** (it may be called "Auto-start") so you don't have to press anything during the call.
5. Click **Save** if Zoom asks.

## B. Make the "Mastermind notes" app in Zoom

1. Go to **marketplace.zoom.us** and sign in with the same Zoom account.
2. Top right, click **Develop**, then **Build App**.
3. Pick **Server-to-Server OAuth App** and click **Create**.
4. Name it **Mastermind notes** and click **Create**.
5. On the **App Credentials** page, copy these three values into a note for now:
   - **Account ID**
   - **Client ID**
   - **Client Secret**
6. Click **Continue** and fill in the **Information** page (app name is already there; add your name and email as the developer contact). Click **Continue**.
7. On the **Feature** page, turn on **Event Subscriptions**, then click **Add Event Subscription**:
   1. Subscription name: **Meeting notes**.
   2. Event notification endpoint URL:
      `https://reqfsulfmmrzkzsqthvv.supabase.co/functions/v1/zoom-webhook`
   3. Click **Add Events**. Under **Meeting** (in some accounts it's under **AI Companion**), tick **Meeting summary completed**. Click **Done**.
   4. Copy the **Secret Token** shown on this page into your note too.
   5. Don't click Validate yet. Do part C first, then come back for step 8.
8. On the **Scopes** page, click **Add Scopes** and add **`meeting:read:summary:admin`** (search "summary"). If Zoom says the summary needs it, also add **`meeting:read:meeting:admin`**. Click **Done**, then **Continue**.

## C. Give the app the four values (GitHub secrets)

1. Open **github.com/TPG-Dialer/mastermind**, then **Settings** > **Secrets and variables** > **Actions**.
2. Click **New repository secret** four times, one for each:

   | Name | Value |
   |---|---|
   | `ZOOM_WEBHOOK_SECRET_TOKEN` | the Secret Token (B 7.4) |
   | `ZOOM_ACCOUNT_ID` | the Account ID |
   | `ZOOM_CLIENT_ID` | the Client ID |
   | `ZOOM_CLIENT_SECRET` | the Client Secret |

   Paste just the value. Extra spaces or line breaks are fine; the deploy removes them.
3. Open the **Actions** tab, pick **Deploy to Supabase**, click **Run workflow**, then **Run workflow** again. Wait for the green check (about 2 minutes).

## D. Finish in Zoom

1. Back in the Zoom Marketplace app (**Manage** > **Mastermind notes** > **Feature**), click **Validate** next to the endpoint URL. It should say **Validated**. If it doesn't, wait a minute for the deploy to finish and try again.
2. Click **Save**, then go to the **Activation** page and click **Activate your app**.

## E. Tell the app which Zoom meeting is The Shoreline's

1. Open The Shoreline app, tap your avatar (top right) > **Meeting location**.
2. Paste the recurring Zoom link (the one with `/j/` and numbers, for example `https://us06web.zoom.us/j/85123456789?pwd=...`).
3. Under the link it should say **"Zoom meeting ID 851 2345 6789. AI Companion notes from this meeting come into the app."** Tap **Save location**.

That's it. After the next call, give Zoom a few minutes to finish the summary; the notes appear under that month's meeting.

## Good to know

- **Only The Shoreline's meeting comes in.** Summaries from your other Zoom calls are ignored and nothing is stored.
- **Matching:** a summary is put on the Shoreline meeting that starts within 6 hours of the Zoom call. If you run an extra call on another day, the notes wait under **Meetings > Zoom notes to file** (you get an email or push saying "Zoom notes arrived but didn't match a meeting"). Tap it, pick the meeting, and the group is notified then.
- **Editing:** admins can tap **Edit** on the Zoom notes to fix the summary, key points or next steps, and **Assign** a next step to someone. Zoom's original stays saved on the server. If Zoom re-sends the summary later, your edits are kept.
- **Next steps:** a step that starts with someone's name ("Faith will...", "Corey: ...") is assigned to them automatically. Whoever a step is assigned to (or anyone, if it's open) can tap **Make this my commitment**.
- **If notes don't show up:** in Supabase, open **Edge Functions > zoom-webhook > Logs**. "ignored" means the meeting ID in the app doesn't match the call (redo part E). "credentials not set" means a secret is missing (part C). "meeting_summary 404" means Zoom hadn't made a summary for that call (check part A).

