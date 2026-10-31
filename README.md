# Mastermind app (prototype)

Clickable prototype of a mobile web app (PWA) for two mastermind groups. Plain HTML, CSS and JavaScript. No build step.

## Run locally

```
cd mastermind
python3 -m http.server 8000
```

Open:
- The Shoreline (family) group: http://localhost:8000/?group=family
- Flight Club (entrepreneur) group: http://localhost:8000/?group=entrepreneur

It must be served over http(s). Opening `index.html` directly from disk will not load the data files.

On GitHub Pages, push this folder and open `https://<user>.github.io/<repo>/?group=family`.

## Demo logins

| Group | Invite code | Admin (first in list) | Hot seat on next meeting |
|---|---|---|---|
| The Shoreline | `FAMILY2026` | Mark Ellison | Emily Ellison (Nov 8) |
| Flight Club | `FOUNDERS2026` | Rachel Kim | Dana Whitfield (Nov 20) |

The first time each person opens the app on a device, they agree to the group's ground rules (from `rules` in the config).

Pick the admin to edit agendas, meetings, the hot seat rotation and anyone's commitments or goals, see the meeting headcount, pin announcements and set the group book. Tap the avatar (top right) > Switch user to try a regular member. Daniel Ruiz (family) and Luis Ortega (Flight Club) had the last hot seat.

## Screens

Five tabs. Home answers "what do I need to do before the next meeting?"; everything else is one tap away.

- **Home**: reminder line, next meeting (countdown, where, Add to calendar, Agenda, and Join Zoom for Zoom meetings), then a to-do list that empties as you finish: "Going?" (meeting RSVP), check-in, hot seat prep (if it's your turn), action plan (if you had the last hot seat), update your commitment. When nothing is due: "You're all set for Nov 8". Below: your record, open asks, who's on the hot seat, new announcements since you last opened the list, the next get-together, and the group book.
- **Meetings**: list of meetings, with upcoming get-togethers as a lighter list under them; tap a meeting for where it is (Zoom link with Join and Copy, or the address), RSVP (admin also sees a headcount), agenda, check-ins ("7 of 10 checked in"; admin sees who's missing), hot seat, attendance. Notes are a placeholder.
- **Track**: Commitments / Goals / Scoreboard switch at the top.
- **Hot Seat**: next person and their prep (form if it's you), rotation (admin moves people up/down), past hot seats with action plans.
- **Group**:
  - Asks: optional "what kind of help" (`needs`); the ask shows "People whose genius fits".
  - Announcements: anyone posts, admin can pin. Pinned first, then newest. Comments.
  - Members: Team map (Working Genius grid with a callout for any type nobody has), then the roster with genius letters. Tap a person for bio, focus, what they can help with and their Working Genius.
  - Get-togethers: coffee, lunches, visits. Open ones are visible to everyone; invite-only ones only to the host, invitees and admins. RSVP, add to calendar, host edits or cancels.
  - Books: group book on top, all books with want/reading/finished counts, "My list" filter. Book detail: why, your status, who's at each stage, comments.
  - Ideas: ideas, links, tools, articles, podcasts. Filter by type, like, comment. Links open in a new tab.
  - Rules: the ground rules to reread.
- **Profile** (avatar in top bar): edit what you do, focus and what you can help with; enter Working Genius results (link to workinggenius.com, the app doesn't run the assessment); switch user, switch group, reset demo data. Admins also get Group settings > Meeting location (the group's usual place).

## Meeting location

Each group has a usual place in its config (`location`), and any meeting can be different.

- The Shoreline: Zoom. The link in `config/family.json` is a **placeholder** (`https://zoom.us/j/0000000000?pwd=PLACEHOLDER`). Replace it with the real recurring meeting link (or set it in the app: Profile > Meeting location).
- Flight Club: in person, address "Location shared in announcements" (**placeholder** until there's a real address).
- Sample override: December Shoreline is in person at "Mark & Linda's house".

Where it shows:
- Home hero: one line under the time (camera icon + "Zoom", or pin + address). Zoom meetings get a "Join Zoom" button on its own row. From 15 minutes before the start until 30 minutes after the end, Join Zoom becomes the filled gold button and moves to the top; Add to calendar becomes outlined. During that window the hero stays on the current meeting ("Starting soon", "Happening now", "Just ended") instead of jumping to next month.
- Reminder line on Home: from 15 minutes before a Zoom meeting until it ends it reads "Starting soon · Join Zoom" (then "Happening now · Join Zoom"); tapping it opens the link.
- Meeting detail: a Where card with the place, a copy button (Zoom link or address), Join Zoom for Zoom meetings, and "Just this meeting. Usually ..." when a meeting differs from the group's usual place.
- Calendar file: LOCATION is the Zoom link or the address; Zoom meetings start the description with "Join: <link>".
- Admin, Edit meeting: Location section with a "Use group default" switch. Turn it off to pick Zoom or In person and enter the link or address; turn it back on to clear the meeting's own location.
- Admin, Profile > Meeting location: changes the group's usual place. Saved on this device like other edits; Reset demo data puts the config value back.

Home re-checks every 30 seconds and redraws when the join window opens or closes (not while a sheet is open or you're typing).

## Switching groups

- Change the URL: `?group=family` or `?group=entrepreneur` (default is family), or set `window.MASTERMIND_GROUP` before `app.js` loads.
- Or Profile > Switch group.

Each group has its own saved login and data on the device.

## Files

- `index.html`, `styles.css`, `app.js` – the app.
- `config/<group>.json` – name, subtitle, tagline, `verse` (short, full, ref), `dedication` (family), `nextLabel` (hero eyebrow), `enterLabel` (invite button), colors (primary, accent, background, text, surface, muted, rule, secondary, good, goodBg), logo (`logoMask` for Flight Club, `logoSvg` for The Shoreline, `logoText` fallback), meeting length, `location` (usual meeting place, see Meeting location), invite code, Google Sheet ID, `rules` (list of short ground rules).
- `data/<group>.json` – sample data, shaped like the future Google Sheet tabs (see below).
- `manifest.webmanifest` (The Shoreline), `manifest-entrepreneur.webmanifest` (Flight Club) – home-screen install info per group.
- `sw.js` – offline cache. Bump `VERSION` in it when files change.

## Maker credit

Every screen after login ends with a small "Built by TPG" link and the TPG hexagon mark (`brand/tpg-mark-mask.png`), not on the invite, roster or rules screens. Label and link come from `credit` in each `config/<group>.json`. The URL `https://PLACEHOLDER-tpg-website` is a **placeholder**: replace it with the real TPG website.
- `icons/` – app icons. Flight Club: cream logo on navy, made from the logo mask (`python3 icons/make_icons.py`, needs Pillow; it now skips the family icons). The Shoreline: green square, cream mark, gold dotted ring, rendered from the logo SVG (see Brand files).
- `brand/` – logo artwork and the approved reference pages (see Brand files).
- `shots/` – screenshots at 375x812. `loc-<group>-<screen>.png` show the meeting location feature (`loc-family-08`–`10` are taken with the clock moved to just before, during and after the Nov 8 meeting). `final-<group>-<screen>.png` are the current design for both groups (taken with Google Fonts blocked, so headings show in fallback faces; real fonts render narrower).

Meetings: Flight Club meets the 3rd Friday, 7:00-9:00 AM Central (120 min). The Shoreline meets 3:00-4:00 PM Central (60 min; day and time are placeholders).

## Look

Both groups share one structure (gate screens, brand bar, hero, designed page headers) and each has its own identity. Group styles are scoped in `styles.css`: `[data-group="entrepreneur"]` (Flight Club), `[data-group="family"]` (The Shoreline), then a shared "Designed pages" block that both use through their own tokens.

**The Shoreline (family).** Name "The Shoreline", subtitle "Family Mastermind". Verse: Psalm 139:10 ("Even there your hand will guide me, your right hand will hold me fast."). Dedication on the invite screen: "In loving memory of Marie & Shane". Invite button: "Cast off". Hero eyebrow: "Next gathering".

| Token | Hex | Use |
|---|---|---|
| Palm green | `#1F4D3A` | primary, ink, hero and gate backgrounds |
| Sand | `#F4EFE2` | page background, text on green |
| Paper | `#FFFDF6` | cards, brand bar, tab bar |
| Sunlit gold | `#E0A458` | the one next thing, hairlines, primary buttons on green (text `#163A2B`) |
| Sea glass | `#5B8C7A` | secondary: in progress, reading (text uses `#477866` for AA) |
| Muted | `#4F6358` | secondary text |
| Rule | `#E3DCC9` | hairlines and card borders |
| Leaf green | `#2E8B57` on `#DDF0E4` | done / kept marks and meters (text `#1F7445` for AA) |

Type: Fraunces (optical size, 500-700) for headings, dates and the wordmark; Atkinson Hyperlegible body; Cormorant Garamond italic 600 for the verse and page subtitles. Soft 10-12px corners. Motif: on the green invite and roster screens, `shorelineLinesSVG()` in `app.js` (the approved board's simple lines): thin cream curves sweeping in from the top corners at ~28%, a lighter mirrored set at the bottom at ~22%. After login, the filled palm-frond images (`brand/frond-tr-green.png`, `brand/frond-bl-green.png`) at low opacity.

**Flight Club (entrepreneur).** Direction A, `brand/direction-a-reference.html`: navy `#152238` / cream `#F4EFE3` / paper `#FFFDF7` / soft gold `#C9973A`, muted `#4A5566`, rule `#E2DCCB`, steel blue `#2F62A3` for in progress, green `#1F6E43` on `#DCEFE2` for done. Barlow Condensed caps for headings and labels, Atkinson Hyperlegible body, Cormorant Garamond italic for the verse, squared 4-6px shapes. Logo `brand/flight-club-logo-mask-720.png` (alpha mask, colored with CSS `mask-image`). Motifs: `cloudsSVG()` (stippled clouds, invite and roster) and `dawnSVG()` (gold contour lines; Home and page headers).

**Shared page design (both groups).** Every main screen (Meetings, Track, Hot Seat, Group, Members, Books, Asks, Announcements, Ideas, Get-togethers, Rules, Profile) has a designed header via `pageHead()`: motif behind it, large display title, one-line subtitle, gold hairline. Section labels carry a short gold rule. Cards use 1px rule borders, no shadows. Avatars are initials on a tinted disc with a thin primary ring (`.avatar.sm/.lg/.xl`, `.ring` adds the gold ring). Hero treatments: the Hot Seat "next up" card, the Scoreboard leader row with a "Leading" / "Tied for first" badge, the group book card with a who's-reading strip, and the next get-together card (kind icon, host, your RSVP). Track's switch sits on a full-bleed primary band. Empty states show a small line drawing in the group's motif (`emptyArt()`). The active tab icon is filled in primary with a gold indicator above.

## Brand files

- `brand/shoreline-logo.svg` – The Shoreline mark ("In a circle"): palm on a ground line, M·S over the trunk with a gold middle dot, outer circle, gold dotted inner ring. Palm green on transparent. `brand/shoreline-logo-reverse.svg` is the sand version for green backgrounds. In these files the M·S letters are outlined paths drawn from Lora Italic 600, a close stand-in, because Fraunces could not be downloaded in the build sandbox. Swap in Fraunces outlines later if you want an exact match.
- In the app the mark is drawn inline by `shorelineLogoSVG(size, color)` in `app.js`, so the letters use the loaded Fraunces face and the palm lines are masked around them on any background.
- `icons/family-192.png`, `icons/family-512.png` – green square, sand mark, gold ring, sized inside the maskable safe zone.
- `brand/shoreline-reference.html`, `brand/shoreline-palette-reference.html` – the approved reference pages.
- `brand/direction-a-reference.html`, `brand/flight-club-logo*.png` – Flight Club identity and logo.

## Data shapes

Each top-level key becomes one Sheet tab later.

```
members:     { id, name, role: "admin"|"member", bio, focus, canHelpWith: [string],
               workingGenius: null | { geniuses: [2], competencies: [2], frustrations: [2] } }
               // letters W I D G E T = Wonder, Invention, Discernment, Galvanizing, Enablement, Tenacity
location:    { type: "zoom"|"inperson", label, url (zoom, https only) | null, address (in person) | null }
               // config.location = group default; a meeting's own location overrides it
meetings:    { id, datetime (ISO, Central offset), title, location? (omit to use the group default),
               agenda: [{ time (min), item, owner (memberId|"all") }],
               hotSeatMemberId,
               hotSeatPrep: null | { problem, context, whatTried, winLooksLike, submittedAt, editedAt? },
               actionPlan: null | { adviceTaken: [2-5 strings], nextStep, deadline (YYYY-MM-DD), goalId|null, savedAt },
               attendance: [memberId],  // past meetings only
               rsvps: [{ memberId, status: "yes"|"no"|"maybe" }] }
commitments: { id, memberId, meetingId, text, status: "not_started"|"in_progress"|"done",
               updatedAt, doneAt?, lastUpdateNote, goalId|null }
goals:       { id, memberId, period ("Q4 2026", "2027"), title, why, targetDate (YYYY-MM-DD),
               status: "active"|"done"|"paused", accountabilityAsk }
checkins:    { id, meetingId, memberId, win, challenge, submittedAt, editedAt? }
asks:        { id, memberId, title, detail, createdAt, status: "open"|"resolved",
               needs: null|"starting"|"deciding"|"finishing"|"hands"|"exploring",
               replies: [{ memberId, text, createdAt, canHelp }] }
announcements: { id, authorId, title, body, createdAt, pinned, comments: [comment] }
ideas:       { id, memberId, type: "idea"|"link"|"tool"|"article"|"podcast"|"other", title, note, url ("" if none),
               createdAt, likes: [memberId], comments: [comment] }
books:       { id, title, author, suggestedBy (memberId), why, createdAt, groupBook (only one true), comments: [comment] }
readingList: { bookId, memberId, status: "want"|"reading"|"finished", updatedAt }   // one row per person per book
gettogethers: { id, hostId, title, kind: "coffee"|"lunch"|"dinner"|"visit"|"other", datetime (ISO, Central offset),
               location, note, visibility: "open"|"closed", invitees: [memberId] (closed only),
               rsvps: [{ memberId, status: "yes"|"no"|"maybe" }], cancelled }
comment:     { memberId, text, createdAt }
```

Rules the app applies:
- A commitment belongs to the meeting where it was made. Home and Track show the ones from the most recent past meeting.
- Hot seat prep is due 24 hours before the meeting. Check-ins are due when the meeting starts.
- Saving an action plan creates or updates the hot seat person's commitment for that meeting (text = next step).
- Scoreboard: a commitment is "kept" if it's done by the start of the next meeting (uses `doneAt`, else `updatedAt`). Open commitments only count once they're kept or the next meeting has passed, so nobody is marked down mid-month. Streak = kept in a row, most recent first. Also shows check-ins on time, hot seat prep on time, and meetings attended.
- Ask "needs" maps to Working Genius: starting -> Galvanizing or Invention, deciding -> Discernment, finishing -> Tenacity, hands -> Enablement, exploring -> Wonder.
- A new get-together starts with the host as "yes". Calendar files use a default length per kind (coffee 60 min, lunch 75, dinner and visit 120, other 90).
- "New" announcements are ones posted by someone else since you last opened the list (saved per person on the device; first time, the last 7 days count).
- Rules agreement and "last seen" are stored on the device per group and person, not in the data.
- Meeting location: the meeting's own `location` if it has one, else the admin's saved group default, else `config.location`. Zoom links must start with http(s); a bare `zoom.us/...` gets `https://` added.
- Rotation reorder swaps the hot seat person (and any prep) between two meetings and updates the "Hot seat: Name" agenda line.

## What's fake

- All names, meetings, goals, check-ins, asks and commitments.
- Both groups' names, logos and colors are real. Meeting days and times for The Shoreline are still placeholders.
- Invite codes are checked in the browser (not secure; fine for a prototype).
- The Shoreline's Zoom link and Flight Club's address are placeholders.
- Edits are saved only in this browser (localStorage). Profile > Reset demo data restores the samples. Saved data from the older prototype is replaced automatically.
- No email, SMS or push reminders yet. The in-app reminder line is the only reminder.
- Working Genius results are typed in by each person. The app links to workinggenius.com and never recreates the assessment.
- Attendance is sample data only; there's no screen to take attendance yet.

## Connecting the real backend later

All data access is in the `api` object at the top of `app.js`. Each method returns a Promise:

`getConfig, getMembers, updateMember, getMeetings, updateMeeting (patch `location: null` clears a meeting's own location), getGroupLocation, setGroupLocation, setMeetingRsvp, swapHotSeat, saveHotSeatPrep, saveActionPlan, getCommitments, updateCommitment, createCommitment, getGoals, saveGoal, getCheckins, saveCheckin, getAsks, createAsk, replyToAsk, updateAsk, setAskNeeds, getAnnouncements, createAnnouncement, updateAnnouncement, commentOnAnnouncement, getIdeas, createIdea, toggleIdeaLike, commentOnIdea, getBooks, createBook, setGroupBook, commentOnBook, getReadingList, setReadingStatus, getGetTogethers, saveGetTogether, rsvpGetTogether, cancelGetTogether, resetDemo`

Replace their bodies with calls to the Apps Script web app; the screens don't need to change.

Privacy note for the backend: in the prototype `getGetTogethers` returns everything and the screens hide invite-only events. The real backend must filter on the server (open ones, plus closed ones where the caller is host, invitee or admin), or anyone could read them from the network.

## Supabase backend (built, not switched on yet)

The backend is Supabase (it replaced the Google Sheets + Apps Script plan). Everything is in `supabase/`; setup steps are in `supabase/README.md` and the reminder plan is in `supabase/NOTIFICATIONS.md`.

- `api-supabase.js` is a drop-in replacement for `api`: the same method names, arguments and return shapes, plus extras for login, trainings, reminders and admin. It reads `config/supabase.js` (project URL and key; placeholders for now).
- On the server, closed get-togethers, contact details and other groups' data are filtered by row-level security, not by the screens.

How the swap will happen (details in `supabase/README.md`, "Switching the app to Supabase"):
1. `index.html`: one line above `app.js`: `<script src="config/supabase.js"></script><script src="api-supabase.js"></script>`
2. `app.js` line 34: `const api = window.MASTERMIND_API || (function () {`. With the two scripts left out, the prototype keeps working exactly as now.
3. The invite, name-pick and switch-user handlers call `api.verifyInvite`, `api.join` and `api.signOut`, because the server now checks the invite code.

The data calls need only steps 1 and 2. Step 3 is needed because a real login can't be checked in the browser.

