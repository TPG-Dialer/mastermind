#!/usr/bin/env python3
"""Build supabase/seed.sql from config/*.json and data/*.json.

Run from anywhere:  python3 supabase/seed/generate.py
Output:             supabase/seed.sql (commit it)

The JSON files stay the source of truth for the prototype; this keeps the
database test data in sync with them. Re-running seed.sql WIPES both groups
(delete cascades) and loads the samples again, so only use it on a test
project or before real members join.

Things not in the JSON that the backend needs are set here, in GROUP_EXTRAS:
meeting rule, training rule, one-hour reminder flag, and the demo invite code
and Zoom link (no longer in config/*.json, which is public on GitHub Pages).
"""
import json
import pathlib
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

ROOT = pathlib.Path(__file__).resolve().parents[2]      # mastermind/
OUT = ROOT / "supabase" / "seed.sql"
GROUPS = ["family", "entrepreneur"]
CT = ZoneInfo("America/Chicago")

# Decisions from Corey (see NOTIFICATIONS.md / README). weekday is ISO: 1=Mon .. 7=Sun.
GROUP_EXTRAS = {
    "family": {
        "meeting_rule": {"nth": 3, "weekday": 3, "start": "19:30", "durationMinutes": 60,
                         "titleTemplate": "{month} Shoreline"},
        "training_rule": None,
        "notification_options": {"oneHourReminder": True},
        "demo_invite_code": "FAMILY2026",
        "demo_zoom_url": "https://zoom.us/j/0000000000?pwd=PLACEHOLDER",
    },
    "entrepreneur": {
        "meeting_rule": {"nth": 3, "weekday": 5, "start": "07:00", "durationMinutes": 120,
                         "titleTemplate": "{month} Flight Club"},
        "training_rule": {"nth": 3, "weekday": 3, "start": "12:00", "durationMinutes": 60,
                          "titleTemplate": "{month} Training"},
        "notification_options": {"oneHourReminder": False},
        "demo_invite_code": "FOUNDERS2026",
        "demo_zoom_url": None,
    },
}

# Sample trainings so the screen has something to show (fake, like the rest).
SAMPLE_TRAININGS = {
    "entrepreneur": [
        {"id": "tr-e-2026-11", "starts_at": "2026-11-18T12:00:00-06:00", "topic": "Pricing with conviction",
         "description": "How to raise prices without apologizing. Bring one offer you want to reprice.",
         "video_url": "https://zoom.us/j/0000000000?pwd=PLACEHOLDER", "recording_url": None},
        {"id": "tr-e-2026-10", "starts_at": "2026-10-21T12:00:00-05:00", "topic": "Hiring your first operator",
         "description": "What a #2 actually does, and how to know you're ready.",
         "video_url": "https://zoom.us/j/0000000000?pwd=PLACEHOLDER",
         "recording_url": "https://example.com/PLACEHOLDER-recording"},
    ]
}

BRANDING_SKIP = {"id", "name", "subtitle", "tagline", "verse", "credit", "inviteCode", "sheetId",
                 "rules", "location", "meetingLengthMinutes"}


def q(v):
    """SQL literal."""
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def j(v):
    return "null" if v is None else q(json.dumps(v, ensure_ascii=False, separators=(",", ":"))) + "::jsonb"


def arr(v):
    if not v:
        return "'{}'::text[]"
    return "array[" + ",".join(q(x) for x in v) + "]::text[]"


def ins(table, rows, cols):
    if not rows:
        return ""
    lines = [f"insert into public.{table} ({', '.join(cols)}) values"]
    vals = ["  (" + ", ".join(r) + ")" for r in rows]
    return "\n".join(lines) + "\n" + ",\n".join(vals) + ";\n"


def month_key(iso):
    return datetime.fromisoformat(iso).astimezone(CT).strftime("%Y-%m")


def agenda_template(meetings, members):
    """Latest meeting's agenda with the hot seat line made generic."""
    m = sorted(meetings, key=lambda x: x["datetime"])[-1]
    out = []
    for it in m["agenda"]:
        it = dict(it)
        if it["item"].lower().startswith("hot seat"):
            it["item"] = "Hot seat: {hotSeatName}"
            it["owner"] = "{hotSeat}"
        out.append(it)
    return out


def build_group(g, seen_ids):
    cfg = json.loads((ROOT / "config" / f"{g}.json").read_text())
    d = json.loads((ROOT / "data" / f"{g}.json").read_text())
    ex = GROUP_EXTRAS[g]
    out = [f"\n-- ===== {cfg['name']} ({g}) =====\n"]

    # id uniqueness across both groups (ids are global primary keys)
    for coll, items in d.items():
        for it in items:
            if "id" in it:
                if it["id"] in seen_ids:
                    sys.exit(f"Duplicate id across groups: {it['id']} ({coll})")
                seen_ids.add(it["id"])

    out.append(ins("groups", [[q(g), q(cfg["name"]), q(cfg.get("subtitle", "")), q(cfg.get("tagline", "")),
                               q("America/Chicago")]],
                   ["id", "name", "subtitle", "tagline", "timezone"]))
    branding = {k: v for k, v in cfg.items() if k not in BRANDING_SKIP}
    location = dict(cfg["location"])
    if location.get("type") == "zoom" and not location.get("url"):
        location["url"] = ex["demo_zoom_url"]
    out.append(ins("group_settings", [[
        q(g), j(branding), j(cfg.get("verse", {})), j(cfg.get("credit", {})), j(cfg.get("rules", [])), "1",
        j(location), j(ex["meeting_rule"]), j(ex["training_rule"]),
        j(agenda_template(d["meetings"], d["members"])), j(ex["notification_options"])]],
        ["group_id", "branding", "verse", "credit", "rules", "rules_version", "location_default",
         "meeting_rule", "training_rule", "agenda_template", "notification_options"]))
    code = (cfg.get("inviteCode") or ex["demo_invite_code"]).strip().upper()
    out.append(f"insert into public.group_invites (group_id, code_hash, code_hint) values "
               f"({q(g)}, public.hash_invite_code({q(g)}, {q(code)}), {q(code[-2:])});\n")

    out.append(ins("members", [[
        q(m["id"]), q(g), q(m["name"]), q(m["role"]), q(m.get("bio", "")), q(m.get("focus", "")),
        arr(m.get("canHelpWith", [])), j(m.get("workingGenius")), str(i + 1)]
        for i, m in enumerate(d["members"])],
        ["id", "group_id", "name", "role", "bio", "focus", "can_help_with", "working_genius", "sort_order"]))

    out.append(ins("meetings", [[
        q(m["id"]), q(g), q(m["datetime"]), str(cfg.get("meetingLengthMinutes", 60)), q(m["title"]),
        j(m.get("location")), j(m.get("agenda", [])), q(m.get("hotSeatMemberId")),
        j(m.get("hotSeatPrep")), j(m.get("actionPlan")), q("rule:" + month_key(m["datetime"]))]
        for m in d["meetings"]],
        ["id", "group_id", "starts_at", "duration_minutes", "title", "location", "agenda",
         "hot_seat_member_id", "hot_seat_prep", "action_plan", "source_key"]))
    out.append(ins("meeting_rsvps", [[q(m["id"]), q(r["memberId"]), q(g), q(r["status"])]
                                     for m in d["meetings"] for r in m.get("rsvps", [])],
                   ["meeting_id", "member_id", "group_id", "status"]))
    out.append(ins("meeting_attendance", [[q(m["id"]), q(mid), q(g), q(m["datetime"])]
                                          for m in d["meetings"] for mid in m.get("attendance", [])],
                   ["meeting_id", "member_id", "group_id", "marked_at"]))

    out.append(ins("trainings", [[
        q(t["id"]), q(g), q(t["starts_at"]), "60", q(t["topic"]), q(t["description"]), q(t["video_url"]),
        q(t["recording_url"]), q("rule:" + month_key(t["starts_at"]))] for t in SAMPLE_TRAININGS.get(g, [])],
        ["id", "group_id", "starts_at", "duration_minutes", "topic", "description", "video_url",
         "recording_url", "source_key"]))

    out.append(ins("goals", [[
        q(x["id"]), q(g), q(x["memberId"]), q(x.get("period", "")), q(x["title"]), q(x.get("why", "")),
        q(x.get("targetDate")), q(x.get("status", "active")), q(x.get("accountabilityAsk", ""))]
        for x in d.get("goals", [])],
        ["id", "group_id", "member_id", "period", "title", "why", "target_date", "status", "accountability_ask"]))

    out.append(ins("commitments", [[
        q(c["id"]), q(g), q(c["memberId"]), q(c["meetingId"]), q(c["text"]), q(c["status"]),
        q(c.get("lastUpdateNote", "")), q(c.get("goalId")),
        q(c.get("doneAt") or (c["updatedAt"] if c["status"] == "done" else None)),
        q(c["updatedAt"]), q(c["updatedAt"])] for c in d.get("commitments", [])],
        ["id", "group_id", "member_id", "meeting_id", "text", "status", "last_update_note", "goal_id",
         "done_at", "created_at", "updated_at"]))

    out.append(ins("checkins", [[
        q(k["id"]), q(g), q(k["meetingId"]), q(k["memberId"]), q(k.get("win", "")), q(k.get("challenge", "")),
        q(k["submittedAt"]), q(k.get("editedAt"))] for k in d.get("checkins", [])],
        ["id", "group_id", "meeting_id", "member_id", "win", "challenge", "submitted_at", "edited_at"]))

    asks = d.get("asks", [])
    out.append(ins("asks", [[
        q(a["id"]), q(g), q(a["memberId"]), q(a["title"]), q(a.get("detail", "")), q(a.get("needs")),
        q(a.get("status", "open")), q(a["createdAt"])] for a in asks],
        ["id", "group_id", "member_id", "title", "detail", "needs", "status", "created_at"]))
    out.append(ins("ask_replies", [[
        q(f"{a['id']}-r{i + 1}"), q(a["id"]), q(g), q(r["memberId"]), q(r["text"]), q(bool(r.get("canHelp"))),
        q(r["createdAt"])] for a in asks for i, r in enumerate(a.get("replies", []))],
        ["id", "ask_id", "group_id", "member_id", "text", "can_help", "created_at"]))

    anns = d.get("announcements", [])
    out.append(ins("announcements", [[
        q(a["id"]), q(g), q(a["authorId"]), q(a["title"]), q(a.get("body", "")), q(bool(a.get("pinned"))),
        q(a["createdAt"]), q(a["createdAt"])] for a in anns],
        ["id", "group_id", "author_id", "title", "body", "pinned", "created_at", "updated_at"]))
    out.append(ins("announcement_comments", [[
        q(f"{a['id']}-c{i + 1}"), q(a["id"]), q(g), q(c["memberId"]), q(c["text"]), q(c["createdAt"])]
        for a in anns for i, c in enumerate(a.get("comments", []))],
        ["id", "announcement_id", "group_id", "member_id", "text", "created_at"]))

    ideas = d.get("ideas", [])
    out.append(ins("ideas", [[
        q(i["id"]), q(g), q(i["memberId"]), q(i["type"]), q(i["title"]), q(i.get("note", "")),
        q(i.get("url", "")), q(i["createdAt"])] for i in ideas],
        ["id", "group_id", "member_id", "type", "title", "note", "url", "created_at"]))
    out.append(ins("idea_likes", [[q(i["id"]), q(mid), q(g)] for i in ideas for mid in i.get("likes", [])],
                   ["idea_id", "member_id", "group_id"]))
    out.append(ins("idea_comments", [[
        q(f"{i['id']}-c{n + 1}"), q(i["id"]), q(g), q(c["memberId"]), q(c["text"]), q(c["createdAt"])]
        for i in ideas for n, c in enumerate(i.get("comments", []))],
        ["id", "idea_id", "group_id", "member_id", "text", "created_at"]))

    books = d.get("books", [])
    out.append(ins("books", [[
        q(b["id"]), q(g), q(b["title"]), q(b.get("author", "")), q(b["suggestedBy"]), q(b.get("why", "")),
        q(bool(b.get("groupBook"))), q(b["createdAt"])] for b in books],
        ["id", "group_id", "title", "author", "suggested_by", "why", "group_book", "created_at"]))
    out.append(ins("book_comments", [[
        q(f"{b['id']}-c{n + 1}"), q(b["id"]), q(g), q(c["memberId"]), q(c["text"]), q(c["createdAt"])]
        for b in books for n, c in enumerate(b.get("comments", []))],
        ["id", "book_id", "group_id", "member_id", "text", "created_at"]))
    out.append(ins("reading_list", [[q(r["bookId"]), q(r["memberId"]), q(g), q(r["status"]), q(r["updatedAt"])]
                                    for r in d.get("readingList", [])],
                   ["book_id", "member_id", "group_id", "status", "updated_at"]))

    gts = d.get("gettogethers", [])
    out.append(ins("get_togethers", [[
        q(e["id"]), q(g), q(e["hostId"]), q(e["title"]), q(e.get("kind", "other")), q(e["datetime"]),
        q(e.get("location", "")), q(e.get("note", "")), q(e.get("visibility", "open")), q(bool(e.get("cancelled")))]
        for e in gts],
        ["id", "group_id", "host_id", "title", "kind", "starts_at", "location", "note", "visibility", "cancelled"]))
    out.append(ins("get_together_invitees", [[q(e["id"]), q(mid), q(g)]
                                             for e in gts if e.get("visibility") == "closed"
                                             for mid in e.get("invitees", []) if mid != e["hostId"]],
                   ["get_together_id", "member_id", "group_id"]))
    out.append(ins("get_together_rsvps", [[q(e["id"]), q(r["memberId"]), q(g), q(r["status"])]
                                          for e in gts for r in e.get("rsvps", [])],
                   ["get_together_id", "member_id", "group_id", "status"]))
    return "".join(out)


def main():
    seen = set()
    body = "".join(build_group(g, seen) for g in GROUPS)
    sql = f"""-- GENERATED by supabase/seed/generate.py from config/*.json and data/*.json. Do not edit by hand.
-- Test data only. Re-running this WIPES both groups and reloads the samples.
-- Contact details (email/phone) are deliberately not seeded, so no reminder
-- can reach a real person by accident. Invite codes are the demo ones from config.

begin;
set local mm.seeding = 'on';   -- triggers skip notifications and change-feed pings

delete from public.notification_queue where group_id in ({", ".join(q(g) for g in GROUPS)});
delete from public.groups where id in ({", ".join(q(g) for g in GROUPS)});
{body}
commit;
"""
    OUT.write_text(sql)
    print(f"wrote {OUT.relative_to(ROOT)} ({len(sql.splitlines())} lines)")


if __name__ == "__main__":
    main()
