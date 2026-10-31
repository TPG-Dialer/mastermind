/* Mastermind prototype: routing, state, rendering.
   All data access goes through `api` so it can be swapped for the Apps Script web app later. */
(function () {
  'use strict';

  const TZ = 'America/Chicago';
  const GROUPS = ['family', 'entrepreneur'];
  const DATA_VERSION = 6; // bump when the sample data shape changes; stale saved data is replaced
  const STATUS = { not_started: 'Not started', in_progress: 'In progress', done: 'Done' };
  const GOAL_STATUS = { active: 'Active', done: 'Done', paused: 'Paused' };
  const DAY = 86400000;

  const params = new URLSearchParams(location.search);
  // Group comes from the address: flightclub.tpgmn.com -> entrepreneur, shoreline.tpgmn.com -> family,
  // otherwise ?group= (GitHub Pages / local), otherwise family.
  const hostGroup = /^flightclub\./i.test(location.hostname) ? 'entrepreneur'
    : /^shoreline\./i.test(location.hostname) ? 'family' : null;
  const requested = window.MASTERMIND_GROUP || params.get('group') || hostGroup;
  const GROUP = GROUPS.includes(requested) ? requested : 'family';

  /* ---------- Safe localStorage ---------- */
  const store = {
    key: (k) => `mm:${GROUP}:${k}`,
    get(k, fallback) {
      try {
        const raw = localStorage.getItem(this.key(k));
        return raw == null ? fallback : JSON.parse(raw);
      } catch (e) { return fallback; }
    },
    set(k, v) { try { localStorage.setItem(this.key(k), JSON.stringify(v)); } catch (e) { /* ignore */ } },
    remove(k) { try { localStorage.removeItem(this.key(k)); } catch (e) { /* ignore */ } }
  };

  /* ---------- Data layer ----------
     Supabase: api-supabase.js sets window.MASTERMIND_API (same methods, plus login,
     contacts and admin extras). It stays unset with ?backend=local or without a
     project in config/supabase.js, and then the demo layer below is used: JSON
     from /data, edits kept in localStorage. Every method returns a Promise. */
  // Demo-only values. The real invite codes and Zoom link live in the database,
  // not in config/*.json (which is public on GitHub Pages).
  const DEMO = {
    family: { inviteCode: 'FAMILY2026', zoomUrl: 'https://zoom.us/j/0000000000?pwd=PLACEHOLDER' },
    entrepreneur: { inviteCode: 'FOUNDERS2026', zoomUrl: null }
  };
  const baseApi = (params.get('backend') !== 'local' && window.MASTERMIND_API) || (function () {
    let cache = null;
    const clone = (x) => JSON.parse(JSON.stringify(x));
    const delay = (v) => new Promise((r) => setTimeout(() => r(clone(v)), 40));
    const uid = (p) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const nowISO = () => new Date().toISOString();

    async function fetchJSON(path) {
      const res = await fetch(path, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`Could not load ${path} (${res.status})`);
      return res.json();
    }
    async function load() {
      if (cache) return cache;
      const saved = store.get('data', null);
      if (saved && saved._v === DATA_VERSION) cache = saved;
      else {
        cache = await fetchJSON(`data/${GROUP}.json`);
        cache._v = DATA_VERSION;
        save();
      }
      return cache;
    }
    function save() { store.set('data', cache); }
    function find(list, id, what) {
      const x = (list || []).find((i) => i.id === id);
      if (!x) throw new Error(`${what} not found`);
      return x;
    }
    // Comments share one shape everywhere: { memberId, text, createdAt }.
    async function addComment(collection, id, memberId, text) {
      const item = find((await load())[collection], id, 'Item');
      item.comments = item.comments || [];
      item.comments.push({ memberId, text, createdAt: nowISO() });
      save();
      return delay(item);
    }

    return {
      backend: 'local',
      async getConfig() {
        const cfg = await fetchJSON(`config/${GROUP}.json`);
        cfg.demoInviteCode = DEMO[GROUP].inviteCode;
        const loc = cfg.location;
        if (loc && loc.type === 'zoom' && !loc.url && DEMO[GROUP].zoomUrl) cfg.location = Object.assign({}, loc, { url: DEMO[GROUP].zoomUrl });
        return cfg;
      },
      async getMembers() { return delay((await load()).members); },
      async getMeetings() {
        const d = await load();
        return delay(d.meetings.slice().sort((a, b) => new Date(a.datetime) - new Date(b.datetime)));
      },
      async updateMeeting(id, patch) {
        const m = find((await load()).meetings, id, 'Meeting');
        Object.assign(m, patch);
        // location: null (or missing) means "use the group default".
        if ('location' in patch && !patch.location) delete m.location;
        save();
        return delay(m);
      },
      // Swap who is on the hot seat at two meetings (their prep moves with them).
      async swapHotSeat(aId, bId) {
        const d = await load();
        const a = find(d.meetings, aId, 'Meeting');
        const b = find(d.meetings, bId, 'Meeting');
        const nameOf = (id) => ((d.members.find((m) => m.id === id) || {}).name || '').split(' ')[0];
        const fixAgenda = (mt, fromId, toId) => mt.agenda.forEach((it) => {
          if (!/^hot seat/i.test(it.item)) return;
          if (it.owner === fromId) it.owner = toId;
          const from = nameOf(fromId);
          if (from) it.item = it.item.replace(new RegExp(`\\b${from}\\b`), nameOf(toId));
        });
        const aMem = a.hotSeatMemberId; const bMem = b.hotSeatMemberId;
        fixAgenda(a, aMem, bMem);
        fixAgenda(b, bMem, aMem);
        [a.hotSeatMemberId, b.hotSeatMemberId] = [bMem, aMem];
        [a.hotSeatPrep, b.hotSeatPrep] = [b.hotSeatPrep, a.hotSeatPrep];
        save();
        return delay([a, b]);
      },
      async saveHotSeatPrep(meetingId, prep) {
        const m = find((await load()).meetings, meetingId, 'Meeting');
        const prev = m.hotSeatPrep;
        m.hotSeatPrep = Object.assign({}, prep, {
          submittedAt: (prev && prev.submittedAt) || nowISO(),
          editedAt: prev && prev.submittedAt ? nowISO() : undefined
        });
        save();
        return delay(m);
      },
      // Saves the hot seat person's action plan and creates/updates their commitment for that meeting.
      async saveActionPlan(meetingId, plan) {
        const d = await load();
        const m = find(d.meetings, meetingId, 'Meeting');
        m.actionPlan = Object.assign({}, plan, { savedAt: nowISO() });
        let c = d.commitments.find((x) => x.meetingId === meetingId && x.memberId === m.hotSeatMemberId);
        if (c) Object.assign(c, { text: plan.nextStep, goalId: plan.goalId || null, updatedAt: nowISO() });
        else {
          c = { id: uid('c'), memberId: m.hotSeatMemberId, meetingId, text: plan.nextStep, status: 'not_started',
            updatedAt: nowISO(), lastUpdateNote: '', goalId: plan.goalId || null };
          d.commitments.push(c);
        }
        save();
        return delay({ meeting: m, commitment: c });
      },

      async getCommitments() { return delay((await load()).commitments); },
      async updateCommitment(id, patch) {
        const c = find((await load()).commitments, id, 'Commitment');
        if (patch.status === 'done' && c.status !== 'done') c.doneAt = nowISO();
        if (patch.status && patch.status !== 'done') delete c.doneAt;
        Object.assign(c, patch, { updatedAt: nowISO() });
        save();
        return delay(c);
      },
      async createCommitment(fields) {
        const d = await load();
        const c = Object.assign({ id: uid('c'), status: 'not_started', lastUpdateNote: '', goalId: null }, fields, { updatedAt: nowISO() });
        d.commitments.push(c);
        save();
        return delay(c);
      },

      async getGoals() { return delay((await load()).goals || []); },
      async saveGoal(goal) {
        const d = await load();
        d.goals = d.goals || [];
        let g = goal.id && d.goals.find((x) => x.id === goal.id);
        if (g) Object.assign(g, goal);
        else { g = Object.assign({ status: 'active', accountabilityAsk: '' }, goal, { id: uid('g') }); d.goals.push(g); }
        save();
        return delay(g);
      },

      async getCheckins() { return delay((await load()).checkins || []); },
      async saveCheckin({ meetingId, memberId, win, challenge }) {
        const d = await load();
        d.checkins = d.checkins || [];
        let k = d.checkins.find((x) => x.meetingId === meetingId && x.memberId === memberId);
        if (k) Object.assign(k, { win, challenge, editedAt: nowISO() });
        else { k = { id: uid('k'), meetingId, memberId, win, challenge, submittedAt: nowISO() }; d.checkins.push(k); }
        save();
        return delay(k);
      },

      async getAsks() { return delay((await load()).asks || []); },
      async createAsk({ memberId, title, detail, needs }) {
        const d = await load();
        d.asks = d.asks || [];
        const a = { id: uid('a'), memberId, title, detail, needs: needs || null, createdAt: nowISO(), status: 'open', replies: [] };
        d.asks.push(a);
        save();
        return delay(a);
      },
      async replyToAsk(id, { memberId, text, canHelp }) {
        const a = find((await load()).asks, id, 'Ask');
        a.replies.push({ memberId, text, canHelp: !!canHelp, createdAt: nowISO() });
        save();
        return delay(a);
      },
      async updateAsk(id, patch) {
        const a = find((await load()).asks, id, 'Ask');
        Object.assign(a, patch);
        save();
        return delay(a);
      },

      // Asks can carry an optional `needs` (starting|deciding|finishing|hands|exploring).
      async setAskNeeds(id, needs) {
        const a = find((await load()).asks, id, 'Ask');
        a.needs = needs || null;
        save();
        return delay(a);
      },

      /* Members: profile fields (bio, focus, canHelpWith, workingGenius) */
      async updateMember(id, patch) {
        const m = find((await load()).members, id, 'Member');
        const allowed = ['bio', 'focus', 'canHelpWith', 'workingGenius'];
        allowed.forEach((k) => { if (k in patch) m[k] = patch[k]; });
        save();
        return delay(m);
      },

      /* Meeting RSVP: status yes|no|maybe */
      async setMeetingRsvp(meetingId, memberId, status) {
        const m = find((await load()).meetings, meetingId, 'Meeting');
        m.rsvps = m.rsvps || [];
        const r = m.rsvps.find((x) => x.memberId === memberId);
        if (r) r.status = status; else m.rsvps.push({ memberId, status });
        save();
        return delay(m);
      },

      /* Announcements */
      async getAnnouncements() { return delay((await load()).announcements || []); },
      async createAnnouncement({ authorId, title, body, pinned }) {
        const d = await load();
        d.announcements = d.announcements || [];
        const a = { id: uid('an'), authorId, title, body, createdAt: nowISO(), pinned: !!pinned, comments: [] };
        d.announcements.push(a);
        save();
        return delay(a);
      },
      async updateAnnouncement(id, patch) {
        const a = find((await load()).announcements, id, 'Announcement');
        ['title', 'body', 'pinned'].forEach((k) => { if (k in patch) a[k] = patch[k]; });
        save();
        return delay(a);
      },
      async commentOnAnnouncement(id, { memberId, text }) { return addComment('announcements', id, memberId, text); },

      /* Ideas & resources */
      async getIdeas() { return delay((await load()).ideas || []); },
      async createIdea({ memberId, type, title, note, url }) {
        const d = await load();
        d.ideas = d.ideas || [];
        const i = { id: uid('i'), memberId, type, title, note: note || '', url: url || '', createdAt: nowISO(), likes: [], comments: [] };
        d.ideas.push(i);
        save();
        return delay(i);
      },
      async toggleIdeaLike(id, memberId) {
        const i = find((await load()).ideas, id, 'Idea');
        i.likes = i.likes.includes(memberId) ? i.likes.filter((x) => x !== memberId) : i.likes.concat(memberId);
        save();
        return delay(i);
      },
      async commentOnIdea(id, { memberId, text }) { return addComment('ideas', id, memberId, text); },

      /* Books + per-member reading state */
      async getBooks() { return delay((await load()).books || []); },
      async createBook({ title, author, suggestedBy, why }) {
        const d = await load();
        d.books = d.books || [];
        const b = { id: uid('b'), title, author, suggestedBy, why: why || '', createdAt: nowISO(), groupBook: false, comments: [] };
        d.books.push(b);
        save();
        return delay(b);
      },
      // Only one group book at a time. Pass null to clear.
      async setGroupBook(bookId) {
        const d = await load();
        (d.books || []).forEach((b) => { b.groupBook = b.id === bookId; });
        save();
        return delay(d.books);
      },
      async commentOnBook(id, { memberId, text }) { return addComment('books', id, memberId, text); },
      async getReadingList() { return delay((await load()).readingList || []); },
      // status want|reading|finished, or null to take the book off your list.
      async setReadingStatus(bookId, memberId, status) {
        const d = await load();
        d.readingList = d.readingList || [];
        const i = d.readingList.findIndex((r) => r.bookId === bookId && r.memberId === memberId);
        if (!status) { if (i >= 0) d.readingList.splice(i, 1); save(); return delay(null); }
        const r = i >= 0 ? d.readingList[i] : null;
        const row = { bookId, memberId, status, updatedAt: nowISO() };
        if (r) Object.assign(r, row); else d.readingList.push(row);
        save();
        return delay(row);
      },

      /* Get-togethers. The prototype returns all of them and the screens filter by visibility;
         the real backend should only return open ones plus closed ones the caller hosts or is invited to. */
      async getGetTogethers() { return delay((await load()).gettogethers || []); },
      async saveGetTogether(ev) {
        const d = await load();
        d.gettogethers = d.gettogethers || [];
        const fields = ['title', 'kind', 'datetime', 'location', 'note', 'visibility', 'invitees'];
        let e = ev.id && d.gettogethers.find((x) => x.id === ev.id);
        if (e) fields.forEach((k) => { if (k in ev) e[k] = ev[k]; });
        else {
          e = { id: uid('gt'), hostId: ev.hostId, rsvps: [{ memberId: ev.hostId, status: 'yes' }], cancelled: false };
          fields.forEach((k) => { e[k] = ev[k]; });
          d.gettogethers.push(e);
        }
        if (e.visibility !== 'closed') e.invitees = [];
        save();
        return delay(e);
      },
      async rsvpGetTogether(id, memberId, status) {
        const e = find((await load()).gettogethers, id, 'Get-together');
        const r = e.rsvps.find((x) => x.memberId === memberId);
        if (r) r.status = status; else e.rsvps.push({ memberId, status });
        save();
        return delay(e);
      },
      async cancelGetTogether(id) {
        const e = find((await load()).gettogethers, id, 'Get-together');
        e.cancelled = true;
        save();
        return delay(e);
      },

      /* Group default meeting location. Starts from config.location; an admin edit is kept as an override
         (later: a Settings tab in the Sheet). Pass null to go back to the config value. */
      async getGroupLocation() { return delay(store.get('groupLocation', null)); },
      async setGroupLocation(loc) {
        if (loc) store.set('groupLocation', loc); else store.remove('groupLocation');
        return delay(loc || null);
      },

      async resetDemo() {
        store.remove('data');
        store.remove('groupLocation');
        cache = null;
        await load();
        return true;
      }
    };
  })();
  const SUPA = baseApi.backend === 'supabase';

  /* Screens call `api` (below). Any rejection shows a toast and is re-thrown as a
     HandledError, so the handler stops where it is: the sheet stays open, nothing
     is closed or re-rendered, and the screen keeps its previous state. The
     unhandledrejection listener in init() swallows HandledErrors.
     Code that shows its own errors (login, first load) uses baseApi directly. */
  class HandledError extends Error {
    constructor(err) { super(err && err.message); this.cause = err; }
  }
  function friendlyError(err, reading) {
    const e = err || {};
    if (e.code === 'network' || e.status === 0) return "Can't reach the server. Check your connection and try again.";
    if (e.status === 401 || e.status === 403 || e.code === '42501') return "You don't have permission to do that.";
    const msg = String(e.message || '').replace(/\.$/, '');
    return `${reading ? "Couldn't load" : "Couldn't save"}${msg ? `: ${msg}` : ''}`;
  }
  let writesInFlight = 0;
  const api = new Proxy(baseApi, {
    get(target, key) {
      const v = target[key];
      if (typeof v !== 'function') return v;
      const reading = /^get/.test(String(key));
      return (...args) => {
        if (!reading) { writesInFlight++; document.documentElement.classList.add('mm-busy'); }
        let p;
        try { p = Promise.resolve(v.apply(target, args)); } catch (e) { p = Promise.reject(e); }
        return p.then((res) => res, (err) => {
          if (err instanceof HandledError) throw err;
          noteError(err);
          toast(friendlyError(err, reading), 4000);
          throw new HandledError(err);
        }).finally(() => {
          if (!reading && --writesInFlight <= 0) { writesInFlight = 0; document.documentElement.classList.remove('mm-busy'); }
        });
      };
    }
  });

  /* ---------- State ---------- */
  const state = {
    config: null, members: [], meetings: [], commitments: [], goals: [], checkins: [], asks: [],
    announcements: [], ideas: [], books: [], readingList: [], gettogethers: [], groupLocation: null,
    me: null, filter: 'all', editPrep: false, lastPath: null,
    ideaFilter: 'all', bookFilter: 'all', gtPast: false,
    // Supabase mode only:
    session: null,        // get_session_info(): { memberId, role, rulesVersion, rulesAcceptedAt, ... }
    myContact: null,      // { email, phone } or null when not loaded
    prefs: null,          // { sms, email, nudges }
    contacts: null,       // admins: [{ memberId, email, phone }]
    offline: false,       // last load failed: showing the cached copy
    pendingRemote: false  // another member changed something while you were mid-edit
  };
  // A network failure anywhere means we're offline until the next good load.
  function noteError(err) { if (err && (err.code === 'network' || err.status === 0)) state.offline = true; }

  /* ---------- Helpers ---------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const memberById = (id) => state.members.find((m) => m.id === id);
  const memberName = (id) => (id === 'all' ? 'Everyone' : (memberById(id) || {}).name || 'Unassigned');
  const firstName = (id) => memberName(id).split(' ')[0];
  const initials = (name) => name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  const isAdmin = () => state.me && state.me.role === 'admin';
  const isMe = (id) => state.me && state.me.id === id;
  const youOr = (id) => (isMe(id) ? 'You' : memberName(id));
  const goalById = (id) => state.goals.find((g) => g.id === id);
  const ts = (iso) => new Date(iso).getTime();
  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;

  const fmt = (opts) => new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: TZ }, opts));
  const fmtDateLong = fmt({ weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const fmtDateShort = fmt({ weekday: 'short', month: 'short', day: 'numeric' });
  const fmtMD = fmt({ month: 'short', day: 'numeric' });
  const fmtWeekday = fmt({ weekday: 'short' });
  const fmtTime = fmt({ hour: 'numeric', minute: '2-digit' });
  const fmtWeekdayLong = fmt({ weekday: 'long' });
  // "7:00–9:00 AM" when both ends share AM/PM, else "11:00 AM–1:00 PM".
  function timeRange(a, b) {
    const s = fmtTime.format(a); const e = fmtTime.format(b);
    const [sT, sP] = s.split(/\s/); const [, eP] = e.split(/\s/);
    return sP === eP ? `${sT}–${e}` : `${s}–${e}`;
  }
  const fmtMonth = fmt({ month: 'short' });
  const fmtMonthLong = fmt({ month: 'long' });
  const fmtDay = fmt({ day: 'numeric' });
  const fmtDateYear = fmt({ month: 'short', day: 'numeric', year: 'numeric' });
  // "2026-11-07" -> a Date at midday Central, for display only.
  const dateOnly = (s) => new Date(`${s}T18:00:00Z`);

  function chicagoParts(date) {
    const parts = {};
    fmt({ year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(date).forEach((p) => { parts[p.type] = p.value; });
    return parts;
  }
  function chicagoOffset(date) {
    const p = chicagoParts(date);
    const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
    return Math.round((asUTC - Math.floor(date.getTime() / 60000) * 60000) / 60000);
  }
  function centralToISO(dateStr, timeStr) {
    const [y, mo, d] = dateStr.split('-').map(Number);
    const [h, mi] = timeStr.split(':').map(Number);
    const naive = Date.UTC(y, mo - 1, d, h, mi);
    let off = chicagoOffset(new Date(naive + 360 * 60000));
    off = chicagoOffset(new Date(naive - off * 60000));
    const sign = off < 0 ? '-' : '+';
    const abs = Math.abs(off);
    const pad = (n) => String(n).padStart(2, '0');
    return `${dateStr}T${pad(h)}:${pad(mi)}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  }
  function isoToCentralInputs(iso) {
    const p = chicagoParts(new Date(iso));
    return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
  }

  function relTime(iso) {
    const mins = Math.round((Date.now() - ts(iso)) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs} hr${hrs === 1 ? '' : 's'} ago`;
    const days = Math.round(hrs / 24);
    if (days < 14) return `${days} day${days === 1 ? '' : 's'} ago`;
    return fmtMD.format(new Date(iso));
  }

  const isPast = (m) => ts(m.datetime) <= Date.now();
  function nextMeeting() { return state.meetings.find((m) => !isPast(m)) || null; }
  function lastMeeting() {
    const past = state.meetings.filter(isPast);
    return past[past.length - 1] || null;
  }
  function meetingAfter(m) { return state.meetings[state.meetings.indexOf(m) + 1] || null; }
  function currentCommitments() {
    const lm = lastMeeting();
    return lm ? state.commitments.filter((c) => c.meetingId === lm.id) : [];
  }
  const myCommitment = () => currentCommitments().find((c) => isMe(c.memberId));
  const checkinFor = (meetingId, memberId) => state.checkins.find((k) => k.meetingId === meetingId && k.memberId === memberId);
  const hasPrep = (m) => !!(m && m.hotSeatPrep && m.hotSeatPrep.problem);
  const prepDue = (m) => new Date(ts(m.datetime) - DAY);
  const myGoals = (memberId) => state.goals.filter((g) => g.memberId === memberId);

  function agendaWithTimes(meeting) {
    let t = ts(meeting.datetime);
    const rows = meeting.agenda.map((a) => {
      const row = Object.assign({}, a, { start: new Date(t) });
      t += (Number(a.time) || 0) * 60000;
      return row;
    });
    return { rows, end: new Date(t) };
  }
  function meetingLength(meeting) {
    return meeting.agenda.reduce((s, a) => s + (Number(a.time) || 0), 0) || state.config.meetingLengthMinutes;
  }
  const meetingEnd = (m) => new Date(ts(m.datetime) + meetingLength(m) * 60000);

  /* ---------- Meeting location ----------
     Shape: { type: "zoom"|"inperson", label, url|null, address|null }.
     config.location is the group default (an admin can override it, see api.setGroupLocation);
     a meeting's own `location` overrides both. */
  const LOC_LABEL = { zoom: 'Zoom', inperson: 'In person' };
  const JOIN_EARLY = 15 * 60000; // "Join Zoom" turns into the main button 15 min before the start...
  const JOIN_LATE = 30 * 60000; // ...and stays that way until 30 min after the end.
  const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\/\S+$/i.test(u.trim()) ? u.trim() : null);
  function normLocation(loc) {
    if (!loc || !LOC_LABEL[loc.type]) return null;
    const zoom = loc.type === 'zoom';
    return {
      type: loc.type, label: loc.label || LOC_LABEL[loc.type],
      url: zoom ? safeUrl(loc.url) : null, address: zoom ? null : (String(loc.address || '').trim() || null)
    };
  }
  function groupLocation() {
    return normLocation(state.groupLocation) || normLocation(state.config.location)
      || { type: 'inperson', label: 'In person', url: null, address: null };
  }
  // Effective location for a meeting: its own override, else the group default.
  function meetingLocation(meeting) { return normLocation(meeting && meeting.location) || groupLocation(); }
  const hasOwnLocation = (meeting) => !!normLocation(meeting && meeting.location);
  const isZoom = (loc) => loc.type === 'zoom' && !!loc.url;
  // A place name set in the database (e.g. "Vendella Euro Boutique & Coffee Haus"), not the generic "In person".
  const placeName = (loc) => (loc.type === 'inperson' && loc.label && loc.label !== LOC_LABEL.inperson ? loc.label : null);
  const locText = (loc) => (loc.type === 'zoom' ? loc.label || 'Zoom' : placeName(loc) || loc.address || loc.label || 'In person');
  // "zoom.us/j/0000000000" (no scheme, no query) so people can see where the link goes.
  function shortUrl(u) {
    try { const x = new URL(u); return (x.host + x.pathname).replace(/\/$/, ''); } catch (e) { return u; }
  }
  const sameLocation = (a, b) => a.type === b.type && a.url === b.url && a.address === b.address;
  function inJoinWindow(m) {
    const now = Date.now();
    return now >= ts(m.datetime) - JOIN_EARLY && now <= meetingEnd(m).getTime() + JOIN_LATE;
  }
  // The meeting Home features: one that is about to start, running or just ended, else the next one.
  const heroMeeting = () => state.meetings.find(inJoinWindow) || nextMeeting();
  const videoIcon = '<svg class="loc-svg" viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="5.5" width="10.5" height="9" rx="2"/><path d="M13 8.6l4.5-2.6v8l-4.5-2.6z"/></svg>';
  const mapPinIcon = '<svg class="loc-svg" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 18s-5.5-5.4-5.5-9.6a5.5 5.5 0 0 1 11 0C15.5 12.6 10 18 10 18z"/><circle cx="10" cy="8.4" r="2"/></svg>';
  const copyIcon = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.2V3A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h.2"/></svg>';
  const locIcon = (loc) => (loc.type === 'zoom' ? videoIcon : mapPinIcon);

  async function copyText(text, okMsg) {
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
      else {
        const ta = document.createElement('textarea');
        ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        if (!ok) throw new Error('copy failed');
      }
      toast(okMsg);
    } catch (e) {
      toast("Couldn't copy. Press and hold the link instead.");
    }
  }

  // Location fields for a sheet. `inheritable` adds the "Use group default" switch (meeting editor).
  function locationEditorHTML(loc, { inheritable = false, inherit = false } = {}) {
    const g = groupLocation();
    const seg = (t) => `<button type="button" role="radio" class="seg-active ${loc.type === t ? 'on' : ''}" aria-checked="${loc.type === t}" data-loc-type="${t}">${t === 'zoom' ? videoIcon : mapPinIcon}${LOC_LABEL[t]}</button>`;
    return `<div class="loc-edit">
      ${inheritable ? `<label class="switch-row"><span class="sw-text"><b>Use group default</b>
          <span class="sw-sub">${locIcon(g)}${esc(locText(g))}</span></span>
        <input type="checkbox" role="switch" id="loc-inherit" ${inherit ? 'checked' : ''}><span class="sw" aria-hidden="true"></span></label>` : ''}
      <div id="loc-fields" ${inheritable && inherit ? 'hidden' : ''}>
        <div class="segmented loc-seg" role="radiogroup" aria-label="Where" id="loc-type">${seg('zoom')}${seg('inperson')}</div>
        <div class="field" id="loc-url-wrap" ${loc.type === 'zoom' ? '' : 'hidden'}><label for="loc-url">Zoom link</label>
          <input id="loc-url" type="url" inputmode="url" autocomplete="off" spellcheck="false" maxlength="300" placeholder="https://zoom.us/j/..." value="${esc(loc.url || '')}"></div>
        <div class="field" id="loc-addr-wrap" ${loc.type === 'inperson' ? '' : 'hidden'}><label for="loc-addr">Address or place</label>
          <input id="loc-addr" maxlength="160" autocomplete="street-address" placeholder="e.g. 412 Lake St, or Mark &amp; Linda's house" value="${esc(loc.address || '')}"></div>
      </div>
    </div>`;
  }
  function bindLocationEditor(sheet, draft) {
    const types = $$('[data-loc-type]', sheet);
    types.forEach((b) => b.addEventListener('click', () => {
      draft.type = b.dataset.locType;
      types.forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b); });
      sheet.querySelector('#loc-url-wrap').hidden = draft.type !== 'zoom';
      sheet.querySelector('#loc-addr-wrap').hidden = draft.type !== 'inperson';
    }));
    const inh = sheet.querySelector('#loc-inherit');
    if (inh) inh.addEventListener('change', () => { sheet.querySelector('#loc-fields').hidden = inh.checked; });
  }
  // Returns { loc } (null = use group default), or { error } after focusing the field to fix.
  function readLocationEditor(sheet, draft) {
    const inh = sheet.querySelector('#loc-inherit');
    if (inh && inh.checked) return { loc: null };
    if (draft.type === 'zoom') {
      const input = sheet.querySelector('#loc-url');
      let url = input.value.trim();
      if (url && !/^[a-z]+:/i.test(url)) url = `https://${url}`;
      if (!safeUrl(url)) { input.focus(); return { error: url ? 'That link should start with https://' : 'Paste the Zoom link' }; }
      return { loc: { type: 'zoom', label: 'Zoom', url: safeUrl(url), address: null } };
    }
    const input = sheet.querySelector('#loc-addr');
    const address = input.value.trim();
    if (!address) { input.focus(); return { error: 'Add the address or place' }; }
    return { loc: { type: 'inperson', label: 'In person', url: null, address } };
  }

  // Admin: the group's usual meeting place (Profile > Meeting location).
  function editGroupLocation() {
    const cur = groupLocation();
    const draft = { type: cur.type };
    openSheet(`
      <h2>Meeting location</h2>
      <p class="sheet-sub">Where ${esc(state.config.name)} usually meets. One meeting can be different: change it in Edit meeting.</p>
      ${locationEditorHTML(cur)}
      <div class="sheet-actions"><button class="btn btn-ghost" data-cancel>Cancel</button><button class="btn btn-primary" id="loc-save">Save location</button></div>`, (sheet) => {
      bindLocationEditor(sheet, draft);
      sheet.querySelector('#loc-save').addEventListener('click', async () => {
        const r = readLocationEditor(sheet, draft);
        if (r.error) { toast(r.error); return; }
        await api.setGroupLocation(r.loc);
        await refresh();
        closeSheet();
        toast('Meeting location saved');
        rerender();
      });
    });
  }

  function toast(msg, ms) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.remove('show'), ms || 2200);
  }

  /* ---------- Small pieces of markup ---------- */
  // Status is shape + color: hollow ring, half-filled ring, filled check.
  function mark(status, cls = '') {
    const inner = {
      not_started: '<circle cx="10" cy="10" r="7" fill="none"/>',
      in_progress: '<circle cx="10" cy="10" r="7" fill="none"/><path d="M10 3a7 7 0 0 1 0 14z" class="fill"/>',
      done: '<circle cx="10" cy="10" r="8" class="fill"/><path d="M6.2 10.2l2.6 2.6 5-5.2" class="tick"/>',
      active: '<circle cx="10" cy="10" r="7" fill="none"/><circle cx="10" cy="10" r="2.6" class="fill"/>',
      paused: '<circle cx="10" cy="10" r="7" fill="none"/><path d="M8 7v6M12 7v6"/>',
      open: '<circle cx="10" cy="10" r="7" fill="none"/>',
      resolved: '<circle cx="10" cy="10" r="8" class="fill"/><path d="M6.2 10.2l2.6 2.6 5-5.2" class="tick"/>',
      // RSVP and reading states reuse the same shape language.
      yes: '<circle cx="10" cy="10" r="8" class="fill"/><path d="M6.2 10.2l2.6 2.6 5-5.2" class="tick"/>',
      maybe: '<circle cx="10" cy="10" r="7" fill="none"/><path d="M10 3a7 7 0 0 1 0 14z" class="fill"/>',
      no: '<circle cx="10" cy="10" r="7" fill="none"/><path d="M7.3 7.3l5.4 5.4M12.7 7.3l-5.4 5.4"/>',
      want: '<circle cx="10" cy="10" r="7" fill="none"/>',
      reading: '<circle cx="10" cy="10" r="7" fill="none"/><path d="M10 3a7 7 0 0 1 0 14z" class="fill"/>',
      finished: '<circle cx="10" cy="10" r="8" class="fill"/><path d="M6.2 10.2l2.6 2.6 5-5.2" class="tick"/>'
    }[status] || '';
    return `<svg class="mark mk-${esc(status)} ${cls}" viewBox="0 0 20 20" aria-hidden="true">${inner}</svg>`;
  }
  const statusLabel = (s) => `<span class="status st-${esc(s)}">${mark(s)}${esc(STATUS[s] || s)}</span>`;
  const goalStatusLabel = (s) => `<span class="status st-${esc(s)}">${mark(s)}${esc(GOAL_STATUS[s] || s)}</span>`;
  const avatar = (id, cls = '') => `<span class="avatar ${cls}" aria-hidden="true">${esc(initials(memberName(id)))}</span>`;
  function goalTag(goalId) {
    const g = goalById(goalId);
    if (!g) return '';
    return `<span class="goal-tag"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="2.2"/></svg><span class="goal-tag-text">${esc(g.title)}</span></span>`;
  }
  const chev = '<svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5L10.5 8 6 12.5"/></svg>';
  const back = (href, label) => `<a class="back-link" href="${href}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5L5.5 8 10 12.5"/></svg>${esc(label)}</a>`;
  const empty = (text, actionHtml = '') => `<div class="empty">${emptyArt()}<p>${esc(text)}</p>${actionHtml}</div>`;
  // Designed screen header: the motif sits behind it (see setMotif), display title, one-line subtitle, accent hairline.
  // backHtml goes above the title; `flush` drops the hairline when a band follows (Track).
  const pageHead = (title, sub, { backHtml = '', flush = false, lead = '' } = {}) => `<header class="page-head ${flush ? 'flush' : ''}">
      ${backHtml}${lead}<h1 class="page-title">${esc(title)}</h1>${sub ? `<p class="page-sub">${esc(sub)}</p>` : ''}</header>`;
  const extIcon = '<svg class="ext" viewBox="0 0 16 16" aria-hidden="true"><path d="M9 3h4v4M13 3L7.5 8.5M11.5 9.5V13H3V4.5h3.5"/></svg>';
  const pinIcon = '<svg class="pin" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 2h4l-.6 4.2L12 8.5v1H4v-1l2.6-2.3zM8 9.5V14"/></svg>';
  const lockIcon = '<svg class="lock" viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1.2"/><path d="M5.5 7V5.3a2.5 2.5 0 0 1 5 0V7"/></svg>';
  const heart = (on) => `<svg class="heart ${on ? 'on' : ''}" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 16.4s-6.2-3.7-6.2-8.2A3.3 3.3 0 0 1 10 6.3a3.3 3.3 0 0 1 6.2 1.9c0 4.5-6.2 8.2-6.2 8.2z"/></svg>`;

  /* ---------- Group content: shared vocab ---------- */
  const RSVP = { yes: 'Going', maybe: 'Maybe', no: "Can't go" };
  const READ = { want: 'Want to read', reading: 'Reading', finished: 'Finished' };
  const READ_SHORT = { want: 'Want', reading: 'Reading', finished: 'Finished' };
  const IDEA_TYPES = { idea: 'Idea', link: 'Link', tool: 'Tool', article: 'Article', podcast: 'Podcast', other: 'Other' };
  const GT_KINDS = { coffee: 'Coffee', lunch: 'Lunch', dinner: 'Dinner', visit: 'Visit', other: 'Other' };
  const GT_MIN = { coffee: 60, lunch: 75, dinner: 120, visit: 120, other: 90 }; // length used for calendar files
  const gtMinutes = (e) => GT_MIN[e.kind] || 90;
  const WG = [['W', 'Wonder'], ['I', 'Invention'], ['D', 'Discernment'], ['G', 'Galvanizing'], ['E', 'Enablement'], ['T', 'Tenacity']];
  const WG_NAME = Object.fromEntries(WG);
  const WG_GAP = {
    W: "big questions about why we're doing this may not get asked",
    I: 'fresh solutions may run thin',
    D: 'ideas may not get a good gut check',
    G: 'good ideas may stall without someone to rally people',
    E: 'people may be left waiting for a hand',
    T: 'watch for follow-through gaps'
  };
  // Ask "needs" -> Working Genius types that fit.
  const NEEDS = {
    starting: { label: 'Getting started', fits: ['G', 'I'] },
    deciding: { label: 'Making a decision', fits: ['D'] },
    finishing: { label: 'Finishing', fits: ['T'] },
    hands: { label: 'Extra hands', fits: ['E'] },
    exploring: { label: 'Exploring options', fits: ['W'] }
  };
  const geniusesOf = (m) => (m && m.workingGenius && m.workingGenius.geniuses) || [];
  function wgChips(m) {
    const g = geniusesOf(m);
    if (!g.length) return '';
    return `<span class="wg-chips" title="${esc(g.map((k) => WG_NAME[k]).join(', '))}" aria-label="Geniuses: ${esc(g.map((k) => WG_NAME[k]).join(', '))}">${g.map((k) => `<span class="wg-chip">${esc(k)}</span>`).join('')}</span>`;
  }

  // RSVP segmented control (status by color + shape).
  function rsvpControl(current, id, label) {
    return `<div class="segmented rsvp-seg" role="radiogroup" aria-label="${esc(label)}" data-rsvp-for="${esc(id)}">
      ${['yes', 'maybe', 'no'].map((s) => `<button type="button" role="radio" aria-checked="${current === s}" class="seg-${s} ${current === s ? 'on' : ''}" data-rsvp="${s}">${mark(s)}${RSVP[s]}</button>`).join('')}
    </div>`;
  }
  function bindRsvp(fn) {
    $$('[data-rsvp-for] [data-rsvp]').forEach((b) => b.addEventListener('click', async () => {
      if (b.classList.contains('on')) return;
      await fn(b.closest('[data-rsvp-for]').dataset.rsvpFor, b.dataset.rsvp);
      await refresh();
      toast(b.dataset.rsvp === 'yes' ? "You're going" : b.dataset.rsvp === 'maybe' ? 'Marked maybe' : "Marked can't go");
      rerender();
    }));
  }

  // Comment threads look the same on announcements, ideas and books.
  function commentsSection(comments, placeholder) {
    const list = (comments || []).slice().sort((a, b) => ts(a.createdAt) - ts(b.createdAt));
    return `<h2 class="sec">Comments<span class="sec-count">${list.length}</span></h2>
      ${list.length ? `<ol class="thread">${list.map((c) => `<li>${avatar(c.memberId, 'sm')}<div>
        <p class="th-head"><b>${esc(youOr(c.memberId))}</b><span class="when">${esc(relTime(c.createdAt))}</span></p>
        <p>${esc(c.text)}</p></div></li>`).join('')}</ol>` : '<p class="soon-line">No comments yet. Start the conversation.</p>'}
      <form id="comment-form" class="reply-form">
        <label for="comment-text" class="label">Add a comment</label>
        <textarea id="comment-text" rows="2" maxlength="400" placeholder="${esc(placeholder)}"></textarea>
        <button class="btn btn-ghost" type="submit">Post comment</button>
      </form>`;
  }
  function bindComments(save) {
    const f = $('#comment-form');
    if (!f) return;
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = $('#comment-text').value.trim();
      if (!text) { toast('Write a comment first'); return; }
      await save(text);
      await refresh();
      toast('Comment posted');
      rerender();
    });
  }

  // Announcements: "new" means posted by someone else since you last opened the list.
  const annSeenKey = () => `annSeen:${state.me.id}`;
  function annLastSeen() { return store.get(annSeenKey(), null) || new Date(Date.now() - 7 * DAY).toISOString(); }
  function newAnnouncements() {
    const seen = ts(annLastSeen());
    return state.announcements.filter((a) => !isMe(a.authorId) && ts(a.createdAt) > seen);
  }
  const sortedAnnouncements = () => state.announcements.slice()
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || ts(b.createdAt) - ts(a.createdAt));

  // Books
  const groupBook = () => state.books.find((b) => b.groupBook) || null;
  const readersOf = (bookId, status) => state.readingList.filter((r) => r.bookId === bookId && (!status || r.status === status));
  const myReading = (bookId) => state.readingList.find((r) => r.bookId === bookId && isMe(r.memberId));
  function cover(b, cls = '') {
    const words = b.title.replace(/^(the|a|an)\s+/i, '').split(/[\s:]+/).filter(Boolean);
    const ini = words.slice(0, 2).map((w) => w[0]).join('').toUpperCase();
    let h = 0;
    for (const ch of b.id + b.title) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return `<span class="cover cv${h % 4} ${cls}" aria-hidden="true">${esc(ini)}</span>`;
  }
  function stageCounts(bookId) {
    return `<span class="stage-counts">${['want', 'reading', 'finished'].map((s) => {
      const n = readersOf(bookId, s).length;
      return n ? `<span class="st-${s}">${mark(s)}${n} ${READ_SHORT[s].toLowerCase()}</span>` : '';
    }).join('')}</span>`;
  }

  // Get-togethers: closed ones are visible to the host, invitees and admins only.
  const canSeeGT = (e) => e.visibility !== 'closed' || isAdmin() || isMe(e.hostId) || e.invitees.includes(state.me.id);
  const gtIsPast = (e) => ts(e.datetime) + gtMinutes(e) * 60000 <= Date.now();
  const visibleGTs = () => state.gettogethers.filter(canSeeGT).sort((a, b) => ts(a.datetime) - ts(b.datetime));
  const upcomingGTs = () => visibleGTs().filter((e) => !gtIsPast(e) && !e.cancelled);
  const myGTRsvp = (e) => (e.rsvps.find((r) => isMe(r.memberId)) || {}).status;
  const goingCount = (e) => e.rsvps.filter((r) => r.status === 'yes').length;

  // Rules acceptance, per group (store is already group-scoped), per member and, with
  // Supabase, per rules version (the server keeps the record; the device remembers it too).
  const rulesKey = () => `rules:${state.me.id}${state.config.rulesVersion > 1 ? `:v${state.config.rulesVersion}` : ''}`;
  const hasRules = () => Array.isArray(state.config.rules) && state.config.rules.length > 0;
  const rulesAccepted = () => !hasRules() || !!store.get(rulesKey(), null)
    || !!(SUPA && state.session && state.session.memberId === state.me.id && state.session.rulesAcceptedAt
      && (state.session.rulesVersion || 1) === (state.config.rulesVersion || 1));

  /* ---------- Calendar (.ics) ---------- */
  function downloadICS(meeting) {
    const agendaText = agendaWithTimes(meeting).rows
      .map((r) => `${fmtTime.format(r.start)} ${r.item} (${memberName(r.owner)})`).join('\n');
    const loc = meetingLocation(meeting);
    const zoom = isZoom(loc);
    saveICS({
      id: meeting.id, title: meeting.title, start: new Date(meeting.datetime), end: meetingEnd(meeting),
      description: (zoom ? `Join: ${loc.url}\n\n` : '') + agendaText,
      location: zoom ? loc.url : [placeName(loc), loc.address].filter(Boolean).join(', '), alarm: '-P1D'
    });
  }
  function downloadGetTogetherICS(e) {
    const start = new Date(e.datetime);
    saveICS({
      id: e.id, title: e.title, start, end: new Date(start.getTime() + gtMinutes(e) * 60000),
      description: [`Hosted by ${memberName(e.hostId)}`, e.note].filter(Boolean).join('\n'), location: e.location, alarm: '-PT2H'
    });
  }
  function saveICS({ id, title, start, end, description, location, alarm }) {
    const toICS = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const escICS = (s) => String(s).replace(/\\/g, '\\\\').replace(/([,;])/g, '\\$1').replace(/\n/g, '\\n');
    const lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Mastermind//Prototype//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:${id}@${GROUP}.mastermind`,
      `DTSTAMP:${toICS(new Date())}`,
      `DTSTART:${toICS(start)}`,
      `DTEND:${toICS(end)}`,
      `SUMMARY:${escICS(title)}`,
      `DESCRIPTION:${escICS(description || '')}`,
      location ? `LOCATION:${escICS(location)}` : '',
      'BEGIN:VALARM', `TRIGGER:${alarm}`, 'ACTION:DISPLAY', `DESCRIPTION:${escICS(title)}`, 'END:VALARM',
      'END:VEVENT', 'END:VCALENDAR'
    ].filter(Boolean);
    // Fold lines longer than 75 characters (RFC 5545): continuation lines start with a space.
    const fold = (l) => {
      if (l.length <= 75) return l;
      const out = [l.slice(0, 75)];
      for (let i = 75; i < l.length; i += 74) out.push(` ${l.slice(i, i + 74)}`);
      return out.join('\r\n');
    };
    const blob = new Blob([lines.map(fold).join('\r\n')], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${id}.ics`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* ---------- Bottom sheet ---------- */
  const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function openSheet(html, onMount) {
    const root = $('#sheet-root');
    root.innerHTML = `<div class="sheet-backdrop" data-close></div>
      <div class="sheet" role="dialog" aria-modal="true"><div class="grab" aria-hidden="true"></div>${html}</div>`;
    root.querySelector('[data-close]').addEventListener('click', closeSheet);
    $$('[data-cancel]', root).forEach((b) => b.addEventListener('click', closeSheet));
    document.addEventListener('keydown', escClose);
    const sheet = root.querySelector('.sheet');
    if (onMount) onMount(sheet);
    const first = sheet.querySelector('input, textarea, select');
    if (first) setTimeout(() => first.focus({ preventScroll: true }), 50);
  }
  function escClose(e) { if (e.key === 'Escape') closeSheet(); }
  function closeSheet(immediate) {
    const root = $('#sheet-root');
    document.removeEventListener('keydown', escClose);
    if (!root.innerHTML) return;
    if (immediate === true || reduceMotion()) { root.innerHTML = ''; return; }
    root.classList.add('closing');
    setTimeout(() => {
      root.innerHTML = ''; root.classList.remove('closing');
      if (state.pendingRemote && state.me) applyRemote();
    }, 200);
  }

  /* ---------- Shell ---------- */
  function applyBranding(cfg) {
    const r = document.documentElement.style;
    r.setProperty('--primary', cfg.colors.primary);
    r.setProperty('--accent', cfg.colors.accent);
    r.setProperty('--bg', cfg.colors.background);
    r.setProperty('--text', cfg.colors.text);
    document.documentElement.dataset.group = GROUP;
    document.title = cfg.name;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', cfg.colors.background);
    // Extra palette tokens from the config (both groups set them).
    const extra = { surface: '--surface', muted: '--muted', rule: '--rule', good: '--s-done', goodBg: '--good-bg', secondary: '--secondary' };
    Object.keys(extra).forEach((k) => { if (cfg.colors[k]) r.setProperty(extra[k], cfg.colors[k]); });
    const logo = $('#logo');
    if (cfg.logoSvg) {
      // The Shoreline: inline mark so the letters use the page's Fraunces.
      logo.innerHTML = shorelineLogoSVG(44, 'var(--primary)');
      logo.classList.add('logo-svg');
    } else if (cfg.logoMask) {
      r.setProperty('--logo-mask', `url("${cfg.logoMask}")`);
      logo.textContent = '';
      logo.classList.add('logo-mask');
    } else {
      logo.textContent = cfg.logoText;
    }
    $('#group-name').textContent = cfg.name;
    const sub = $('#group-sub');
    sub.textContent = cfg.subtitle || '';
    sub.hidden = !cfg.subtitle;
  }

  /* ---------- Flight Club motifs (entrepreneur only) ----------
     Inline SVG so they take the palette and need no extra files. */
  const FC = GROUP === 'entrepreneur';
  let motifSeq = 0;
  // Stippled clouds: dot-halftone cloud bands, cream dots on navy. Invite and roster screens only.
  function cloudsSVG(pos = 'top') {
    // Cloud bands from the approved mock: a dot pattern clipped to lumpy cloud paths, densest at the
    // screen edge. The shorter band uses a half-offset dot grid, so where it overlaps the deeper band
    // the dots double up and the two bumpy edges read as separate layers of cloud.
    const n = ++motifSeq;
    const deep = 'M-10 0h350v76c-30 12-60-8-90 6-28 14-52-10-86 0-36 10-62-14-96 2-32 16-58-4-78-2z';
    const high = 'M-10 0h350v48c-40 8-70-6-110 4-30 8-55-8-90 0-40 8-70-12-100 0-22 8-40-2-50-4z';
    return `<svg class="clouds clouds-${pos}" viewBox="0 0 330 130" aria-hidden="true" focusable="false">
      <defs>
        <pattern id="fcd${n}" width="6" height="6" patternUnits="userSpaceOnUse"><circle cx="3" cy="3" r="1.15" fill="#F4EFE3" fill-opacity=".35"/></pattern>
        <pattern id="fce${n}" width="6" height="6" patternUnits="userSpaceOnUse" x="3" y="3"><circle cx="3" cy="3" r="1.15" fill="#F4EFE3" fill-opacity=".35"/></pattern>
        <linearGradient id="fcf${n}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="96"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity=".45"/></linearGradient>
        <mask id="fcm${n}" maskUnits="userSpaceOnUse" x="-10" y="0" width="350" height="130"><rect x="-10" width="350" height="130" fill="url(#fcf${n})"/></mask>
      </defs>
      <g mask="url(#fcm${n})">
        <path fill="url(#fcd${n})" d="${deep}"/>
        ${pos === 'top' ? `<path fill="url(#fce${n})" d="${high}"/>` : ''}
      </g></svg>`;
  }
  // Wings of the dawn: faint gold contour lines rising, plus a few faint navy rays from the horizon.
  function dawnSVG(pos = 'top') {
    const lines = pos === 'top' ? [[125, .55], [108, .42], [91, .3], [74, .2], [57, .12]] : [[125, .45], [108, .3], [91, .18]];
    const path = (y) => `M0 ${y} C70 ${y - 30} 130 ${y - 30} 200 ${y} S330 ${y + 5} 330 ${y - 13}`;
    return `<svg class="dawn dawn-${pos}" viewBox="0 0 330 150" aria-hidden="true" focusable="false">
      <g stroke="#C9973A" stroke-width=".9" fill="none">${lines.map(([y, o]) => `<path d="${path(y)}" opacity="${o}"/>`).join('')}</g>
      ${pos === 'top' ? `<g stroke="#152238" stroke-width=".6" opacity=".16"><line x1="165" y1="150" x2="30" y2="0"/><line x1="165" y1="150" x2="110" y2="0"/><line x1="165" y1="150" x2="220" y2="0"/><line x1="165" y1="150" x2="300" y2="0"/></g>` : ''}
    </svg>`;
  }
  /* ---------- The Shoreline (family) brand pieces ---------- */
  const SL = GROUP === 'family';
  // The approved "In a circle" mark, drawn inline so M·S use the loaded Fraunces face.
  // A mask knocks the palm lines out around the letters, so it works on any background.
  function shorelineLogoSVG(size, color = 'currentColor', label = '') {
    const n = ++motifSeq;
    const palm = ['M50 92 V40', 'M50 40 C40 25 25 22 12 28 C25 28 36 34 50 40z', 'M50 40 C60 25 75 22 88 28 C75 28 64 34 50 40z',
      'M50 40 C44 24 46 12 56 6 C52 16 52 28 50 40z', 'M50 40 C56 24 54 12 44 6 C48 16 48 28 50 40z',
      'M50 40 C36 36 22 40 14 50 C26 44 40 44 50 40z', 'M50 40 C64 36 78 40 86 50 C74 44 60 44 50 40z', 'M30 92 H70'];
    const text = (fill, extra = '') => `<text x="50" y="80" text-anchor="middle" font-family="Fraunces, 'Iowan Old Style', Georgia, serif" font-style="italic" font-weight="600" font-size="17" fill="${fill}" ${extra}>M<tspan font-size="12" dy="-1"${fill === '#000' ? '' : ' fill="#E0A458"'}> &#183; </tspan><tspan dy="1">S</tspan></text>`;
    return `<svg class="sl-mark" width="${size}" height="${size}" viewBox="0 0 100 100" ${label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true" focusable="false"'} style="color:${color}">
      <defs><mask id="slk${n}" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100"><rect width="100" height="100" fill="#fff"/>
        ${text('#000', 'stroke="#000" stroke-width="5" stroke-linejoin="round"')}</mask></defs>
      <circle cx="50" cy="50" r="47" fill="none" stroke="currentColor" stroke-width="1.8"/>
      <circle cx="50" cy="50" r="42" fill="none" stroke="#E0A458" stroke-width=".9" stroke-dasharray="1.5 3"/>
      <g transform="translate(15 13) scale(.7)">
        <g mask="url(#slk${n})" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${palm.map((d) => `<path d="${d}"/>`).join('')}</g>
        ${text('currentColor')}
      </g></svg>`;
  }
  // Palm fronds: a curved midrib with leaflets swept back along it, reaching in from the corners.
  function frondPath(x0, y0, cx, cy, x1, y1, len) {
    const pt = (t) => [(1 - t) * (1 - t) * x0 + 2 * (1 - t) * t * cx + t * t * x1, (1 - t) * (1 - t) * y0 + 2 * (1 - t) * t * cy + t * t * y1];
    const tan = (t) => { const dx = 2 * (1 - t) * (cx - x0) + 2 * t * (x1 - cx); const dy = 2 * (1 - t) * (cy - y0) + 2 * t * (y1 - cy); const l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l]; };
    let d = `M${x0} ${y0}Q${cx} ${cy} ${x1} ${y1}`;
    for (let t = 0.1; t < 0.95; t += 0.085) {
      const [px, py] = pt(t); const [tx, ty] = tan(t);
      const L = len * (1.35 - t * 1.05);
      [1, -1].forEach((s) => {
        // leaflet: swept forward along the rib, out to the side, then drooping (gravity on +y)
        const nx = s * -ty; const ny = s * tx;
        const ex = px + (tx * 0.5 + nx * 0.85) * L; const ey = py + (ty * 0.5 + ny * 0.85) * L + L * 0.22;
        const mx = px + (tx * 0.2 + nx * 0.5) * L; const my = py + (ty * 0.2 + ny * 0.5) * L;
        d += `M${px.toFixed(1)} ${py.toFixed(1)}Q${mx.toFixed(1)} ${my.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`;
      });
    }
    return d;
  }
  let frondCache = null;
  function frondPaths() {
    if (frondCache) return frondCache;
    frondCache = [
      [frondPath(-14, 10, 60, 2, 128, 60, 15), 1],
      [frondPath(-8, -12, 52, 22, 96, 92, 12), .75],
      [frondPath(18, -14, 92, 6, 150, 26, 10), .6],
      [frondPath(344, 18, 270, 6, 206, 64, 15), 1],
      [frondPath(338, -10, 286, 30, 246, 96, 12), .75],
      [frondPath(312, -14, 246, 4, 188, 22, 10), .6]
    ];
    return frondCache;
  }
  // tone: 'light' = cream on green (invite, roster); 'dark' = green on sand (inside the app)
  function frondsSVG(pos = 'top', tone = 'dark') {
    const ink = tone === 'light' ? '#F4EFE2' : '#1F4D3A';
    const op = tone === 'light' ? (pos === 'top' ? .28 : .22) : (pos === 'top' ? .14 : .11);
    const list = pos === 'top' ? frondPaths() : frondPaths().filter((_, i) => i % 3 !== 2);
    return `<svg class="fronds fronds-${pos}" viewBox="0 0 330 140" aria-hidden="true" focusable="false">
      <g fill="none" stroke="${ink}" stroke-width=".85" stroke-linecap="round" opacity="${op}">${list.map(([d, o]) => `<path d="${d}" opacity="${o}"/>`).join('')}</g></svg>`;
  }
  // Each group's motif, in one place.
  // The Shoreline invite and roster: the approved board's simple lines (brand/shoreline-palette-reference.html,
  // invite mock): thin cream Q-curves from the top corners, a lighter mirrored set at the bottom (flipped in CSS).
  function shorelineLinesSVG(pos = 'top') {
    const top = pos === 'top';
    const paths = top
      ? ['M-10 20 Q80 10 150 60', 'M20 0 Q90 30 140 70', 'M-10 60 Q70 50 130 80', ['M40 0 Q100 50 135 75', .6], 'M310 30 Q230 20 170 70', 'M290 0 Q220 40 175 80', 'M310 80 Q240 60 180 90']
      : ['M-10 20 Q80 10 150 60', 'M20 0 Q90 30 140 70', 'M310 30 Q230 20 170 70', 'M290 0 Q220 40 175 80'];
    return `<svg class="fronds fronds-${pos}" viewBox="0 0 300 ${top ? 200 : 160}" aria-hidden="true" focusable="false">
      <g fill="none" stroke="#F7F1E3" stroke-width="1" stroke-linecap="round" opacity="${top ? .28 : .22}">${paths.map((d) => (Array.isArray(d) ? `<path d="${d[0]}" opacity="${d[1]}"/>` : `<path d="${d}"/>`)).join('')}</g></svg>`;
  }
  const gateMotif = (pos) => (FC ? cloudsSVG(pos) : shorelineLinesSVG(pos));
  // The Shoreline after login: filled palm-frond silhouettes ("C · top and bottom"), top-right and bottom-left.
  // The invite and roster screens keep the line-drawn fronds (gateMotif).
  const shorelineFrond = (pos) => (pos === 'top'
    ? '<img class="frond-img frond-tr" src="brand/frond-tr-green.png" alt="" width="750" height="520" decoding="async">'
    : '<img class="frond-img frond-bl" src="brand/frond-bl-green.png" alt="" width="750" height="560" decoding="async">');
  const pageMotif = (pos) => (FC ? dawnSVG(pos) : shorelineFrond(pos));
  // Small line drawing for empty states, in the group's motif.
  function emptyArt() {
    if (FC) {
      return `<svg class="empty-art" viewBox="0 0 120 56" aria-hidden="true" focusable="false"><g fill="none" stroke-linecap="round">
        <path d="M30 48a30 30 0 0 1 60 0" stroke="var(--gold)" stroke-width="1.4"/>
        <path d="M8 48h104" stroke="var(--primary)" stroke-width="1.2"/>
        ${[40, 33, 26].map((y, i) => `<path d="M4 ${y} C34 ${y - 12} 60 ${y - 12} 86 ${y} S116 ${y + 2} 116 ${y - 6}" stroke="var(--gold)" stroke-width=".9" opacity="${0.7 - i * 0.2}"/>`).join('')}
        <path d="M60 18V8M44 22l-5-8M76 22l5-8" stroke="var(--primary)" stroke-width="1.2" opacity=".5"/></g></svg>`;
    }
    return `<svg class="empty-art" viewBox="0 0 120 56" aria-hidden="true" focusable="false"><g fill="none" stroke-linecap="round">
      <path d="${frondPath(14, 46, 50, 8, 104, 18, 9)}" stroke="var(--primary)" stroke-width=".9" opacity=".55"/>
      <path d="M6 50h108" stroke="var(--gold)" stroke-width="1.4"/></g></svg>`;
  }

  // Which motif a screen gets. Home: top and bottom. Screens with a designed header: behind the header.
  function setMotif(kind) {
    const top = $('#motif-top'); const bottom = $('#motif-bottom');
    // Flight Club: dawn lines on top for Home and titled pages, bottom on Home only.
    // The Shoreline: both fronds on every screen after login; the bottom one sits in the page's end padding.
    const withBottom = FC ? kind === 'home' : !!kind;
    top.innerHTML = kind ? pageMotif('top') : '';
    bottom.innerHTML = withBottom ? pageMotif('bottom') : '';
    top.dataset.kind = kind || '';
    document.documentElement.classList.toggle('has-motif-bottom', withBottom);
  }

  // "Built by TPG" + hexagon mark, linked to config.credit.url.
  function creditHTML() {
    const c = state.config.credit;
    if (!c || !c.label) return '';
    const parts = String(c.label).split(/\s+(?=TPG$)/);
    const labelHTML = parts.length === 2 ? `${esc(parts[0])} <b>${esc(parts[1])}</b>` : esc(c.label);
    const inner = `<span class="credit-text">${labelHTML}</span><span class="credit-mark" aria-hidden="true"></span>`;
    return c.url
      ? `<a class="credit" href="${esc(c.url)}" target="_blank" rel="noopener">${inner}</a>`
      : `<span class="credit">${inner}</span>`;
  }

  function setView(html, tab, opts = {}) {
    const view = $('#view');
    const path = location.hash;
    const animate = state.lastPath !== path;
    state.lastPath = path;
    document.documentElement.classList.toggle('is-gate', !!opts.gate);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', opts.gate ? state.config.colors.primary : state.config.colors.background);
    const motif = opts.gate ? null
      : tab === 'home' ? 'home'
        : html.includes('class="page-head') ? 'title' : FC ? null : 'plain';
    setMotif(motif);
    view.classList.remove('enter');
    // Maker credit at the end of every screen after login (chrome visible); not on the invite, roster or rules gates.
    view.innerHTML = html + (!opts.gate && !$('#tabbar').hidden ? creditHTML() : '');
    if (animate) { void view.offsetWidth; view.classList.add('enter'); }
    $$('#tabbar a').forEach((a) => {
      const on = a.dataset.tab === tab;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  }
  function rerender() { state.lastPath = location.hash; route(true); }

  function showChrome(on) {
    $('#topbar').hidden = !on;
    $('#tabbar').hidden = !on;
    if (on && state.me) {
      const btn = $('#me-btn');
      btn.textContent = initials(state.me.name);
      btn.setAttribute('aria-label', `Profile: ${state.me.name}`);
    }
  }

  async function refresh() { await loadData(); }

  /* ---------- Onboarding ---------- */
  function renderInvite(error) {
    showChrome(false);
    const cfg = state.config;
    const v = cfg.verse || {};
    // One gate for both groups: full primary color, the group's motif top and bottom, the logo large.
    setView(`
      <div class="gate">
        ${gateMotif('top')}
        <div class="gate-inner">
          ${gateLogo(cfg, false)}
          <h1 class="gate-word">${esc(cfg.name)}</h1>
          ${cfg.subtitle ? `<p class="gate-sub">${esc(cfg.subtitle)}</p>` : ''}
          ${v.full ? `<blockquote class="gate-verse"><p>&ldquo;${esc(v.full)}&rdquo;</p><cite>${esc(v.ref || '')}</cite></blockquote>` : ''}
          ${cfg.dedication ? `<p class="gate-dedication">${esc(cfg.dedication)}</p>` : ''}
          <form id="invite-form" class="gate-form" novalidate>
            <label for="code" class="sr-only">Invite code</label>
            <input id="code" class="gate-input" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="Invite code" required ${error ? 'aria-invalid="true" aria-describedby="code-err"' : ''}>
            ${error ? `<p class="gate-error" id="code-err">${esc(error)}</p>` : ''}
            <button class="btn btn-gold btn-block" type="submit">${esc(cfg.enterLabel || 'Join the group')}</button>
          </form>
        </div>
        ${gateMotif('bottom')}
      </div>`, undefined, { gate: true });
    const input = $('#code');
    input.focus();
    let busy = false;
    $('#invite-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy) return;
      const code = input.value.trim().toUpperCase();
      if (!code) return renderInvite('Enter the invite code from your invite.');
      if (SUPA) {
        // The server checks the code and returns the roster for "Who are you?".
        busy = true;
        const btn = $('#invite-form button[type=submit]');
        btn.disabled = true;
        btn.setAttribute('aria-busy', 'true');
        try {
          state.members = await baseApi.verifyInvite(code);
        } catch (err) {
          return renderInvite(err && (err.code === 'network' || err.status === 0) ? friendlyError(err)
            : (err && err.message) || "That code doesn't match this group. Check your invite and try again.");
        }
        return renderWho();
      }
      if (code !== String(cfg.inviteCode || cfg.demoInviteCode || '').toUpperCase()) return renderInvite("That code doesn't match this group. Check your invite and try again.");
      store.set('verified', true);
      renderWho();
    });
  }

  // The group's logo for the gate screens: Flight Club's mask image, or The Shoreline's inline mark.
  function gateLogo(cfg, small) {
    if (cfg.logoSvg) return `<div class="gate-mark ${small ? 'sm' : ''}">${shorelineLogoSVG(small ? 72 : 120, 'var(--bg)', `${cfg.name} logo`)}</div>`;
    return `<div class="gate-logo ${small ? 'sm' : ''}" role="img" aria-label="${esc(cfg.name)} logo"></div>`;
  }

  function renderWho() {
    showChrome(false);
    const items = state.members.map((m) => `
      <button class="row" data-member="${esc(m.id)}">
        ${avatar(m.id)}
        <span class="row-main"><span class="row-title">${esc(m.name)}</span></span>
        ${m.role === 'admin' ? '<span class="role-tag">Admin</span>' : ''}
        ${chev}
      </button>`).join('');
    setView(`
      <div class="gate gate-who">
        ${gateMotif('top')}
        <div class="gate-inner">
          ${gateLogo(state.config, true)}
          <h1 class="gate-word">Who are you?</h1>
          <p class="gate-lede">Tap your name. You only do this once on this device.</p>
          <div class="rows">${items || '<p class="gate-lede">No names loaded.</p>'}</div>
          <button class="btn btn-ghost btn-block" id="who-back" type="button">Enter the invite code again</button>
        </div>
        ${gateMotif('bottom')}
      </div>`, undefined, { gate: true });
    $('#who-back').addEventListener('click', () => { store.remove('verified'); renderInvite(); });
    let busy = false;
    $$('[data-member]').forEach((b) => b.addEventListener('click', async () => {
      if (busy) return;
      const id = b.dataset.member;
      if (SUPA) {
        // Creates this device's session, then loads the group as that member.
        busy = true;
        $$('[data-member]').forEach((x) => { x.disabled = true; });
        b.setAttribute('aria-busy', 'true');
        try {
          await baseApi.join(id);
        } catch (err) {
          busy = false;
          $$('[data-member]').forEach((x) => { x.disabled = false; });
          b.removeAttribute('aria-busy');
          // 401: the code was rotated meanwhile. 400: the code isn't on this device any more (page reloaded).
          const again = err && (err.status === 401 || err.status === 400);
          if (again) { store.remove('verified'); return renderInvite('Enter the invite code again to continue.'); }
          toast(friendlyError(err), 4000);
          return;
        }
        await afterSignIn();
        if (!state.loaded) { store.set('user', id); return renderLoadError(); }
      }
      store.set('user', id);
      state.me = memberById(id) || state.members.find((m) => m.id === id);
      if (!state.me) { toast("Couldn't find you on the roster. Try again."); return renderWho(); }
      toast(`Welcome, ${state.me.name.split(' ')[0]}`);
      if (location.hash !== '#/home') location.hash = '#/home'; else route();
    }));
  }

  // Supabase: right after join, or on start with a saved session. Never throws:
  // anything that fails here leaves the cached copy (or an error panel with Retry).
  async function afterSignIn() {
    try {
      const cfg = await baseApi.getConfig();
      if (cfg && cfg.colors) { state.config = cfg; applyBranding(cfg); }
    } catch (e) { noteError(e); }
    try { state.session = await baseApi.getSession(); } catch (e) { noteError(e); }
    await loadData();
    await loadContact();
  }

  // Back to the invite screen. With Supabase this ends the session on the server too,
  // so signing in as someone else needs the code again.
  async function signOutToInvite() {
    if (SUPA) {
      await baseApi.signOut().catch(() => {});
      clearSignedInState();
      return route();
    }
    store.remove('user');
    state.me = null;
    renderWho();
  }
  function clearSignedInState() {
    store.remove('snapshot');
    store.remove('user');
    store.remove('verified');
    Object.assign(state, { me: null, session: null, myContact: null, prefs: null, contacts: null, members: [], offline: false });
  }

  // Shown once per member per device, after picking a name.
  function renderRulesGate() {
    showChrome(false);
    const cfg = state.config;
    setView(`
      <div class="onboard onboard-tight">
        ${cfg.logoSvg ? `<div class="logo-big logo-big-svg">${shorelineLogoSVG(96, 'var(--primary)')}</div>` : `<div class="logo-big" aria-hidden="true">${esc(cfg.logoText)}</div>`}
        <h1>Our ground rules</h1>
        <p class="lede">Hi ${esc(state.me.name.split(' ')[0])}. Everyone in ${esc(cfg.name)} agrees to these. You can reread them any time under Group.</p>
      </div>
      ${rulesList()}
      <button class="btn btn-primary btn-block" id="agree">I agree</button>
      <button class="link-btn" id="not-me">Not ${esc(state.me.name.split(' ')[0])}? Pick a different name</button>`);
    let busy = false;
    $('#agree').addEventListener('click', async () => {
      if (busy) return;
      if (SUPA) {
        busy = true;
        $('#agree').disabled = true;
        try {
          const at = await api.acceptRules(state.config.rulesVersion || 1);
          if (state.session) state.session.rulesAcceptedAt = at || new Date().toISOString();
        } catch (e) {
          busy = false;
          $('#agree').disabled = false;
          return; // toast shown; stay on the rules
        }
      }
      store.set(rulesKey(), new Date().toISOString());
      toast('Thanks. Welcome in.');
      if (location.hash !== '#/home') location.hash = '#/home'; else route();
    });
    $('#not-me').addEventListener('click', () => signOutToInvite());
  }
  const rulesList = () => `<ol class="rules-list">${state.config.rules.map((r) => `<li>${esc(r)}</li>`).join('')}</ol>`;

  /* ---------- Scores ---------- */
  function computeScores() {
    const past = state.meetings.filter(isPast);
    const nm = nextMeeting();
    const ciMeetings = past.filter((m) => state.checkins.some((k) => k.meetingId === m.id));
    const attMeetings = past.filter((m) => m.attendance && m.attendance.length);
    return state.members.map((mem) => {
      let kept = 0; let total = 0; const seq = [];
      past.forEach((m) => {
        const c = state.commitments.find((x) => x.meetingId === m.id && x.memberId === mem.id);
        if (!c) return;
        const follow = meetingAfter(m);
        const closed = follow && isPast(follow);
        const deadline = follow ? ts(follow.datetime) : Infinity;
        const ok = c.status === 'done' && ts(c.doneAt || c.updatedAt) <= deadline;
        // Open commitments only count once they're kept or their follow-up meeting has passed.
        if (closed || ok) { total++; if (ok) kept++; seq.push(ok); }
      });
      let streak = 0;
      for (let i = seq.length - 1; i >= 0 && seq[i]; i--) streak++;
      const ciOnTime = ciMeetings.filter((m) => { const k = checkinFor(m.id, mem.id); return k && ts(k.submittedAt) <= ts(m.datetime); }).length;
      const hsMeetings = past.filter((m) => m.hotSeatMemberId === mem.id);
      if (nm && nm.hotSeatMemberId === mem.id && hasPrep(nm)) hsMeetings.push(nm);
      const prepOnTime = hsMeetings.filter((m) => hasPrep(m) && ts(m.hotSeatPrep.submittedAt) <= prepDue(m).getTime()).length;
      const attended = attMeetings.filter((m) => m.attendance.includes(mem.id)).length;
      return {
        member: mem, kept, total, pct: total ? kept / total : -1, streak,
        checkins: [ciOnTime, ciMeetings.length], prep: [prepOnTime, hsMeetings.length], attendance: [attended, attMeetings.length]
      };
    }).sort((a, b) => b.pct - a.pct || b.kept - a.kept || a.member.name.localeCompare(b.member.name));
  }
  const streakText = (n) => (n >= 2 ? `${n} months in a row` : n === 1 ? 'Kept the last one' : '');

  /* ---------- Home ---------- */
  function countdown(nm) {
    const ms = ts(nm.datetime) - Date.now();
    const days = Math.ceil(ms / DAY);
    if (ms <= 0) return { num: '', unit: Date.now() < meetingEnd(nm).getTime() ? 'Happening now' : 'Just ended' };
    if (ms < 3600000) {
      const mins = Math.max(1, Math.ceil(ms / 60000));
      return { num: mins, unit: 'min to go' };
    }
    if (ms < DAY) {
      const hrs = Math.max(1, Math.round(ms / 3600000));
      return { num: hrs, unit: hrs === 1 ? 'hour to go' : 'hours to go' };
    }
    return { num: days, unit: days === 1 ? 'day to go' : 'days to go' };
  }

  function homeTasks(nm) {
    const me = state.me.id;
    const todo = []; const done = [];
    if (nm) {
      (myMeetingRsvp(nm) ? done : todo).push('rsvp');
      (checkinFor(nm.id, me) ? done : todo).push('checkin');
      if (nm.hotSeatMemberId === me) (hasPrep(nm) ? done : todo).push('prep');
    }
    const lm = lastMeeting();
    if (lm && lm.hotSeatMemberId === me) (lm.actionPlan ? done : todo).push('plan');
    const mine = myCommitment();
    if (mine) (mine.status === 'done' ? done : todo).push('commit');
    return { todo, done };
  }

  const myMeetingRsvp = (m) => ((m.rsvps || []).find((r) => isMe(r.memberId)) || {}).status;

  // What Home's hero and banner depend on over time; when it changes, Home re-renders (see init).
  let homeLiveKey = '';
  function liveKey() {
    const hm = heroMeeting();
    if (!hm) return 'none';
    const loc = meetingLocation(hm);
    const now = Date.now();
    const soon = isZoom(loc) && now >= ts(hm.datetime) - JOIN_EARLY && now < meetingEnd(hm).getTime();
    return [hm.id, inJoinWindow(hm), soon, now >= ts(hm.datetime)].join('|');
  }

  function renderHome() {
    const nm = nextMeeting();
    const lm = lastMeeting();
    const mine = myCommitment();
    const { todo, done } = homeTasks(nm);
    const nmLabel = nm ? fmtMD.format(new Date(nm.datetime)) : '';
    let html = '';
    const verse = state.config.verse;
    if (verse && verse.short) {
      html += `<p class="verse-line">&ldquo;${esc(verse.short)}&rdquo; <cite>${esc(verse.ref || '')}</cite></p>`;
    }

    // Reminder strip: the most useful single sentence right now.
    // Flight Club shows it under the hero, so the dawn motif above stays clear of text.
    // Hero shows the meeting that is about to start / running / just ended, else the next one.
    const hm = heroMeeting();
    const hLoc = hm ? meetingLocation(hm) : null;
    const hZoom = !!(hLoc && isZoom(hLoc));
    const joinHot = hZoom && inJoinWindow(hm);
    // Zoom meeting starting within 15 minutes (or running): the banner becomes the way in.
    const liveBanner = hZoom && Date.now() >= ts(hm.datetime) - JOIN_EARLY && Date.now() < meetingEnd(hm).getTime();
    let reminder = '';
    if (liveBanner && store.get('bannerDismissed', null) !== `${hm.id}:live`) {
      const started = Date.now() >= ts(hm.datetime);
      reminder = `<div class="reminder reminder-live" id="banner" role="status" data-dismiss="${esc(hm.id)}:live">
        ${videoIcon}
        <a class="reminder-link" href="${esc(hLoc.url)}" target="_blank" rel="noopener noreferrer"><span>${started ? 'Happening now' : 'Starting soon'} &middot; <u>Join Zoom</u></span></a>
        <button class="reminder-x" id="banner-close" aria-label="Dismiss reminder">&times;</button>
      </div>`;
    } else if (nm && store.get('bannerDismissed', null) !== `${nm.id}:${todo.length}`) {
      const ms = ts(nm.datetime) - Date.now();
      const text = ms < DAY ? `${nm.title} starts at ${fmtTime.format(new Date(nm.datetime))} today`
        : ms < 2 * DAY ? `${nm.title} is tomorrow at ${fmtTime.format(new Date(nm.datetime))}`
          : todo.length ? `${plural(todo.length, 'thing')} to finish before ${nmLabel}`
            : `Next meeting ${fmtDateShort.format(new Date(nm.datetime))}`;
      reminder = `<div class="reminder" id="banner" role="status" data-dismiss="${esc(nm.id)}:${todo.length}">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5a5 5 0 0 0-5 5v3.2L3.6 13.5h12.8L15 10.7V7.5a5 5 0 0 0-5-5zM8 15.5a2 2 0 0 0 4 0"/></svg>
        <span>${esc(text)}</span>
        <button class="reminder-x" id="banner-close" aria-label="Dismiss reminder">&times;</button>
      </div>`;
    }

    if (hm) {
      // Hero: the date sits on a gold horizon line that runs behind the digits.
      const start = new Date(hm.datetime);
      const end = meetingEnd(hm);
      const cd = countdown(hm);
      // "Join Zoom" is outlined until the join window opens, then it takes the filled accent from "Add to calendar".
      html += `<section class="flight ${joinHot ? 'is-live' : ''}" aria-label="${hm === nm ? 'Next meeting' : 'Current meeting'}">
        <p class="flight-eyebrow">${esc(hm === nm ? state.config.nextLabel || 'Next meeting' : 'Now')} &middot; ${esc(fmtWeekdayLong.format(start))}</p>
        <div class="flight-date">
          <span class="flight-day">${esc(fmtMD.format(start))}</span>
          <span class="flight-count"><b id="cd-num">${cd.num}</b> <span id="cd-unit">${esc(cd.unit)}</span></span>
        </div>
        <p class="flight-title">${esc(hm.title)}</p>
        <p class="flight-when">${esc(timeRange(start, end))} &middot; Central</p>
        <p class="flight-where">${locIcon(hLoc)}<span>${esc(locText(hLoc))}</span></p>
        <div class="flight-actions ${hZoom ? 'has-join' : ''}">
          <button class="btn ${joinHot ? 'btn-outline-light' : 'btn-gold'}" id="ics-btn">Add to calendar</button>
          <a class="btn btn-outline-light" href="#/meetings/${esc(hm.id)}">Agenda</a>
          ${hZoom ? `<a class="btn ${joinHot ? 'btn-gold' : 'btn-outline-light'} join-btn" id="join-btn" href="${esc(hLoc.url)}" target="_blank" rel="noopener noreferrer">${videoIcon}Join Zoom</a>` : ''}
        </div>
      </section>`;
    } else {
      html += `<section class="next next-none"><p class="next-title">No meeting on the calendar yet.</p><p class="next-when">Your admin adds the next date in Meetings.</p></section>`;
    }

    html += reminder;

    // To-do
    if (todo.length) {
      html += `<h2 class="sec">Before ${esc(nmLabel || 'the next meeting')}<span class="sec-count">${plural(todo.length, 'thing')} to do</span></h2><div class="tasks">`;
      todo.forEach((key) => {
        if (key === 'rsvp') {
          html += `<article class="task task-small" id="task-rsvp">
            <div class="task-head">${mark('not_started', 'task-mark')}<div><h3>Going on ${esc(nmLabel)}?</h3><p class="task-due">Helps the group plan seats and food</p></div></div>
            ${rsvpControl(null, nm.id, `Going to ${nm.title}?`)}
          </article>`;
        } else if (key === 'checkin') {
          html += `<article class="task" id="task-checkin">
            <div class="task-head">${mark('not_started', 'task-mark')}<div><h3>Check in for ${esc(nmLabel)}</h3><p class="task-due">Due before the meeting starts</p></div></div>
            <form id="checkin-form" class="task-body">
              <div class="field"><label for="ci-win">Your win since last meeting</label><textarea id="ci-win" rows="2" maxlength="280" placeholder="Big or small. It counts."></textarea></div>
              <div class="field"><label for="ci-ch">Your biggest challenge right now</label><textarea id="ci-ch" rows="2" maxlength="280" placeholder="What's in the way?"></textarea></div>
              <button class="btn btn-primary btn-block" type="submit">Submit check-in</button>
            </form>
          </article>`;
        } else if (key === 'prep') {
          const due = prepDue(nm);
          html += `<article class="task">
            <div class="task-head">${mark('not_started', 'task-mark')}<div><h3>Prep your hot seat</h3><p class="task-due ${due - Date.now() < 2 * DAY ? 'soon' : ''}">Due ${esc(fmtDateShort.format(due))}, ${esc(fmtTime.format(due))}</p></div></div>
            <p class="task-text">You're on the hot seat ${esc(nmLabel)}. Four short answers help the group come ready.</p>
            <a class="btn btn-primary btn-block" href="#/hotseat">Write your prep</a>
          </article>`;
        } else if (key === 'plan') {
          html += `<article class="task">
            <div class="task-head">${mark('not_started', 'task-mark')}<div><h3>Record your action plan</h3><p class="task-due">From your ${esc(fmtMonthLong.format(new Date(lm.datetime)))} hot seat</p></div></div>
            <p class="task-text">Write down the advice you're taking and your next step while it's fresh. It becomes your commitment.</p>
            <button class="btn btn-primary btn-block" data-plan="${esc(lm.id)}">Record action plan</button>
          </article>`;
        } else if (key === 'commit') {
          html += `<article class="task" id="task-commit">
            <div class="task-head">${mark(mine.status, 'task-mark')}<div><h3>Update your commitment</h3><p class="task-due">Mark it done when it's done</p></div></div>
            <p class="task-text commit-text">${esc(mine.text)}</p>
            ${goalTag(mine.goalId)}
            <div class="segmented" role="radiogroup" aria-label="Commitment status">
              ${Object.keys(STATUS).map((s) => `<button role="radio" aria-checked="${mine.status === s}" class="seg-${s} ${mine.status === s ? 'on' : ''}" data-status="${s}">${mark(s)}${STATUS[s]}</button>`).join('')}
            </div>
            <button class="link-btn" data-edit-commit="${esc(mine.id)}">${mine.lastUpdateNote ? 'Edit note' : 'Add a note'}</button>
          </article>`;
        }
      });
      html += '</div>';
    } else if (nm) {
      html += `<div class="all-set">
        <svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="20"/><path d="M15 24.5l6 6 12-13"/></svg>
        <div><h2>You're all set for ${esc(nmLabel)}</h2><p>Everything due before the meeting is in. See you there.</p></div>
      </div>`;
    }

    if (done.length) {
      const doneRow = (key) => {
        if (key === 'rsvp') {
          const s = myMeetingRsvp(nm);
          const text = s === 'yes' ? `Going on ${nmLabel}` : s === 'maybe' ? `Maybe for ${nmLabel}` : `Can't make ${nmLabel}`;
          return `<li>${mark(s)}<span>${esc(text)}</span><a class="link-btn" href="#/meetings/${esc(nm.id)}">Change</a></li>`;
        }
        if (key === 'checkin') return `<li>${mark('done')}<span>Checked in for ${esc(nmLabel)}</span><button class="link-btn" data-edit-checkin="${esc(nm.id)}">Edit</button></li>`;
        if (key === 'prep') return `<li>${mark('done')}<span>Hot seat prep is in</span><a class="link-btn" href="#/hotseat">View</a></li>`;
        if (key === 'plan') return `<li>${mark('done')}<span>Action plan recorded</span><a class="link-btn" href="#/hotseat">View</a></li>`;
        if (key === 'commit') return `<li>${mark('done')}<span>Commitment kept</span><button class="link-btn" data-edit-commit="${esc(mine.id)}">Edit</button></li>`;
        return '';
      };
      html += `<ul class="done-list" aria-label="Done">${done.map(doneRow).join('')}</ul>`;
    }

    // Quiet summaries
    const my = computeScores().find((s) => isMe(s.member.id));
    const openAsks = state.asks.filter((a) => a.status === 'open').sort((a, b) => ts(b.createdAt) - ts(a.createdAt));
    html += '<div class="quiet">';
    if (SUPA && state.myContact && !contactComplete()) {
      const miss = missingContact(state.myContact);
      html += `<a class="quiet-row contact-nudge" href="#/profile" id="contact-nudge"><span class="q-k">Reminders</span>
        <span class="q-v">Add your ${esc(miss)}<span class="q-sub">So reminders reach you</span></span>${chev}</a>`;
    }
    if (my && my.total) {
      html += `<a class="quiet-row" href="#/track/score"><span class="q-k">Your record</span>
        <span class="q-v">${my.kept} of ${my.total} commitments kept${my.streak >= 2 ? `<span class="q-sub">${esc(streakText(my.streak))}</span>` : ''}</span>${chev}</a>`;
    }
    html += `<a class="quiet-row" href="#/group/asks"><span class="q-k">Asks</span>
      <span class="q-v">${openAsks.length ? `${plural(openAsks.length, 'open ask')}<span class="q-sub">${esc(openAsks[0].title)}</span>` : 'No open asks'}</span>${chev}</a>`;
    if (nm) {
      const hs = nm.hotSeatMemberId;
      html += `<a class="quiet-row" href="#/hotseat"><span class="q-k">Hot seat</span>
        <span class="q-v">${hs ? `${esc(youOr(hs))}, ${esc(nmLabel)}<span class="q-sub">${hasPrep(nm) ? esc(nm.hotSeatPrep.problem) : 'Prep not in yet'}</span>` : 'No one assigned yet'}</span>${chev}</a>`;
    }
    const fresh = newAnnouncements().sort((a, b) => ts(b.createdAt) - ts(a.createdAt));
    if (fresh.length) {
      html += `<a class="quiet-row" href="#/group/announcements"><span class="q-k">News</span>
        <span class="q-v">${plural(fresh.length, 'new announcement')}<span class="q-sub">${esc(fresh[0].title)}</span></span>${chev}</a>`;
    }
    const gt = upcomingGTs()[0];
    if (gt) {
      const d = new Date(gt.datetime);
      html += `<a class="quiet-row" href="#/group/gettogethers/${esc(gt.id)}"><span class="q-k">Plans</span>
        <span class="q-v">${esc(gt.title)}<span class="q-sub">${esc(fmtDateShort.format(d))}, ${esc(fmtTime.format(d))}. ${goingCount(gt)} going</span></span>${chev}</a>`;
    }
    const gb = groupBook();
    if (gb) {
      const r = myReading(gb.id);
      html += `<a class="quiet-row" href="#/group/books/${esc(gb.id)}"><span class="q-k">Group book</span>
        <span class="q-v">${esc(gb.title)}<span class="q-sub">${r ? `You: ${esc(READ[r.status].toLowerCase())}` : `${readersOf(gb.id, 'reading').length} reading now`}</span></span>${chev}</a>`;
    }
    html += '</div>';

    setView(html, 'home');

    const bc = $('#banner-close');
    if (bc) bc.addEventListener('click', () => {
      store.set('bannerDismissed', $('#banner').dataset.dismiss);
      $('#banner').remove();
    });
    const ics = $('#ics-btn');
    if (ics) ics.addEventListener('click', () => { downloadICS(hm); toast('Calendar file downloaded'); });
    const cn = $('#contact-nudge');
    if (cn) cn.addEventListener('click', (e) => { e.preventDefault(); editContact(); });
    homeLiveKey = liveKey();

    const form = $('#checkin-form');
    if (form) form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const win = $('#ci-win').value.trim();
      const challenge = $('#ci-ch').value.trim();
      if (!win || !challenge) { toast('Add a win and a challenge'); return; }
      await api.saveCheckin({ meetingId: nm.id, memberId: state.me.id, win, challenge });
      await refresh();
      toast('Check-in submitted');
      rerender();
    });
    $$('#task-commit [data-status]').forEach((b) => b.addEventListener('click', async () => {
      if (b.dataset.status === mine.status) return;
      await api.updateCommitment(mine.id, { status: b.dataset.status });
      await refresh();
      toast(b.dataset.status === 'done' ? 'Commitment kept. Nice work.' : `Marked ${STATUS[b.dataset.status].toLowerCase()}`);
      rerender();
    }));
    bindRsvp((id, s) => api.setMeetingRsvp(id, state.me.id, s));
    bindCommon();
  }

  // Handlers shared across views (buttons that open sheets).
  function bindCommon() {
    $$('[data-edit-commit]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      editCommitment(state.commitments.find((c) => c.id === b.dataset.editCommit));
    }));
    $$('[data-edit-checkin]').forEach((b) => b.addEventListener('click', () => editCheckin(b.dataset.editCheckin)));
    $$('[data-plan]').forEach((b) => b.addEventListener('click', () => editActionPlan(b.dataset.plan)));
  }

  function editCheckin(meetingId) {
    const m = state.meetings.find((x) => x.id === meetingId);
    const k = checkinFor(meetingId, state.me.id) || { win: '', challenge: '' };
    openSheet(`
      <h2>Check in for ${esc(fmtMD.format(new Date(m.datetime)))}</h2>
      <p class="sheet-sub">The group reads these before the meeting.</p>
      <div class="field"><label for="s-win">Your win since last meeting</label><textarea id="s-win" rows="3" maxlength="280">${esc(k.win)}</textarea></div>
      <div class="field"><label for="s-ch">Your biggest challenge right now</label><textarea id="s-ch" rows="3" maxlength="280">${esc(k.challenge)}</textarea></div>
      <div class="sheet-actions"><button class="btn btn-ghost" data-cancel>Cancel</button><button class="btn btn-primary" id="s-save">Save check-in</button></div>`, (sheet) => {
      sheet.querySelector('#s-save').addEventListener('click', async () => {
        const win = sheet.querySelector('#s-win').value.trim();
        const challenge = sheet.querySelector('#s-ch').value.trim();
        if (!win || !challenge) { toast('Add a win and a challenge'); return; }
        await api.saveCheckin({ meetingId, memberId: state.me.id, win, challenge });
        await refresh();
        closeSheet();
        toast('Check-in saved');
        rerender();
      });
    });
  }

  /* ---------- Meetings ---------- */
  function meetingRow(m, isNext) {
    const d = new Date(m.datetime);
    const hs = m.hotSeatMemberId;
    return `<a class="row meeting-row ${isPast(m) ? 'is-past' : ''}" href="#/meetings/${esc(m.id)}">
      <span class="date-chip" aria-hidden="true"><span>${esc(fmtMonth.format(d))}</span><b>${esc(fmtDay.format(d))}</b></span>
      <span class="row-main">
        <span class="row-title">${esc(m.title)}${isNext ? '<span class="next-tag">Next</span>' : ''}</span>
        <span class="row-sub">${esc(fmtDateShort.format(d))}, ${esc(fmtTime.format(d))}${hs ? `. Hot seat: ${esc(isMe(hs) ? 'you' : firstName(hs))}` : ''}</span>
      </span>${chev}</a>`;
  }

  function renderMeetings() {
    const upcoming = state.meetings.filter((m) => !isPast(m));
    const past = state.meetings.filter(isPast).reverse();
    let html = `${pageHead('Meetings', 'Once a month. All times Central.')}
      <h2 class="sec">Upcoming</h2>
      ${upcoming.length ? `<div class="rows">${upcoming.map((m, i) => meetingRow(m, i === 0)).join('')}</div>` : empty('No upcoming meetings yet.')}`;
    const gts = upcomingGTs().slice(0, 4);
    html += `<h2 class="sec sec-lite">Get-togethers<a class="sec-action" href="#/group/gettogethers">${gts.length ? 'See all' : 'Plan one'}</a></h2>
      ${gts.length ? `<ul class="lite-list">${gts.map((e) => {
        const d = new Date(e.datetime);
        return `<li><a href="#/group/gettogethers/${esc(e.id)}">
          <span class="lite-when">${esc(fmtMD.format(d))}</span>
          <span class="lite-main"><span class="lite-title">${esc(e.title)}${e.visibility === 'closed' ? lockIcon : ''}</span>
          <span class="row-sub">${esc(fmtWeekday.format(d))} ${esc(fmtTime.format(d))}. ${esc(isMe(e.hostId) ? 'You host' : `${firstName(e.hostId)} hosts`)}, ${goingCount(e)} going</span></span>${chev}</a></li>`;
      }).join('')}</ul>` : '<p class="soon-line">Nothing planned between meetings. Coffee counts.</p>'}`;
    if (past.length) html += `<h2 class="sec">Past</h2><div class="rows">${past.map((m) => meetingRow(m, false)).join('')}</div>`;
    setView(html, 'meetings');
  }

  function renderMeetingDetail(id) {
    const m = state.meetings.find((x) => x.id === id);
    if (!m) return location.replace('#/meetings');
    const start = new Date(m.datetime);
    const past = isPast(m);
    const nm = nextMeeting();
    const showCheckins = past || (nm && nm.id === m.id);
    const ciCount = state.checkins.filter((k) => k.meetingId === m.id).length;
    const total = state.members.length;
    const { rows, end } = agendaWithTimes(m);
    const hs = m.hotSeatMemberId;
    const loc = meetingLocation(m);
    const zoom = isZoom(loc);
    const over = Date.now() > end.getTime() + JOIN_LATE;
    const g = groupLocation();
    const own = hasOwnLocation(m) && !sameLocation(loc, g);
    const whereSub = zoom ? shortUrl(loc.url) : loc.type === 'zoom' ? 'Link not added yet' : (placeName(loc) && loc.address) || 'In person';
    const whereNote = own && !over ? `<span class="where-note">Just this meeting. ${esc(g.type === 'zoom' ? 'Usually on Zoom' : `Usually: ${locText(g)}`)}.</span>` : '';

    let html = `${back('#/meetings', 'Meetings')}
      <h1 class="page-title">${esc(m.title)}</h1>
      <p class="page-sub">${esc(fmtDateLong.format(start))}<br>${esc(fmtTime.format(start))} &ndash; ${esc(fmtTime.format(end))} Central</p>
      <div class="rows where-card">
        <div class="row static where-row">
          <span class="loc-badge" aria-hidden="true">${locIcon(loc)}</span>
          <span class="row-main"><span class="where-k">Where</span>
            <span class="row-title ${loc.type === 'zoom' ? '' : 'is-addr'}">${esc(locText(loc))}</span>
            <span class="row-sub">${esc(whereSub)}</span>${whereNote}</span>
          ${zoom ? `<button class="icon-btn" id="copy-loc" aria-label="Copy Zoom link" title="Copy link">${copyIcon}</button>`
            : loc.address ? `<button class="icon-btn" id="copy-loc" aria-label="Copy address" title="Copy address">${copyIcon}</button>` : ''}
        </div>
        ${zoom && !over ? `<div class="where-actions"><a class="btn ${inJoinWindow(m) ? 'btn-primary' : 'btn-ghost'} btn-sm btn-block join-btn" href="${esc(loc.url)}" target="_blank" rel="noopener noreferrer">${videoIcon}Join Zoom</a></div>` : ''}
      </div>
      <div class="btn-row">
        ${!past ? '<button class="btn btn-ghost btn-sm" id="ics-btn">Add to calendar</button>' : ''}
        ${isAdmin() && !past ? `<button class="btn btn-ghost btn-sm" data-edit-meeting="${esc(m.id)}">Edit meeting</button>` : ''}
      </div>
      ${!past ? `<div class="rsvp-block"><span class="label">Are you going?</span>${rsvpControl(myMeetingRsvp(m), m.id, 'Are you going?')}</div>` : ''}
      <div class="rows">`;
    if (!past && isAdmin()) {
      const rs = m.rsvps || [];
      const n = (s) => rs.filter((r) => r.status === s).length;
      const silent = state.members.filter((x) => !rs.some((r) => r.memberId === x.id));
      html += `<div class="row static headcount"><span class="row-main"><span class="row-title">Headcount: ${n('yes')} going</span>
        <span class="row-sub">${n('maybe')} maybe, ${n('no')} can't go${silent.length ? `. No answer: ${esc(silent.map((x) => (isMe(x.id) ? 'you' : x.name.split(' ')[0])).join(', '))}` : ''}</span>
        <span class="meter" aria-hidden="true"><span style="width:${Math.round((n('yes') / total) * 100)}%"></span></span></span></div>`;
    }
    if (showCheckins) {
      html += `<a class="row" href="#/meetings/${esc(m.id)}/checkins">
        <span class="row-main"><span class="row-title">Check-ins</span>
        <span class="row-sub">${ciCount} of ${total} checked in</span>
        <span class="meter" aria-hidden="true"><span style="width:${Math.round((ciCount / total) * 100)}%"></span></span></span>${chev}</a>`;
    }
    if (hs) {
      html += `<a class="row" href="#/hotseat">${avatar(hs)}
        <span class="row-main"><span class="row-title">Hot seat: ${esc(youOr(hs))}</span>
        <span class="row-sub">${hasPrep(m) ? esc(m.hotSeatPrep.problem) : past ? 'No prep recorded' : `Prep due ${esc(fmtDateShort.format(prepDue(m)))}`}</span></span>${chev}</a>`;
    }
    if (past && m.attendance && m.attendance.length) {
      const absent = state.members.filter((x) => !m.attendance.includes(x.id)).map((x) => x.name.split(' ')[0]);
      html += `<div class="row static"><span class="row-main"><span class="row-title">Attendance</span>
        <span class="row-sub">${m.attendance.length} of ${total} there${absent.length ? `. Missed: ${esc(absent.join(', '))}` : ''}</span></span></div>`;
    }
    html += `</div>
      <h2 class="sec">Agenda${isAdmin() && !past ? `<button class="sec-action" data-edit-agenda="${esc(m.id)}">Edit</button>` : ''}</h2>
      ${rows.length ? `<ol class="timeline">
        ${rows.map((r) => `<li><span class="t">${esc(fmtTime.format(r.start))}</span>
          <span class="what">${esc(r.item)}<span class="who">${esc(memberName(r.owner))}, ${esc(r.time)} min</span></span></li>`).join('')}
        <li class="end"><span class="t">${esc(fmtTime.format(end))}</span><span class="what">End</span></li>
      </ol>` : empty('No agenda yet.', isAdmin() ? `<button class="btn btn-ghost btn-sm" data-edit-agenda="${esc(m.id)}">Add agenda items</button>` : '')}
      <h2 class="sec">Notes</h2>
      <p class="soon-line">Shared meeting notes are coming soon.</p>`;
    setView(html, 'meetings');

    const ics = $('#ics-btn');
    if (ics) ics.addEventListener('click', () => { downloadICS(m); toast('Calendar file downloaded'); });
    const cp = $('#copy-loc');
    if (cp) cp.addEventListener('click', () => (zoom ? copyText(loc.url, 'Zoom link copied') : copyText(loc.address, 'Address copied')));
    $$('[data-edit-agenda]').forEach((b) => b.addEventListener('click', () => editAgenda(b.dataset.editAgenda)));
    $$('[data-edit-meeting]').forEach((b) => b.addEventListener('click', () => editMeeting(b.dataset.editMeeting)));
    bindRsvp((mid, s) => api.setMeetingRsvp(mid, state.me.id, s));
  }

  function renderCheckins(id) {
    const m = state.meetings.find((x) => x.id === id);
    if (!m) return location.replace('#/meetings');
    const list = state.checkins.filter((k) => k.meetingId === id)
      .sort((a, b) => (isMe(a.memberId) ? -1 : isMe(b.memberId) ? 1 : ts(a.submittedAt) - ts(b.submittedAt)));
    const total = state.members.length;
    const missing = state.members.filter((x) => !list.some((k) => k.memberId === x.id));
    const canAdd = !isPast(m) && !checkinFor(id, state.me.id);
    let html = `${back(`#/meetings/${id}`, m.title)}
      <h1 class="page-title">Check-ins</h1>
      <p class="page-sub">Wins and challenges for ${esc(fmtDateShort.format(new Date(m.datetime)))}</p>
      <div class="count-block"><b>${list.length} of ${total}</b> checked in
        <span class="meter" aria-hidden="true"><span style="width:${Math.round((list.length / total) * 100)}%"></span></span></div>
      ${canAdd ? `<button class="btn btn-primary btn-block" data-edit-checkin="${esc(id)}">Add your check-in</button>` : ''}
      ${isAdmin() && missing.length ? `<p class="missing"><b>Not in yet:</b> ${esc(missing.map((x) => (isMe(x.id) ? 'you' : x.name.split(' ')[0])).join(', '))}</p>` : ''}`;
    html += list.length ? `<div class="checkins">${list.map((k) => {
      const late = ts(k.submittedAt) > ts(m.datetime);
      return `<article class="checkin ${isMe(k.memberId) ? 'mine' : ''}">
        <header>${avatar(k.memberId)}<span class="nm">${esc(youOr(k.memberId))}</span><span class="when">${late ? 'After the meeting' : esc(relTime(k.submittedAt))}</span>
        ${isMe(k.memberId) && !isPast(m) ? `<button class="link-btn" data-edit-checkin="${esc(id)}">Edit</button>` : ''}</header>
        <dl><dt>Win</dt><dd>${esc(k.win)}</dd><dt>Challenge</dt><dd>${esc(k.challenge)}</dd></dl>
      </article>`;
    }).join('')}</div>` : empty('No check-ins yet. They show up here as people submit them.');
    setView(html, 'meetings');
    bindCommon();
  }

  function editAgenda(meetingId) {
    const meeting = state.meetings.find((m) => m.id === meetingId);
    const items = meeting.agenda.map((a) => Object.assign({}, a));
    const target = state.config.meetingLengthMinutes;
    const ownerOptions = (sel) => [`<option value="all" ${sel === 'all' ? 'selected' : ''}>Everyone</option>`]
      .concat(state.members.map((m) => `<option value="${esc(m.id)}" ${sel === m.id ? 'selected' : ''}>${esc(m.name)}</option>`)).join('');
    const totalText = () => {
      const total = items.reduce((s, a) => s + (Number(a.time) || 0), 0);
      return { total, text: `${total} of ${target} min` + (total > target ? `, ${total - target} over` : total < target ? `, ${target - total} open` : '') };
    };
    const refreshTimes = (sheet) => {
      const { rows } = agendaWithTimes(Object.assign({}, meeting, { agenda: items }));
      $$('.start', sheet).forEach((s, j) => { s.textContent = fmtTime.format(rows[j].start); });
      const t = totalText();
      const tl = sheet.querySelector('#total-line');
      tl.textContent = t.text;
      tl.classList.toggle('over', t.total > target);
    };
    const draw = (sheet) => {
      sheet.querySelector('#agenda-items').innerHTML = items.length ? items.map((a, i) => `
        <div class="agenda-edit" data-i="${i}">
          <div class="ae-top"><span class="start"></span>
            <input class="item-input" data-f="item" value="${esc(a.item)}" placeholder="Agenda item" aria-label="Agenda item ${i + 1}"></div>
          <select data-f="owner" aria-label="Who leads item ${i + 1}">${ownerOptions(a.owner)}</select>
          <div class="ae-bottom">
            <label class="mins"><input type="number" min="0" max="240" inputmode="numeric" data-f="time" value="${esc(a.time)}" aria-label="Minutes for item ${i + 1}"> min</label>
            <span class="grow"></span>
            <button class="icon-btn" data-move="-1" aria-label="Move up" ${i === 0 ? 'disabled' : ''}><svg viewBox="0 0 16 16"><path d="M3.5 10L8 5.5 12.5 10"/></svg></button>
            <button class="icon-btn" data-move="1" aria-label="Move down" ${i === items.length - 1 ? 'disabled' : ''}><svg viewBox="0 0 16 16"><path d="M3.5 6L8 10.5 12.5 6"/></svg></button>
            <button class="icon-btn danger" data-remove aria-label="Remove item"><svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
          </div>
        </div>`).join('') : empty('No items. Add one below.');
      refreshTimes(sheet);
    };

    openSheet(`
      <h2>Edit agenda</h2>
      <p class="sheet-sub">${esc(meeting.title)}. Start times update as you change minutes.</p>
      <p class="total-line" id="total-line"></p>
      <div id="agenda-items"></div>
      <button class="btn btn-ghost btn-block" id="add-item">Add item</button>
      <div class="sheet-actions"><button class="btn btn-ghost" data-cancel>Cancel</button><button class="btn btn-primary" id="save-agenda">Save agenda</button></div>`, (sheet) => {
      draw(sheet);
      const list = sheet.querySelector('#agenda-items');
      list.addEventListener('input', (e) => {
        const row = e.target.closest('[data-i]');
        if (!row || !e.target.dataset.f) return;
        const f = e.target.dataset.f;
        items[+row.dataset.i][f] = f === 'time' ? Math.max(0, parseInt(e.target.value, 10) || 0) : e.target.value;
        if (f === 'time') refreshTimes(sheet);
      });
      list.addEventListener('change', (e) => {
        if (e.target.dataset.f === 'owner') items[+e.target.closest('[data-i]').dataset.i].owner = e.target.value;
      });
      list.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        const i = +btn.closest('[data-i]').dataset.i;
        if (btn.hasAttribute('data-remove')) items.splice(i, 1);
        else if (btn.dataset.move) {
          const j = i + Number(btn.dataset.move);
          if (j < 0 || j >= items.length) return;
          [items[i], items[j]] = [items[j], items[i]];
        }
        draw(sheet);
      });
      sheet.querySelector('#add-item').addEventListener('click', () => {
        items.push({ time: 10, item: '', owner: state.me.id });
        draw(sheet);
        const inputs = $$('.item-input', sheet);
        inputs[inputs.length - 1].focus();
      });
      sheet.querySelector('#save-agenda').addEventListener('click', async () => {
        const cleaned = items.filter((a) => a.item.trim()).map((a) => ({ time: Number(a.time) || 0, item: a.item.trim(), owner: a.owner }));
        await api.updateMeeting(meetingId, { agenda: cleaned });
        await refresh();
        closeSheet();
        toast('Agenda saved');
        rerender();
      });
    });
  }

  function editMeeting(meetingId) {
    const meeting = state.meetings.find((m) => m.id === meetingId);
    const cur = isoToCentralInputs(meeting.datetime);
    const hsOptions = state.members.map((m) => `<option value="${esc(m.id)}" ${m.id === meeting.hotSeatMemberId ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
    openSheet(`
      <h2>Edit meeting</h2>
      <p class="sheet-sub">Date and time are Central.</p>
      <div class="field"><label for="mt-title">Title</label><input id="mt-title" value="${esc(meeting.title)}"></div>
      <div class="field-row">
        <div class="field"><label for="mt-date">Date</label><input id="mt-date" type="date" value="${esc(cur.date)}"></div>
        <div class="field"><label for="mt-time">Start time</label><input id="mt-time" type="time" value="${esc(cur.time)}"></div>
      </div>
      <div class="field"><label for="mt-hs">Hot seat</label><select id="mt-hs">${hsOptions}</select></div>
      <h3 class="sheet-sec">Location</h3>
      ${locationEditorHTML(meetingLocation(meeting), { inheritable: true, inherit: !hasOwnLocation(meeting) })}
      <div class="sheet-actions"><button class="btn btn-ghost" data-cancel>Cancel</button><button class="btn btn-primary" id="save-meeting">Save meeting</button></div>`, (sheet) => {
      const locDraft = { type: meetingLocation(meeting).type };
      bindLocationEditor(sheet, locDraft);
      sheet.querySelector('#save-meeting').addEventListener('click', async () => {
        const date = sheet.querySelector('#mt-date').value;
        const time = sheet.querySelector('#mt-time').value;
        if (!date || !time) { toast('Pick a date and time'); return; }
        const where = readLocationEditor(sheet, locDraft);
        if (where.error) { toast(where.error); return; }
        const patch = {
          title: sheet.querySelector('#mt-title').value.trim() || meeting.title,
          datetime: centralToISO(date, time),
          hotSeatMemberId: sheet.querySelector('#mt-hs').value,
          location: where.loc
        };
        if (patch.hotSeatMemberId !== meeting.hotSeatMemberId) patch.hotSeatPrep = null;
        await api.updateMeeting(meetingId, patch);
        await refresh();
        closeSheet();
        toast('Meeting saved');
        rerender();
      });
    });
  }

  /* ---------- Track ---------- */
  function trackHeader(seg) {
    const tab = (key, href, label) => `<a role="tab" href="${href}" aria-selected="${seg === key}" class="${seg === key ? 'on' : ''}">${label}</a>`;
    const sub = { commitments: "What each of us said we'd do, and how it's going.", goals: 'Bigger outcomes our monthly commitments move forward.', score: 'Who keeps their word, month after month.' }[seg];
    return `${pageHead('Track', sub, { flush: true })}
      <div class="band"><div class="seg-control" role="tablist" aria-label="Track">
        ${tab('commitments', '#/track', 'Commitments')}${tab('goals', '#/track/goals', 'Goals')}${tab('score', '#/track/score', 'Scoreboard')}
      </div></div>`;
  }

  function renderCommitments() {
    const all = currentCommitments();
    const lm = lastMeeting();
    const counts = { all: all.length, not_started: 0, in_progress: 0, done: 0 };
    all.forEach((c) => { counts[c.status] = (counts[c.status] || 0) + 1; });
    const total = state.members.length;
    const shown = all
      .filter((c) => state.filter === 'all' || c.status === state.filter)
      .sort((a, b) => (isMe(a.memberId) ? -1 : isMe(b.memberId) ? 1 : memberName(a.memberId).localeCompare(memberName(b.memberId))));
    const chip = (key, label) => `<button class="chip ${state.filter === key ? 'on' : ''}" aria-pressed="${state.filter === key}" data-filter="${key}">${key !== 'all' ? mark(key) : ''}${label}<span class="count">${counts[key]}</span></button>`;

    let html = trackHeader('commitments');
    if (lm) {
      html += `<div class="count-block"><b>${counts.done} of ${total}</b> kept so far
        <span class="meter" aria-hidden="true"><span style="width:${total ? Math.round((counts.done / total) * 100) : 0}%"></span></span>
        <span class="count-sub">Made at the ${esc(fmtMonthLong.format(new Date(lm.datetime)))} meeting</span></div>
        <div class="chips">${chip('all', 'All')}${chip('not_started', 'Not started')}${chip('in_progress', 'In progress')}${chip('done', 'Done')}</div>`;
    }
    if (!shown.length) {
      const msg = { not_started: 'Everyone has started. Nice.', in_progress: 'Nothing in progress right now.', done: 'Nothing marked done yet.', all: 'No commitments yet. Everyone sets one at the end of each meeting.' }[state.filter];
      html += empty(msg);
    } else {
      html += `<div class="rows">${shown.map((c) => {
        const mine = isMe(c.memberId);
        const editable = mine || isAdmin();
        const tag = editable ? 'button' : 'div';
        return `<${tag} class="row commit-row ${mine ? 'mine' : ''} ${editable ? '' : 'static'}" ${editable ? `data-edit-commit="${esc(c.id)}"` : ''}>
          ${avatar(c.memberId)}
          <span class="row-main">
            <span class="row-top"><span class="row-title">${esc(youOr(c.memberId))}</span>${statusLabel(c.status)}</span>
            <span class="commit-text">${esc(c.text)}</span>
            ${goalTag(c.goalId)}
            ${c.lastUpdateNote ? `<span class="row-sub">${esc(c.lastUpdateNote)}</span>` : ''}
          </span>
        </${tag}>`;
      }).join('')}</div>`;
    }
    setView(html, 'track');
    $$('[data-filter]').forEach((b) => b.addEventListener('click', () => { state.filter = b.dataset.filter; rerender(); }));
    bindCommon();
  }

  function editCommitment(c) {
    if (!c) return;
    const mine = isMe(c.memberId);
    let status = c.status;
    let goalId = c.goalId || '';
    const goals = myGoals(c.memberId).filter((g) => g.status !== 'done' || g.id === c.goalId);
    const goalPick = goals.length ? `<div class="pick" role="radiogroup" aria-label="Linked goal" id="c-goal">
        <button type="button" role="radio" aria-checked="${!goalId}" data-goal="">No goal</button>
        ${goals.map((g) => `<button type="button" role="radio" aria-checked="${goalId === g.id}" data-goal="${esc(g.id)}">${esc(g.title)}</button>`).join('')}
      </div>` : `<p class="field-help">${mine ? 'Add a goal in Track to link commitments to it.' : 'No goals set yet.'}</p>`;
    openSheet(`
      <h2>${mine ? 'Your commitment' : esc(`${firstName(c.memberId)}'s commitment`)}</h2>
      <p class="sheet-sub">${mine ? 'Keep the group posted.' : 'Editing as admin.'}</p>
      <div class="field"><label for="c-text">Commitment</label><textarea id="c-text" rows="3" maxlength="280">${esc(c.text)}</textarea></div>
      <div class="field"><span class="label">Status</span>
        <div class="segmented" id="c-status" role="radiogroup" aria-label="Status">
          ${Object.keys(STATUS).map((s) => `<button type="button" role="radio" aria-checked="${status === s}" class="seg-${s} ${status === s ? 'on' : ''}" data-s="${s}">${mark(s)}${STATUS[s]}</button>`).join('')}
        </div></div>
      <div class="field"><span class="label">Goal it moves forward</span>${goalPick}</div>
      <div class="field"><label for="c-note">Update note <span class="opt">optional</span></label>
        <input id="c-note" maxlength="140" placeholder="e.g. Called two contractors, waiting on bids" value="${esc(c.lastUpdateNote)}"></div>
      <div class="sheet-actions"><button class="btn btn-ghost" data-cancel>Cancel</button><button class="btn btn-primary" id="c-save">Save commitment</button></div>`, (sheet) => {
      $$('#c-status [data-s]', sheet).forEach((b) => b.addEventListener('click', () => {
        status = b.dataset.s;
        $$('#c-status [data-s]', sheet).forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b); });
      }));
      $$('#c-goal [data-goal]', sheet).forEach((b) => b.addEventListener('click', () => {
        goalId = b.dataset.goal;
        $$('#c-goal [data-goal]', sheet).forEach((x) => x.setAttribute('aria-checked', x === b));
      }));
      sheet.querySelector('#c-save').addEventListener('click', async () => {
        const text = sheet.querySelector('#c-text').value.trim();
        if (!text) { toast('Write the commitment first'); return; }
        await api.updateCommitment(c.id, { text, status, goalId: goalId || null, lastUpdateNote: sheet.querySelector('#c-note').value.trim() });
        await refresh();
        closeSheet();
        toast('Commitment saved');
        rerender();
      });
    });
  }

  function goalRow(g) {
    return `<a class="row goal-row" href="#/goals/${esc(g.id)}">
      ${mark(g.status, 'row-mark')}
      <span class="row-main"><span class="row-title">${esc(g.title)}</span>
        <span class="row-why">${esc(g.why)}</span>
        <span class="row-sub">${g.status === 'done' ? 'Done' : g.status === 'paused' ? 'Paused' : `By ${esc(fmtDateYear.format(dateOnly(g.targetDate)))}`}, ${esc(g.period)}</span>
      </span>${chev}</a>`;
  }

  function renderGoals() {
    const order = state.members.slice().sort((a, b) => (isMe(a.id) ? -1 : isMe(b.id) ? 1 : 0));
    let html = trackHeader('goals');
    html += order.map((mem) => {
      const goals = myGoals(mem.id).sort((a, b) => ({ active: 0, paused: 1, done: 2 }[a.status] - { active: 0, paused: 1, done: 2 }[b.status]));
      const mine = isMe(mem.id);
      const activeCount = goals.filter((g) => g.status === 'active').length;
      const addBtn = mine && activeCount < 3 ? '<button class="sec-action" id="add-goal">Add goal</button>' : '';
      return `<section class="goal-group ${mine ? 'mine' : ''}">
        <h2 class="sec">${mine ? 'Your goals' : esc(mem.name)}${addBtn}</h2>
        ${goals.length ? `<div class="rows">${goals.map(goalRow).join('')}</div>`
          : mine ? empty('Set one to three goals. The group will help hold you to them.', '<button class="btn btn-primary btn-sm" id="add-goal-empty">Add your first goal</button>')
            : '<p class="soon-line">No goals yet.</p>'}
      </section>`;
    }).join('');
    setView(html, 'track');
    ['#add-goal', '#add-goal-empty'].forEach((s) => { const b = $(s); if (b) b.addEventListener('click', () => editGoal(null)); });
  }

  function renderGoalDetail(id) {
    const g = goalById(id);
    if (!g) return location.replace('#/track/goals');
    const canEdit = isMe(g.memberId) || isAdmin();
    const linked = state.commitments.filter((c) => c.goalId === id)
      .map((c) => ({ c, m: state.meetings.find((x) => x.id === c.meetingId) }))
      .sort((a, b) => ts(b.m ? b.m.datetime : 0) - ts(a.m ? a.m.datetime : 0));
    let html = `${back('#/track/goals', 'Goals')}
      <p class="owner-line">${avatar(g.memberId, 'sm')}${esc(isMe(g.memberId) ? 'Your goal' : `${memberName(g.memberId)}'s goal`)}</p>
      <h1 class="page-title">${esc(g.title)}</h1>
      <p class="lede">${esc(g.why)}</p>
      <dl class="facts">
        <div><dt>Status</dt><dd>${goalStatusLabel(g.status)}</dd></div>
        <div><dt>Target</dt><dd>${esc(fmtDateYear.format(dateOnly(g.targetDate)))}</dd></div>
        <div><dt>Period</dt><dd>${esc(g.period)}</dd></div>
      </dl>
      ${g.accountabilityAsk ? `<blockquote class="hold"><span>Hold ${isMe(g.memberId) ? 'me' : esc(firstName(g.memberId))} to it</span>${esc(g.accountabilityAsk)}</blockquote>` : ''}
      ${canEdit ? '<button class="btn btn-ghost btn-sm" id="edit-goal">Edit goal</button>' : ''}
      <h2 class="sec">Commitments toward this goal<span class="sec-count">${linked.length}</span></h2>`;
    html += linked.length ? `<ol class="history">${linked.map(({ c, m }) => `<li>
        ${mark(c.status)}<span><span class="h-when">${m ? esc(fmtMonthLong.format(new Date(m.datetime))) : ''}</span>${esc(c.text)}${c.lastUpdateNote ? `<span class="row-sub">${esc(c.lastUpdateNote)}</span>` : ''}</span></li>`).join('')}</ol>`
      : empty(isMe(g.memberId) ? 'Link a commitment to this goal from Track or Home.' : 'No commitments linked yet.');
    setView(html, 'track');
    const eb = $('#edit-goal');
    if (eb) eb.addEventListener('click', () => editGoal(g));
  }

  function editGoal(g) {
    const isNew = !g;
    const goal = g ? Object.assign({}, g) : { memberId: state.me.id, title: '', why: '', targetDate: '2026-12-31', period: 'Q4 2026', status: 'active', accountabilityAsk: '' };
    const periods = Array.from(new Set(['Q4 2026', '2027'].concat(state.goals.map((x) => x.period)).concat([goal.period])));
    openSheet(`
      <h2>${isNew ? 'New goal' : 'Edit goal'}</h2>
      <p class="sheet-sub">${isMe(goal.memberId) ? 'One clear outcome. Monthly commitments can link to it.' : `Editing ${esc(firstName(goal.memberId))}'s goal as admin.`}</p>
      <div class="field"><label for="g-title">Goal</label><input id="g-title" maxlength="90" value="${esc(goal.title)}" placeholder="e.g. Sign two new clients"></div>
      <div class="field"><label for="g-why">Why it matters <span class="opt">one line</span></label><input id="g-why" maxlength="120" value="${esc(goal.why)}"></div>
      <div class="field-row">
        <div class="field"><label for="g-date">Target date</label><input id="g-date" type="date" value="${esc(goal.targetDate)}"></div>
        <div class="field"><label for="g-period">Period</label><select id="g-period">${periods.map((p) => `<option ${p === goal.period ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></div>
      </div>
      <div class="field"><span class="label">Status</span>
        <div class="segmented" id="g-status" role="radiogroup" aria-label="Goal status">
          ${Object.keys(GOAL_STATUS).map((s) => `<button type="button" role="radio" aria-checked="${goal.status === s}" class="seg-${s} ${goal.status === s ? 'on' : ''}" data-s="${s}">${mark(s)}${GOAL_STATUS[s]}</button>`).join('')}
        </div></div>
      <div class="field"><label for="g-ask">What should the group hold you to? <span class="opt">optional</span></label>
        <textarea id="g-ask" rows="2" maxlength="200" placeholder="e.g. Ask me every month whether I made the sales calls">${esc(goal.accountabilityAsk)}</textarea></div>
      <div class="sheet-actions"><button class="btn btn-ghost" data-cancel>Cancel</button><button class="btn btn-primary" id="g-save">${isNew ? 'Add goal' : 'Save goal'}</button></div>`, (sheet) => {
      $$('#g-status [data-s]', sheet).forEach((b) => b.addEventListener('click', () => {
        goal.status = b.dataset.s;
        $$('#g-status [data-s]', sheet).forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b); });
      }));
      sheet.querySelector('#g-save').addEventListener('click', async () => {
        goal.title = sheet.querySelector('#g-title').value.trim();
        goal.why = sheet.querySelector('#g-why').value.trim();
        goal.targetDate = sheet.querySelector('#g-date').value || goal.targetDate;
        goal.period = sheet.querySelector('#g-period').value;
        goal.accountabilityAsk = sheet.querySelector('#g-ask').value.trim();
        if (!goal.title) { toast('Name the goal first'); return; }
        const saved = await api.saveGoal(goal);
        await refresh();
        closeSheet();
        toast(isNew ? 'Goal added' : 'Goal saved');
        if (isNew) location.hash = `#/goals/${saved.id}`; else rerender();
      });
    });
  }

  function renderScoreboard() {
    const scores = computeScores();
    let html = trackHeader('score');
    html += `<p class="page-sub">Kept means marked done by the next meeting. Open commitments count once they're done or the next meeting passes.</p>
      <ul class="scores">${scores.map((s, idx) => {
        const mine = isMe(s.member.id);
        // The top row gets the leader treatment once anything has been counted.
        const top = scores[0];
        const lead = idx === 0 && s.total > 0;
        const tied = lead && scores.length > 1 && scores[1].pct === top.pct && scores[1].kept === top.kept;
        const perfect = s.total > 0 && s.kept === s.total;
        const pct = s.total ? Math.round((s.kept / s.total) * 100) : 0;
        const fact = (label, [a, b]) => (b ? `<span><b>${a}/${b}</b> ${label}</span>` : '');
        return `<li class="score ${mine ? 'mine' : ''} ${lead ? 'leader' : ''}">
          ${avatar(s.member.id, lead ? 'lg ring' : '')}
          <div class="score-main">
            ${lead ? `<span class="lead-badge"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 5.5l3 2.5L8 3.5l2.5 4.5 3-2.5-1 6.5h-9z"/></svg>${tied ? 'Tied for first' : 'Leading'}</span>` : ''}
            <div class="score-top"><span class="nm">${esc(mine ? 'You' : s.member.name)}</span>
              ${perfect ? '<span class="badge-all" title="Every commitment kept"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.3l-3.8 2 .7-4.3-3.1-3 4.3-.6z"/></svg>All kept</span>' : ''}</div>
            <div class="score-kept">${s.total ? `${s.kept} of ${s.total} kept` : 'No commitments counted yet'}</div>
            <span class="meter" aria-hidden="true"><span style="width:${pct}%"></span></span>
            ${s.streak ? `<div class="score-streak">${esc(streakText(s.streak))}</div>` : ''}
            <div class="score-facts">${fact('check-ins on time', s.checkins)}${fact('hot seat prep on time', s.prep)}${fact('meetings', s.attendance)}</div>
          </div>
        </li>`;
      }).join('')}</ul>`;
    setView(html, 'track');
  }

  /* ---------- Hot seat ---------- */
  const PREP_FIELDS = [
    ['problem', 'The question', 'One line the group can answer', 'input'],
    ['context', 'Background', 'Numbers, people, deadlines. What should we know?', 'textarea'],
    ['whatTried', "What I've tried", 'So nobody suggests it twice', 'textarea'],
    ['winLooksLike', 'A win looks like', 'What would you walk away with?', 'textarea']
  ];

  function prepView(p) {
    return `<dl class="prep">${PREP_FIELDS.map(([k, label]) => (p[k] ? `<dt>${esc(label)}</dt><dd class="${k === 'problem' ? 'prep-q' : ''}">${esc(p[k])}</dd>` : '')).join('')}</dl>`;
  }

  function prepForm(p) {
    return `<form id="prep-form" class="prep-form">
      ${PREP_FIELDS.map(([k, label, help, kind]) => `<div class="field"><label for="p-${k}">${esc(label)}</label>
        ${kind === 'input' ? `<input id="p-${k}" maxlength="160" value="${esc(p[k] || '')}" placeholder="${esc(help)}">`
          : `<textarea id="p-${k}" rows="3" maxlength="600" placeholder="${esc(help)}">${esc(p[k] || '')}</textarea>`}</div>`).join('')}
      <div class="btn-row">${p.problem ? '<button type="button" class="btn btn-ghost" id="prep-cancel">Cancel</button>' : ''}<button class="btn btn-primary" type="submit">Submit prep</button></div>
    </form>`;
  }

  function renderHotSeat() {
    const nm = nextMeeting();
    const upcoming = state.meetings.filter((m) => !isPast(m));
    const past = state.meetings.filter(isPast).reverse();
    let html = pageHead('Hot Seat', 'One person, one question. Prep is due a day before.');

    if (nm && nm.hotSeatMemberId) {
      const hs = nm.hotSeatMemberId;
      const mine = isMe(hs);
      const p = nm.hotSeatPrep || {};
      const due = prepDue(nm);
      const showForm = (mine || isAdmin()) && (state.editPrep || (mine && !hasPrep(nm)));
      const prepIn = hasPrep(nm);
      html += `<section class="hs-next">
        <div class="hs-hero">
          <p class="hs-eyebrow">Next up &middot; ${esc(fmtDateShort.format(new Date(nm.datetime)))}</p>
          <div class="hs-person">${avatar(hs, 'xl ring')}
            <div class="hs-who"><h2>${esc(mine ? "You're on" : memberName(hs))}</h2>
            ${mine ? `<p class="hs-sub">${esc(memberName(hs))}</p>` : ''}</div>
          </div>
          <dl class="hs-meta">
            <div><dt>Prep</dt><dd class="hs-status ${prepIn ? 'in' : ''}">${prepIn ? `${mark('done')}In, ${esc(relTime(p.submittedAt))}` : `${mark('not_started')}Not in yet`}</dd></div>
            <div><dt>Due</dt><dd>${esc(fmtDateShort.format(due))}, ${esc(fmtTime.format(due))}</dd></div>
          </dl>
        </div>`;
      if (showForm) {
        html += `${!mine ? `<p class="field-help">Filling in for ${esc(firstName(hs))} as admin.</p>` : ''}${prepForm(p)}`;
      } else if (hasPrep(nm)) {
        html += prepView(p);
        if (mine || isAdmin()) html += `<button class="btn btn-ghost btn-sm" id="edit-prep">${mine ? 'Edit your prep' : `Edit for ${esc(firstName(hs))}`}</button>`;
      } else {
        html += `<p class="soon-line">${esc(firstName(hs))}'s prep shows here once it's in.</p>`;
        if (isAdmin()) html += `<button class="btn btn-ghost btn-sm" id="edit-prep">Fill in for ${esc(firstName(hs))}</button>`;
      }
      html += '</section>';
    } else {
      html += empty('No hot seat scheduled yet. Your admin sets the rotation.');
    }

    // Rotation
    const scheduled = new Set(upcoming.map((m) => m.hotSeatMemberId));
    const unscheduled = state.members.filter((x) => !scheduled.has(x.id));
    html += `<h2 class="sec">Rotation${isAdmin() ? '<span class="sec-count">Move people up or down</span>' : ''}</h2>
      <ol class="rotation">${upcoming.map((m, i) => `<li class="${isMe(m.hotSeatMemberId) ? 'mine' : ''}">
        <span class="date-chip" aria-hidden="true"><span>${esc(fmtMonth.format(new Date(m.datetime)))}</span><b>${esc(fmtDay.format(new Date(m.datetime)))}</b></span>
        <span class="row-main"><span class="row-title">${esc(m.hotSeatMemberId ? youOr(m.hotSeatMemberId) : 'Open')}</span>
          <span class="row-sub">${hasPrep(m) ? 'Prep in' : i === 0 ? 'Prep not in yet' : 'Prep opens a week before'}</span></span>
        ${isAdmin() ? `<span class="rot-move">
          <button class="icon-btn" data-swap="${esc(m.id)}" data-dir="-1" aria-label="Move ${esc(memberName(m.hotSeatMemberId))} earlier" ${i === 0 ? 'disabled' : ''}><svg viewBox="0 0 16 16"><path d="M3.5 10L8 5.5 12.5 10"/></svg></button>
          <button class="icon-btn" data-swap="${esc(m.id)}" data-dir="1" aria-label="Move ${esc(memberName(m.hotSeatMemberId))} later" ${i === upcoming.length - 1 ? 'disabled' : ''}><svg viewBox="0 0 16 16"><path d="M3.5 6L8 10.5 12.5 6"/></svg></button>
        </span>` : ''}
      </li>`).join('')}</ol>
      ${unscheduled.length ? `<p class="soon-line"><b>Not scheduled yet:</b> ${esc(unscheduled.map((x) => (isMe(x.id) ? 'you' : x.name.split(' ')[0])).join(', '))}</p>` : ''}`;

    // Past hot seats and action plans
    const pastHs = past.filter((m) => m.hotSeatMemberId);
    if (pastHs.length) {
      html += '<h2 class="sec">Past hot seats</h2><div class="past-hs">';
      html += pastHs.map((m) => {
        const hs = m.hotSeatMemberId;
        const ap = m.actionPlan;
        const canRecord = isMe(hs) || isAdmin();
        return `<article class="past-item">
          <header>${avatar(hs, 'sm')}<span class="nm">${esc(youOr(hs))}</span><span class="when">${esc(fmtMonthLong.format(new Date(m.datetime)))}</span></header>
          ${hasPrep(m) ? `<p class="past-q">${esc(m.hotSeatPrep.problem)}</p>` : ''}
          ${ap ? `<div class="plan">
              <p class="plan-label">Advice taken</p>
              <ul>${ap.adviceTaken.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>
              <p class="plan-label">Next step</p>
              <p class="plan-next">${esc(ap.nextStep)}<span class="row-sub">By ${esc(fmtDateYear.format(dateOnly(ap.deadline)))}</span></p>
              ${goalTag(ap.goalId)}
              ${canRecord ? `<button class="link-btn" data-plan="${esc(m.id)}">Edit action plan</button>` : ''}
            </div>`
            : `<p class="soon-line">No action plan recorded yet.</p>${canRecord ? `<button class="btn ${isMe(hs) ? 'btn-primary' : 'btn-ghost'} btn-sm" data-plan="${esc(m.id)}">Record action plan</button>` : ''}`}
        </article>`;
      }).join('');
      html += '</div>';
    }

    setView(html, 'hotseat');

    const form = $('#prep-form');
    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const prep = {};
        PREP_FIELDS.forEach(([k]) => { prep[k] = $(`#p-${k}`).value.trim(); });
        if (!prep.problem) { toast('Write your question first'); $('#p-problem').focus(); return; }
        await api.saveHotSeatPrep(nm.id, prep);
        await refresh();
        state.editPrep = false;
        toast('Prep submitted');
        rerender();
      });
      const c = $('#prep-cancel');
      if (c) c.addEventListener('click', () => { state.editPrep = false; rerender(); });
    }
    const ep = $('#edit-prep');
    if (ep) ep.addEventListener('click', () => { state.editPrep = true; rerender(); });
    $$('[data-swap]').forEach((b) => b.addEventListener('click', async () => {
      const i = upcoming.findIndex((m) => m.id === b.dataset.swap);
      const j = i + Number(b.dataset.dir);
      if (j < 0 || j >= upcoming.length) return;
      await api.swapHotSeat(upcoming[i].id, upcoming[j].id);
      await refresh();
      toast('Rotation updated');
      rerender();
    }));
    bindCommon();
  }

  function editActionPlan(meetingId) {
    const m = state.meetings.find((x) => x.id === meetingId);
    const hs = m.hotSeatMemberId;
    const ap = m.actionPlan || { adviceTaken: ['', ''], nextStep: '', deadline: '', goalId: null };
    const advice = ap.adviceTaken.slice();
    while (advice.length < 2) advice.push('');
    let goalId = ap.goalId || '';
    const goals = myGoals(hs).filter((g) => g.status !== 'done' || g.id === ap.goalId);
    const drawAdvice = (sheet) => {
      sheet.querySelector('#ap-advice').innerHTML = advice.map((a, i) => `<div class="advice-row" data-i="${i}">
        <input value="${esc(a)}" maxlength="120" placeholder="${i === 0 ? 'e.g. Get a second bid before deciding' : 'Another piece of advice'}" aria-label="Advice ${i + 1}">
        ${advice.length > 2 ? '<button class="icon-btn danger" type="button" data-rm aria-label="Remove"><svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>' : ''}
      </div>`).join('');
      sheet.querySelector('#ap-add').hidden = advice.length >= 5;
    };
    openSheet(`
      <h2>Action plan</h2>
      <p class="sheet-sub">${isMe(hs) ? 'From your' : esc(`From ${firstName(hs)}'s`)} ${esc(fmtMonthLong.format(new Date(m.datetime)))} hot seat. Saving sets ${isMe(hs) ? 'your' : 'their'} commitment for this month.</p>
      <div class="field"><span class="label">Advice ${isMe(hs) ? "you're" : "they're"} taking <span class="opt">2 to 5</span></span><div id="ap-advice"></div>
        <button class="link-btn" type="button" id="ap-add">Add another</button></div>
      <div class="field"><label for="ap-next">Next step</label><input id="ap-next" maxlength="200" value="${esc(ap.nextStep)}" placeholder="The one thing you'll do before next meeting"></div>
      <div class="field"><label for="ap-date">Deadline</label><input id="ap-date" type="date" value="${esc(ap.deadline)}"></div>
      ${goals.length ? `<div class="field"><span class="label">Goal it moves forward <span class="opt">optional</span></span>
        <div class="pick" role="radiogroup" id="ap-goal"><button type="button" role="radio" aria-checked="${!goalId}" data-goal="">No goal</button>
        ${goals.map((g) => `<button type="button" role="radio" aria-checked="${goalId === g.id}" data-goal="${esc(g.id)}">${esc(g.title)}</button>`).join('')}</div></div>` : ''}
      <div class="sheet-actions"><button class="btn btn-ghost" data-cancel>Cancel</button><button class="btn btn-primary" id="ap-save">Save action plan</button></div>`, (sheet) => {
      drawAdvice(sheet);
      const box = sheet.querySelector('#ap-advice');
      box.addEventListener('input', (e) => { const r = e.target.closest('[data-i]'); if (r) advice[+r.dataset.i] = e.target.value; });
      box.addEventListener('click', (e) => {
        const b = e.target.closest('[data-rm]');
        if (!b) return;
        advice.splice(+b.closest('[data-i]').dataset.i, 1);
        drawAdvice(sheet);
      });
      sheet.querySelector('#ap-add').addEventListener('click', () => {
        if (advice.length >= 5) return;
        advice.push('');
        drawAdvice(sheet);
        const ins = $$('#ap-advice input', sheet);
        ins[ins.length - 1].focus();
      });
      $$('#ap-goal [data-goal]', sheet).forEach((b) => b.addEventListener('click', () => {
        goalId = b.dataset.goal;
        $$('#ap-goal [data-goal]', sheet).forEach((x) => x.setAttribute('aria-checked', x === b));
      }));
      sheet.querySelector('#ap-save').addEventListener('click', async () => {
        const adviceTaken = advice.map((a) => a.trim()).filter(Boolean);
        const nextStep = sheet.querySelector('#ap-next').value.trim();
        const deadline = sheet.querySelector('#ap-date').value;
        if (adviceTaken.length < 2) { toast('Add at least two pieces of advice'); return; }
        if (!nextStep) { toast('Add your next step'); return; }
        if (!deadline) { toast('Pick a deadline'); return; }
        await api.saveActionPlan(meetingId, { adviceTaken, nextStep, deadline, goalId: goalId || null });
        await refresh();
        closeSheet();
        toast('Action plan saved. Your commitment is set.');
        rerender();
      });
    });
  }

  /* ---------- Group ---------- */
  const TILE_ICONS = {
    asks: '<path d="M4 5h16v11H9l-5 4z"/><path d="M10 9.2a2 2 0 1 1 2.6 1.9c-.4.2-.6.5-.6.9v.4M12 14v.1"/>',
    members: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.2c2.9.3 5 2.7 5 5.8"/>',
    announcements: '<path d="M4 10v4h3l7 4V6L7 10z"/><path d="M17.5 9a4 4 0 0 1 0 6"/>',
    ideas: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9V16h7v-2.1A6 6 0 0 0 12 3z"/>',
    books: '<path d="M4 4.5h6a2 2 0 0 1 2 2V20a1.5 1.5 0 0 0-1.5-1.5H4zM20 4.5h-6a2 2 0 0 0-2 2V20a1.5 1.5 0 0 1 1.5-1.5H20z"/>',
    gettogethers: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4M9 15l2 2 4-4"/>',
    rules: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 12h7M9 16h7"/>'
  };

  function renderGroup() {
    const open = state.asks.filter((a) => a.status === 'open').length;
    const fresh = newAnnouncements().length;
    const gb = groupBook();
    const upGT = upcomingGTs().length;
    const tile = (key, title, sub) => `<a class="tile live" href="#/group/${key}">
      <svg viewBox="0 0 24 24" aria-hidden="true">${TILE_ICONS[key]}</svg>
      <span class="tile-title">${esc(title)}</span><span class="tile-sub">${esc(sub)}</span></a>`;
    setView(`${pageHead('Group', `${state.config.name}, ${plural(state.members.length, 'member')}`)}
      <div class="tiles">
        ${tile('asks', 'Asks', open ? `${open} open` : 'Ask for help')}
        ${tile('announcements', 'Announcements', fresh ? `${fresh} new` : plural(state.announcements.length, 'post'))}
        ${tile('members', 'Members', `${state.members.length} people`)}
        ${tile('gettogethers', 'Get-togethers', upGT ? `${upGT} coming up` : 'Plan one')}
        ${tile('books', 'Books', gb ? `Reading ${gb.title}` : plural(state.books.length, 'book'))}
        ${tile('ideas', 'Ideas', `${state.ideas.length} shared`)}
        ${tile('rules', 'Rules', hasRules() ? plural(state.config.rules.length, 'ground rule') : 'None yet')}
      </div>`, 'group');
  }

  /* ---------- Rules ---------- */
  function renderRules() {
    const agreed = store.get(rulesKey(), null);
    setView(`${pageHead('Rules', `The ground rules everyone in ${state.config.name} agreed to.`, { backHtml: back('#/group', 'Group') })}
      ${hasRules() ? rulesList() : empty('No ground rules yet. Your admin adds them.')}
      ${agreed ? `<p class="agreed-line">${mark('done')}You agreed on ${esc(fmtDateYear.format(new Date(agreed)))}</p>` : ''}`, 'group');
  }

  /* ---------- Announcements ---------- */
  function renderAnnouncements() {
    const fresh = new Set(newAnnouncements().map((a) => a.id));
    store.set(annSeenKey(), new Date().toISOString()); // opening the list clears "new"
    const list = sortedAnnouncements();
    setView(`${pageHead('Announcements', `Group news in one place. ${isAdmin() ? 'You can pin the important ones.' : 'Anyone can post.'}`, { backHtml: back('#/group', 'Group') })}
      <button class="btn btn-primary btn-block" id="new-ann">Post an announcement</button>
      <div class="sec-gap"></div>
      ${list.length ? `<div class="rows">${list.map((a) => `<a class="row ann-row ${a.pinned ? 'pinned' : ''}" href="#/group/announcements/${esc(a.id)}">
        ${avatar(a.authorId)}
        <span class="row-main">
          <span class="row-title">${a.pinned ? `<span class="pin-tag">${pinIcon}Pinned</span>` : ''}${fresh.has(a.id) ? '<span class="new-tag">New</span>' : ''}${esc(a.title)}</span>
          <span class="ann-excerpt">${esc(a.body)}</span>
          <span class="row-sub">${esc(youOr(a.authorId))}, ${esc(relTime(a.createdAt))}${a.comments.length ? `. ${plural(a.comments.length, 'comment')}` : ''}</span>
        </span>${chev}</a>`).join('')}</div>` : empty('No announcements yet. Post the first one.')}`, 'group');
    $('#new-ann').addEventListener('click', newAnnouncement);
  }

  function newAnnouncement() {
    openSheet(`
      <h2>New announcement</h2>
      <p class="sheet-sub">Everyone in the group sees it on Home.</p>
      <div class="field"><label for="an-title">Headline</label><input id="an-title" maxlength="90" placeholder="e.g. November meeting moves to the Whitakers'"></div>
      <div class="field"><label for="an-body">Details</label><textarea id="an-body" rows="4" maxlength="1000" placeholder="Where, when, what to bring"></textarea></div>
      ${isAdmin() ? '<label class="check"><input type="checkbox" id="an-pin"> Pin to the top</label>' : ''}
      <div class="sheet-actions"><button class="btn btn-ghost" data-cancel>Cancel</button><button class="btn btn-primary" id="an-save">Post</button></div>`, (sheet) => {
      sheet.querySelector('#an-save').addEventListener('click', async () => {
        const title = sheet.querySelector('#an-title').value.trim();
        const body = sheet.querySelector('#an-body').value.trim();
        if (!title || !body) { toast('Add a headline and details'); return; }
        const pin = sheet.querySelector('#an-pin');
        const a = await api.createAnnouncement({ authorId: state.me.id, title, body, pinned: !!(pin && pin.checked) });
        await refresh();
        closeSheet();
        toast('Announcement posted');
        location.hash = `#/group/announcements/${a.id}`;
      });
    });
  }

  function renderAnnouncementDetail(id) {
    const a = state.announcements.find((x) => x.id === id);
    if (!a) return location.replace('#/group/announcements');
    setView(`${back('#/group/announcements', 'Announcements')}
      <p class="owner-line">${avatar(a.authorId, 'sm')}${esc(youOr(a.authorId))}, ${esc(relTime(a.createdAt))}</p>
      ${a.pinned ? `<p class="pin-tag lg">${pinIcon}Pinned</p>` : ''}
      <h1 class="page-title">${esc(a.title)}</h1>
      <p class="lede prewrap">${esc(a.body)}</p>
      ${isAdmin() ? `<div class="btn-row"><button class="btn btn-ghost btn-sm" id="pin-toggle">${a.pinned ? 'Unpin' : 'Pin to top'}</button></div>` : ''}
      ${commentsSection(a.comments, 'Reply to the group')}`, 'group');
    const pt = $('#pin-toggle');
    if (pt) pt.addEventListener('click', async () => {
      await api.updateAnnouncement(a.id, { pinned: !a.pinned });
      await refresh();
      toast(a.pinned ? 'Unpinned' : 'Pinned to the top');
      rerender();
    });
    bindComments((text) => api.commentOnAnnouncement(a.id, { memberId: state.me.id, text }));
  }

  /* ---------- Ideas & resources ---------- */
  function likeButton(i) {
    const on = i.likes.includes(state.me.id);
    return `<button class="like-btn ${on ? 'on' : ''}" data-like="${esc(i.id)}" aria-pressed="${on}" aria-label="${on ? 'Unlike' : 'Like'}, ${i.likes.length} ${i.likes.length === 1 ? 'like' : 'likes'}">${heart(on)}<span>${i.likes.length}</span></button>`;
  }
  function bindLikes() {
    $$('[data-like]').forEach((b) => b.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await api.toggleIdeaLike(b.dataset.like, state.me.id);
      await refresh();
      rerender();
    }));
  }
  const typeTag = (t) => `<span class="type-tag">${esc(IDEA_TYPES[t] || 'Other')}</span>`;
  const ideaTitle = (i, cls) => (i.url
    ? `<a class="${cls} ext-link" href="${esc(i.url)}" target="_blank" rel="noopener noreferrer">${esc(i.title)}${extIcon}</a>`
    : `<span class="${cls}">${esc(i.title)}</span>`);

  function renderIdeas() {
    const all = state.ideas.slice().sort((a, b) => ts(b.createdAt) - ts(a.createdAt));
    const f = state.ideaFilter;
    const shown = all.filter((i) => f === 'all' || i.type === f);
    const count = (t) => all.filter((i) => i.type === t).length;
    const chip = (key, label, n) => `<button class="chip ${f === key ? 'on' : ''}" aria-pressed="${f === key}" data-ifilter="${key}">${esc(label)}<span class="count">${n}</span></button>`;
    setView(`${pageHead('Ideas', 'Links, tools and ideas from meetings, so nothing mentioned gets lost.', { backHtml: back('#/group', 'Group') })}
      <button class="btn btn-primary btn-block" id="new-idea">Share something</button>
      <div class="sec-gap"></div>
      <div class="chips">${chip('all', 'All', all.length)}${Object.keys(IDEA_TYPES).filter((t) => count(t)).map((t) => chip(t, IDEA_TYPES[t], count(t))).join('')}</div>
      ${shown.length ? `<div class="rows">${shown.map((i) => `<article class="idea">
        <p class="idea-top">${typeTag(i.type)}<span>${esc(youOr(i.memberId))}, ${esc(relTime(i.createdAt))}</span></p>
        ${ideaTitle(i, 'idea-title')}
        ${i.note ? `<p class="idea-note">${esc(i.note)}</p>` : ''}
        <div class="idea-foot">${likeButton(i)}
          <a class="link-btn" href="#/group/ideas/${esc(i.id)}">${i.comments.length ? plural(i.comments.length, 'comment') : 'Comment'}</a></div>
      </article>`).join('')}</div>` : empty(f === 'all' ? 'Nothing shared yet. Heard something good at the meeting? Add it.' : `No ${IDEA_TYPES[f].toLowerCase()}s yet.`)}`, 'group');
    $$('[data-ifilter]').forEach((b) => b.addEventListener('click', () => { state.ideaFilter = b.dataset.ifilter; rerender(); }));
    $('#new-idea').addEventListener('click', newIdea);
    bindLikes();
  }

  function newIdea() {
    let type = 'idea';
    openSheet(`
      <h2>Share something</h2>
      <p class="sheet-sub">An idea, a link, a tool you use. Keep it short.</p>
      <div class="field"><span class="label">What is it?</span>
        <div class="chip-pick" role="radiogroup" id="idea-type">${Object.keys(IDEA_TYPES).map((t) => `<button type="button" role="radio" class="chip ${t === type ? 'on' : ''}" aria-checked="${t === type}" data-t="${t}">${IDEA_TYPES[t]}</button>`).join('')}</div></div>
      <div class="field"><label for="idea-title">Title</label><input id="idea-title" maxlength="100" placeholder="e.g. Pre-orders by text for Saturday pop-ups"></div>
      <div class="field"><label for="idea-url">Link <span class="opt">optional</span></label><input id="idea-url" type="url" inputmode="url" maxlength="300" placeholder="https://"></div>
      <div class="field"><label for="idea-note">Why it's useful <span class="opt">optional</span></label><textarea id="idea-note" rows="3" maxlength="400"></textarea></div>
      <div class="sheet-actions"><button class="btn btn-ghost" data-cancel>Cancel</button><button class="btn btn-primary" id="idea-save">Share</button></div>`, (sheet) => {
      $$('#idea-type [data-t]', sheet).forEach((b) => b.addEventListener('click', () => {
        type = b.dataset.t;
        $$('#idea-type [data-t]', sheet).forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b); });
      }));
      sheet.querySelector('#idea-save').addEventListener('click', async () => {
        const title = sheet.querySelector('#idea-title').value.trim();
        let url = sheet.querySelector('#idea-url').value.trim();
        if (!title) { toast('Give it a title'); return; }
        if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
        await api.createIdea({ memberId: state.me.id, type, title, url, note: sheet.querySelector('#idea-note').value.trim() });
        await refresh();
        closeSheet();
        state.ideaFilter = 'all';
        toast('Shared with the group');
        rerender();
      });
    });
  }

  function renderIdeaDetail(id) {
    const i = state.ideas.find((x) => x.id === id);
    if (!i) return location.replace('#/group/ideas');
    const likers = i.likes.map((m) => (isMe(m) ? 'you' : firstName(m)));
    setView(`${back('#/group/ideas', 'Ideas')}
      <p class="owner-line">${avatar(i.memberId, 'sm')}${esc(youOr(i.memberId))}, ${esc(relTime(i.createdAt))}</p>
      <p class="idea-top">${typeTag(i.type)}</p>
      <h1 class="page-title">${esc(i.title)}</h1>
      ${i.note ? `<p class="lede">${esc(i.note)}</p>` : ''}
      <div class="btn-row">
        ${i.url ? `<a class="btn btn-ghost btn-sm" href="${esc(i.url)}" target="_blank" rel="noopener noreferrer">Open link${extIcon}</a>` : ''}
        ${likeButton(i)}
      </div>
      ${likers.length ? `<p class="soon-line">Liked by ${esc(likers.join(', '))}</p>` : ''}
      ${commentsSection(i.comments, 'Tried it? Add what you found')}`, 'group');
    bindLikes();
    bindComments((text) => api.commentOnIdea(i.id, { memberId: state.me.id, text }));
  }

  /* ---------- Books ---------- */
  function renderBooks() {
    const f = state.bookFilter;
    const gb = groupBook();
    const mineCount = (s) => state.readingList.filter((r) => isMe(r.memberId) && r.status === s).length;
    const sorted = state.books.slice().sort((a, b) => readersOf(b.id).length - readersOf(a.id).length || ts(b.createdAt) - ts(a.createdAt));
    const shown = sorted.filter((b) => (f === 'all' ? !b.groupBook : (myReading(b.id) || {}).status === f));
    const chip = (key, label, n) => `<button class="chip ${f === key ? 'on' : ''}" aria-pressed="${f === key}" data-bfilter="${key}">${key !== 'all' ? mark(key) : ''}${esc(label)}${n != null ? `<span class="count">${n}</span>` : ''}</button>`;
    let html = `${pageHead('Books', 'What the group is reading. Tap a book to set where you are.', { backHtml: back('#/group', 'Group') })}
      <button class="btn btn-primary btn-block" id="new-book">Suggest a book</button>`;
    if (gb && f === 'all') {
      // Richer card: tall cover, gold eyebrow, and a strip of who's finished / reading across the whole group.
      const total = state.members.length;
      const fin = readersOf(gb.id, 'finished');
      const rd = readersOf(gb.id, 'reading');
      const wantN = readersOf(gb.id, 'want').length;
      const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
      const faces = fin.concat(rd).slice(0, 6);
      const mineR = myReading(gb.id);
      html += `<a class="group-book gb-card" href="#/group/books/${esc(gb.id)}">
        <span class="gb-top">${cover(gb, 'xl')}
          <span class="gb-main"><span class="gb-label">Group book</span>
            <span class="gb-title">${esc(gb.title)}</span><span class="gb-author">${esc(gb.author)}</span>
            <span class="gb-you">${mineR ? `${mark(mineR.status)}You: ${esc(READ[mineR.status].toLowerCase())}` : 'Not on your list yet'}</span></span></span>
        <span class="gb-progress">
          <span class="gb-bar" aria-hidden="true"><span class="gb-fin" style="width:${pct(fin.length)}%"></span><span class="gb-rd" style="width:${pct(rd.length)}%"></span></span>
          <span class="gb-legend"><span class="st-finished">${mark('finished')}${fin.length} finished</span><span class="st-reading">${mark('reading')}${rd.length} reading</span>${wantN ? `<span class="st-want">${mark('want')}${wantN} want to</span>` : ''}<span class="gb-of">of ${total}</span></span>
          ${faces.length ? `<span class="gb-faces" aria-hidden="true">${faces.map((r) => `<span class="gb-face is-${r.status}">${esc(initials(memberName(r.memberId)))}</span>`).join('')}</span>` : ''}
        </span></a>`;
    }
    html += `<h2 class="sec">${f === 'all' ? 'All books' : 'My list'}</h2>
      <div class="chips">${chip('all', 'All', null)}${chip('want', 'Want', mineCount('want'))}${chip('reading', 'Reading', mineCount('reading'))}${chip('finished', 'Finished', mineCount('finished'))}</div>`;
    html += shown.length ? `<div class="rows">${shown.map((b) => {
      const r = myReading(b.id);
      return `<a class="row book-row" href="#/group/books/${esc(b.id)}">${cover(b)}
        <span class="row-main"><span class="row-title">${esc(b.title)}</span>
          <span class="row-sub">${esc(b.author)}. Suggested by ${esc(isMe(b.suggestedBy) ? 'you' : firstName(b.suggestedBy))}</span>
          ${stageCounts(b.id)}
          ${r && f === 'all' ? `<span class="my-read st-${r.status}">${mark(r.status)}You: ${esc(READ[r.status].toLowerCase())}</span>` : ''}
          ${b.groupBook ? '<span class="my-read">Group book</span>' : ''}</span>${chev}</a>`;
    }).join('')}</div>` : empty(f === 'all' ? 'No other books yet. Suggest one you got a lot from.'
      : { want: 'Nothing on your want list. Tap a book and choose Want.', reading: "You're not reading any of the group's books right now.", finished: "Books you finish show up here." }[f]);
    setView(html, 'group');
    $$('[data-bfilter]').forEach((b) => b.addEventListener('click', () => { state.bookFilter = b.dataset.bfilter; rerender(); }));
    $('#new-book').addEventListener('click', newBook);
  }

  function newBook() {
    openSheet(`
      <h2>Suggest a book</h2>
      <p class="sheet-sub">Tell the group why it's worth their time.</p>
      <div class="field"><label for="bk-title">Title</label><input id="bk-title" maxlength="120"></div>
      <div class="field"><label for="bk-author">Author</label><input id="bk-author" maxlength="80"></div>
      <div class="field"><label for="bk-why">Why read it?</label><textarea id="bk-why" rows="3" maxlength="300" placeholder="What did you take from it?"></textarea></div>
      <label class="check"><input type="checkbox" id="bk-mine" checked> Add to my list as finished</label>
      <div class="sheet-actions"><button class="btn btn-ghost" data-cancel>Cancel</button><button class="btn btn-primary" id="bk-save">Add book</button></div>`, (sheet) => {
      sheet.querySelector('#bk-save').addEventListener('click', async () => {
        const title = sheet.querySelector('#bk-title').value.trim();
        const author = sheet.querySelector('#bk-author').value.trim();
        if (!title || !author) { toast('Add the title and author'); return; }
        const b = await api.createBook({ title, author, suggestedBy: state.me.id, why: sheet.querySelector('#bk-why').value.trim() });
        if (sheet.querySelector('#bk-mine').checked) await api.setReadingStatus(b.id, state.me.id, 'finished');
        await refresh();
        closeSheet();
        toast('Book added');
        location.hash = `#/group/books/${b.id}`;
      });
    });
  }

  function renderBookDetail(id) {
    const b = state.books.find((x) => x.id === id);
    if (!b) return location.replace('#/group/books');
    const r = myReading(b.id);
    const stage = (s) => {
      const people = readersOf(b.id, s).sort((x, y) => ts(y.updatedAt) - ts(x.updatedAt));
      return `<div class="stage"><h3 class="st-${s}">${mark(s)}${esc(READ[s])}<span class="sec-count">${people.length}</span></h3>
        ${people.length ? `<ul class="people">${people.map((p) => `<li>${avatar(p.memberId, 'sm')}${esc(isMe(p.memberId) ? 'You' : memberName(p.memberId))}</li>`).join('')}</ul>` : '<p class="soon-line">No one yet</p>'}</div>`;
    };
    setView(`${back('#/group/books', 'Books')}
      <div class="book-head">${cover(b, 'xl')}
        <div>${b.groupBook ? '<p class="gb-label">Group book</p>' : ''}
          <h1 class="page-title">${esc(b.title)}</h1>
          <p class="book-author">${esc(b.author)}</p>
          <p class="row-sub">Suggested by ${esc(youOr(b.suggestedBy))}, ${esc(fmtDateYear.format(new Date(b.createdAt)))}</p></div>
      </div>
      ${b.why ? `<blockquote class="hold"><span>Why read it</span>${esc(b.why)}</blockquote>` : ''}
      <div class="field"><span class="label">Where you are</span>
        <div class="segmented" role="radiogroup" aria-label="Your reading status" id="read-seg">
          ${['want', 'reading', 'finished'].map((s) => `<button type="button" role="radio" aria-checked="${!!r && r.status === s}" class="seg-${s} ${r && r.status === s ? 'on' : ''}" data-read="${s}">${mark(s)}${READ_SHORT[s]}</button>`).join('')}
        </div>
        ${r ? '<button class="link-btn" id="read-clear">Take off my list</button>' : ''}</div>
      ${isAdmin() ? `<div class="btn-row"><button class="btn btn-ghost btn-sm" id="gb-toggle">${b.groupBook ? 'Stop being the group book' : 'Make group book'}</button></div>` : ''}
      <h2 class="sec">Who's reading it</h2>
      <div class="stages">${stage('reading')}${stage('finished')}${stage('want')}</div>
      ${commentsSection(b.comments, 'A takeaway, a favorite chapter, a disagreement')}`, 'group');
    $$('#read-seg [data-read]').forEach((btn) => btn.addEventListener('click', async () => {
      if (r && r.status === btn.dataset.read) return;
      await api.setReadingStatus(b.id, state.me.id, btn.dataset.read);
      await refresh();
      toast(`Marked ${READ[btn.dataset.read].toLowerCase()}`);
      rerender();
    }));
    const rc = $('#read-clear');
    if (rc) rc.addEventListener('click', async () => {
      await api.setReadingStatus(b.id, state.me.id, null);
      await refresh();
      toast('Taken off your list');
      rerender();
    });
    const gt = $('#gb-toggle');
    if (gt) gt.addEventListener('click', async () => {
      await api.setGroupBook(b.groupBook ? null : b.id);
      await refresh();
      toast(b.groupBook ? 'No group book right now' : `${b.title} is the group book`);
      rerender();
    });
    bindComments((text) => api.commentOnBook(b.id, { memberId: state.me.id, text }));
  }

  /* ---------- Get-togethers ---------- */
  function gtRow(e) {
    const d = new Date(e.datetime);
    const mine = myGTRsvp(e);
    const past = gtIsPast(e);
    return `<a class="row gt-row ${past || e.cancelled ? 'is-past' : ''}" href="#/group/gettogethers/${esc(e.id)}">
      <span class="date-chip" aria-hidden="true"><span>${esc(fmtMonth.format(d))}</span><b>${esc(fmtDay.format(d))}</b></span>
      <span class="row-main">
        <span class="row-title">${esc(e.title)}${e.visibility === 'closed' ? lockIcon : ''}</span>
        <span class="row-sub">${esc(GT_KINDS[e.kind] || 'Other')}, ${esc(fmtWeekday.format(d))} ${esc(fmtTime.format(d))}. ${esc(isMe(e.hostId) ? 'You host' : `${firstName(e.hostId)} hosts`)}</span>
        ${e.cancelled ? '<span class="gt-state cancelled">Cancelled</span>'
          : `<span class="gt-state">${goingCount(e)} ${past ? 'went' : 'going'}${!past && mine && !isMe(e.hostId) ? `<span class="st-${mine}">${mark(mine)}${esc(RSVP[mine])}</span>` : ''}</span>`}
      </span>${chev}</a>`;
  }

  const GT_ICONS = {
    coffee: '<path d="M5 9h11v5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5z"/><path d="M16 10.5h1.5a2.5 2.5 0 0 1 0 5H16M8.5 3.5c-.8 1 .8 2 0 3M12 3.5c-.8 1 .8 2 0 3"/>',
    lunch: '<path d="M7 3v7a2 2 0 0 0 2 2v9M11 3v7a2 2 0 0 1-2 2M9 3v6"/><path d="M17 21V3c-2 1.5-3 4-3 7v3h3"/>',
    dinner: '<circle cx="12" cy="13" r="6"/><circle cx="12" cy="13" r="3"/><path d="M3 4v5a1.5 1.5 0 0 0 1.5 1.5V20M21 4v16M21 4c-1.5 1-2 3-2 5h2"/>',
    visit: '<path d="M3.5 11L12 4l8.5 7"/><path d="M6 9.5V20h12V9.5"/><path d="M10 20v-5h4v5"/>',
    other: '<path d="M12 3l2.2 5.4 5.8.4-4.4 3.8 1.4 5.7L12 15.2l-5 3.1 1.4-5.7L4 8.8l5.8-.4z"/>'
  };
  // The next get-together, shown large: kind icon, host, where, and your RSVP.
  function gtFeature(e) {
    const d = new Date(e.datetime);
    const host = isMe(e.hostId);
    const mine = myGTRsvp(e);
    const rsvp = host ? '<span class="gt-you">You\'re hosting</span>'
      : mine ? `<span class="gt-you st-${mine}">${mark(mine)}${mine === 'yes' ? "You're going" : mine === 'maybe' ? 'You said maybe' : "You can't go"}</span>`
        : '<span class="gt-you gt-ask">You haven\'t answered</span>';
    return `<a class="gt-feature" href="#/group/gettogethers/${esc(e.id)}">
      <span class="gt-icon"><svg viewBox="0 0 24 24" aria-hidden="true">${GT_ICONS[e.kind] || GT_ICONS.other}</svg></span>
      <span class="gt-f-main">
        <span class="gt-eyebrow">Next ${esc(GT_KINDS[e.kind] && e.kind !== 'other' ? GT_KINDS[e.kind].toLowerCase() : 'get-together')} &middot; ${esc(fmtWeekday.format(d))}, ${esc(fmtMD.format(d))}</span>
        <span class="gt-f-title">${esc(e.title)}${e.visibility === 'closed' ? lockIcon : ''}</span>
        <span class="gt-f-when">${esc(fmtTime.format(d))}${e.location ? `, ${esc(e.location)}` : ''}</span>
        <span class="gt-host">${avatar(e.hostId, 'sm')}${esc(host ? 'You host' : `Hosted by ${memberName(e.hostId)}`)}</span>
        <span class="gt-f-foot">${rsvp}<span class="gt-going">${goingCount(e)} going</span></span>
      </span></a>`;
  }

  function renderGetTogethers() {
    const all = visibleGTs();
    const upcoming = all.filter((e) => !gtIsPast(e));
    const past = all.filter(gtIsPast).reverse();
    const next = upcoming.find((e) => !e.cancelled);
    const rest = upcoming.filter((e) => e !== next);
    setView(`${pageHead('Get-togethers', 'Coffee, dinners and visits between meetings. Anyone can plan one.', { backHtml: back('#/group', 'Group') })}
      ${next ? gtFeature(next) : ''}
      <button class="btn btn-primary btn-block" id="new-gt">Plan a get-together</button>
      <h2 class="sec">${next ? 'Later' : 'Upcoming'}<span class="sec-count">${rest.filter((e) => !e.cancelled).length}</span></h2>
      ${rest.length ? `<div class="rows">${rest.map(gtRow).join('')}</div>` : empty(next ? 'Nothing else planned yet. Coffee counts.' : 'Nothing planned. Invite someone for coffee.')}
      ${past.length ? `<h2 class="sec">Past</h2><div class="rows">${past.map(gtRow).join('')}</div>` : ''}`, 'group');
    $('#new-gt').addEventListener('click', () => editGetTogether(null));
  }

  function renderGetTogetherDetail(id) {
    const e = state.gettogethers.find((x) => x.id === id);
    if (!e || !canSeeGT(e)) return location.replace('#/group/gettogethers');
    const d = new Date(e.datetime);
    const past = gtIsPast(e);
    const host = isMe(e.hostId);
    const canEdit = (host || isAdmin()) && !past && !e.cancelled;
    const mine = myGTRsvp(e);
    const group = (s) => e.rsvps.filter((r) => r.status === s);
    const who = (s) => {
      const people = group(s);
      if (!people.length) return '';
      return `<div class="stage"><h3 class="st-${s}">${mark(s)}${esc(past && s === 'yes' ? 'Went' : RSVP[s])}<span class="sec-count">${people.length}</span></h3>
        <ul class="people">${people.map((p) => `<li>${avatar(p.memberId, 'sm')}${esc(isMe(p.memberId) ? 'You' : memberName(p.memberId))}${p.memberId === e.hostId ? '<span class="host-tag">Host</span>' : ''}</li>`).join('')}</ul></div>`;
    };
    const audience = e.visibility === 'closed' ? [e.hostId].concat(e.invitees) : state.members.map((m) => m.id);
    const silent = audience.filter((m) => !e.rsvps.some((r) => r.memberId === m));
    setView(`${back('#/group/gettogethers', 'Get-togethers')}
      <p class="owner-line">${avatar(e.hostId, 'sm')}${esc(host ? 'You' : memberName(e.hostId))} ${host ? 'are' : 'is'} hosting</p>
      <h1 class="page-title">${esc(e.title)}</h1>
      ${e.cancelled ? '<p class="gt-cancelled">Cancelled by the host</p>' : ''}
      <dl class="gt-facts">
        <div><dt>When</dt><dd>${esc(fmtDateShort.format(d))}, ${esc(fmtTime.format(d))}</dd></div>
        <div><dt>Where</dt><dd>${esc(e.location || 'To be decided')}</dd></div>
        <div><dt>Who</dt><dd>${e.visibility === 'closed' ? `${lockIcon}Invite only: ${esc(e.invitees.map((m) => (isMe(m) ? 'you' : firstName(m))).join(', '))}` : 'Open to everyone'}</dd></div>
      </dl>
      ${e.note ? `<p class="lede">${esc(e.note)}</p>` : ''}
      ${!past && !e.cancelled && !host ? `<div class="rsvp-block"><span class="label">Can you make it?</span>${rsvpControl(mine, e.id, 'Can you make it?')}</div>` : ''}
      <div class="btn-row">
        ${!past && !e.cancelled ? '<button class="btn btn-ghost btn-sm" id="gt-ics">Add to calendar</button>' : ''}
        ${canEdit ? '<button class="btn btn-ghost btn-sm" id="gt-edit">Edit</button><button class="btn btn-danger btn-sm" id="gt-cancel">Cancel it</button>' : ''}
      </div>
      <h2 class="sec">${past ? 'Who came' : "Who's coming"}</h2>
      <div class="stages">${who('yes')}${past ? '' : who('maybe') + who('no')}</div>
      ${!past && !e.cancelled && silent.length ? `<p class="soon-line"><b>No answer yet:</b> ${esc(silent.map((m) => (isMe(m) ? 'you' : firstName(m))).join(', '))}</p>` : ''}`, 'group');
    bindRsvp((gid, s) => api.rsvpGetTogether(gid, state.me.id, s));
    const ics = $('#gt-ics');
    if (ics) ics.addEventListener('click', () => { downloadGetTogetherICS(e); toast('Calendar file downloaded'); });
    const ed = $('#gt-edit');
    if (ed) ed.addEventListener('click', () => editGetTogether(e));
    const cn = $('#gt-cancel');
    if (cn) cn.addEventListener('click', async () => {
      if (!confirm(`Cancel ${e.title}? Everyone who can see it will see it's cancelled.`)) return;
      await api.cancelGetTogether(e.id);
      await refresh();
      toast('Get-together cancelled');
      rerender();
    });
  }

  function editGetTogether(e) {
    const isNew = !e;
    const draft = e ? JSON.parse(JSON.stringify(e)) : { hostId: state.me.id, title: '', kind: 'coffee', datetime: '', location: '', note: '', visibility: 'open', invitees: [] };
    const cur = draft.datetime ? isoToCentralInputs(draft.datetime) : { date: '', time: '' };
    const others = state.members.filter((m) => m.id !== draft.hostId);
    openSheet(`
      <h2>${isNew ? 'Plan a get-together' : 'Edit get-together'}</h2>
      <p class="sheet-sub">Times are Central.</p>
      <div class="field"><label for="gt-title">What's the plan?</label><input id="gt-title" maxlength="80" value="${esc(draft.title)}" placeholder="e.g. Coffee: PM interview practice"></div>
      <div class="field"><span class="label">Kind</span>
        <div class="chip-pick" role="radiogroup" id="gt-kind">${Object.keys(GT_KINDS).map((k) => `<button type="button" role="radio" class="chip ${draft.kind === k ? 'on' : ''}" aria-checked="${draft.kind === k}" data-k="${k}">${GT_KINDS[k]}</button>`).join('')}</div></div>
      <div class="field-row">
        <div class="field"><label for="gt-date">Date</label><input id="gt-date" type="date" value="${esc(cur.date)}"></div>
        <div class="field"><label for="gt-time">Time</label><input id="gt-time" type="time" value="${esc(cur.time)}"></div>
      </div>
      <div class="field"><label for="gt-loc">Where</label><input id="gt-loc" maxlength="120" value="${esc(draft.location)}" placeholder="Place or address"></div>
      <div class="field"><label for="gt-note">Note <span class="opt">optional</span></label><textarea id="gt-note" rows="2" maxlength="300">${esc(draft.note)}</textarea></div>
      <div class="field"><span class="label">Who can see it</span>
        <div class="segmented" role="radiogroup" id="gt-vis">
          <button type="button" role="radio" class="seg-active ${draft.visibility === 'open' ? 'on' : ''}" aria-checked="${draft.visibility === 'open'}" data-v="open">Everyone</button>
          <button type="button" role="radio" class="seg-active ${draft.visibility === 'closed' ? 'on' : ''}" aria-checked="${draft.visibility === 'closed'}" data-v="closed">${lockIcon}Invite only</button>
        </div></div>
      <div class="field" id="gt-inv-wrap" ${draft.visibility === 'closed' ? '' : 'hidden'}><span class="label">Invite <span class="opt">only they will see it</span></span>
        <div class="invitees" id="gt-inv">${others.map((m) => `<label class="inv"><input type="checkbox" value="${esc(m.id)}" ${draft.invitees.includes(m.id) ? 'checked' : ''}>${avatar(m.id, 'sm')}<span>${esc(m.name)}</span></label>`).join('')}</div></div>
      <div class="sheet-actions"><button class="btn btn-ghost" data-cancel>Cancel</button><button class="btn btn-primary" id="gt-save">${isNew ? 'Post it' : 'Save changes'}</button></div>`, (sheet) => {
      $$('#gt-kind [data-k]', sheet).forEach((b) => b.addEventListener('click', () => {
        draft.kind = b.dataset.k;
        $$('#gt-kind [data-k]', sheet).forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b); });
      }));
      $$('#gt-vis [data-v]', sheet).forEach((b) => b.addEventListener('click', () => {
        draft.visibility = b.dataset.v;
        $$('#gt-vis [data-v]', sheet).forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b); });
        sheet.querySelector('#gt-inv-wrap').hidden = draft.visibility !== 'closed';
      }));
      sheet.querySelector('#gt-save').addEventListener('click', async () => {
        const title = sheet.querySelector('#gt-title').value.trim();
        const date = sheet.querySelector('#gt-date').value;
        const time = sheet.querySelector('#gt-time').value;
        if (!title) { toast("Say what the plan is"); return; }
        if (!date || !time) { toast('Pick a date and time'); return; }
        const invitees = $$('#gt-inv input:checked', sheet).map((x) => x.value);
        if (draft.visibility === 'closed' && !invitees.length) { toast('Invite at least one person'); return; }
        const saved = await api.saveGetTogether(Object.assign(draft, {
          title, datetime: centralToISO(date, time), invitees,
          location: sheet.querySelector('#gt-loc').value.trim(), note: sheet.querySelector('#gt-note').value.trim()
        }));
        await refresh();
        closeSheet();
        toast(isNew ? 'Get-together posted' : 'Changes saved');
        if (isNew) location.hash = `#/group/gettogethers/${saved.id}`; else rerender();
      });
    });
  }

  /* ---------- Members & Working Genius ---------- */
  function teamMap() {
    const taken = state.members.filter((m) => m.workingGenius);
    const notTaken = state.members.filter((m) => !m.workingGenius);
    const gaps = WG.filter(([k]) => !taken.some((m) => geniusesOf(m).includes(k)));
    return `<section class="teammap" aria-label="Team map">
      <h2 class="sec">Team map<span class="sec-count">Working Genius</span></h2>
      <div class="wg-grid">${WG.map(([k, name]) => {
        const people = taken.filter((m) => geniusesOf(m).includes(k));
        return `<div class="wg-col ${people.length ? '' : 'gap'}" aria-label="${esc(name)}: ${esc(people.map((p) => p.name).join(', ') || 'nobody')}">
          <span class="wg-letter" title="${esc(name)}">${esc(k)}</span>
          ${people.map((p) => `<span class="wg-ini ${isMe(p.id) ? 'me' : ''}" title="${esc(p.name)}">${esc(initials(p.name))}</span>`).join('') || '<span class="wg-none">&ndash;</span>'}
        </div>`;
      }).join('')}</div>
      <p class="wg-legend">${WG.map(([k, n]) => `<span><b>${k}</b> ${n}</span>`).join('')}</p>
      ${gaps.map(([k, n]) => `<p class="wg-gap"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3l7.5 13h-15z"/><path d="M10 8.5v3.2M10 14v.1"/></svg>Nobody has ${esc(n)} as a genius. ${esc(WG_GAP[k].charAt(0).toUpperCase() + WG_GAP[k].slice(1))}.</p>`).join('')}
      ${notTaken.length ? `<p class="soon-line">Not added yet: ${esc(notTaken.map((m) => (isMe(m.id) ? 'you' : m.name.split(' ')[0])).join(', '))}</p>` : ''}
    </section>`;
  }

  function renderMembers() {
    const admin = canAdminRoster();
    // Admins: a small marker on anyone reminders can't fully reach.
    const missTag = (m) => {
      if (!admin || !state.contacts) return '';
      const miss = missingContact(contactOf(m.id));
      return miss ? `<span class="miss-tag">No ${esc(miss.replace(' and ', ' or '))}</span>` : '';
    };
    setView(`${pageHead('Members', `${plural(state.members.length, 'person', 'people')}. Tap anyone to see what they can help with.`, { backHtml: back('#/group', 'Group') })}
      ${teamMap()}
      <h2 class="sec">Everyone<span class="sec-count">${state.members.length}</span></h2>
      <div class="rows">${state.members.map((m) => `<a class="row member-row ${isMe(m.id) ? 'mine' : ''}" href="#/group/members/${esc(m.id)}">${avatar(m.id)}
        <span class="row-main"><span class="row-title">${esc(m.name)}${isMe(m.id) ? ' (you)' : ''}${wgChips(m)}</span>
          ${m.bio ? `<span class="row-sub clamp1">${esc(m.bio)}</span>` : ''}${missTag(m)}</span>
        ${m.role === 'admin' ? '<span class="role-tag">Admin</span>' : ''}${chev}</a>`).join('')}</div>
      ${admin ? `<h2 class="sec">Admin</h2>
      <div class="rows">
        <button class="row" id="add-member"><span class="row-main"><span class="row-title">Add a member</span>
          <span class="row-sub">Name and role. Email and phone are optional</span></span>${chev}</button>
        <button class="row" id="rotate-code"><span class="row-main"><span class="row-title">New invite code</span>
          <span class="row-sub">The old one stops working. Shown to you once</span></span>${chev}</button>
      </div>
      ${state.contacts ? '' : '<p class="soon-line">Contact details didn\'t load. Check your connection.</p>'}` : ''}`, 'group');
    const am = $('#add-member');
    if (am) am.addEventListener('click', addMemberSheet);
    const rc = $('#rotate-code');
    if (rc) rc.addEventListener('click', rotateInviteSheet);
  }

  function wgLine(label, keys) {
    return `<div class="wg-line"><dt>${esc(label)}</dt><dd>${keys.map((k) => `<span class="wg-chip">${esc(k)}</span><span class="wg-full">${esc(WG_NAME[k])}</span>`).join('')}</dd></div>`;
  }

  function renderMemberDetail(id) {
    const m = memberById(id);
    if (!m) return location.replace('#/group/members');
    const mine = isMe(m.id);
    const wgv = m.workingGenius;
    setView(`${back('#/group/members', 'Members')}
      <div class="profile-head">${avatar(m.id, 'lg')}
        <div><h1 class="page-title">${esc(m.name)}</h1>
        <p class="page-sub">${m.role === 'admin' ? 'Admin' : 'Member'}${mine ? ', you' : ''}</p></div>
      </div>
      ${m.bio ? `<p class="lede">${esc(m.bio)}</p>` : `<p class="soon-line">${mine ? 'Add what you do in Profile.' : 'No bio yet.'}</p>`}
      ${m.focus ? `<blockquote class="hold"><span>Focused on</span>${esc(m.focus)}</blockquote>` : ''}
      <h2 class="sec">Can help with</h2>
      ${m.canHelpWith && m.canHelpWith.length ? `<ul class="help-list">${m.canHelpWith.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>` : '<p class="soon-line">Nothing listed yet.</p>'}
      <h2 class="sec">Working Genius</h2>
      ${wgv ? `<dl class="wg-detail">${wgLine('Genius', wgv.geniuses)}${wgLine('Competency', wgv.competencies)}${wgLine('Frustration', wgv.frustrations)}</dl>`
        : `<p class="soon-line">${mine ? "You haven't added yours yet." : `${esc(m.name.split(' ')[0])} hasn't added results yet.`}</p>`}
      ${mine ? '<a class="btn btn-ghost btn-sm" href="#/profile">Edit in Profile</a>' : ''}
      ${canAdminRoster() ? (() => {
        const c = contactOf(m.id);
        return `<h2 class="sec">Contact<span class="sec-count">Admins only</span></h2>
      <div class="rows">
        <button class="row" id="admin-contact"><span class="row-main">
          <span class="row-title">${c.email ? esc(c.email) : '<span class="miss-tag">No email</span>'}</span>
          <span class="row-sub">${c.phone ? esc(prettyPhone(c.phone)) : '<span class="miss-tag">No phone</span>'}</span></span>${chev}</button>
      </div>
      ${mine ? '' : `<button class="btn btn-danger btn-block" id="remove-member">Remove ${esc(m.name.split(' ')[0])} from the group</button>`}`;
      })() : ''}`, 'group');
    const ac = $('#admin-contact');
    if (ac) ac.addEventListener('click', () => adminEditContact(m));
    const rm = $('#remove-member');
    if (rm) rm.addEventListener('click', () => removeMemberSheet(m));
  }

  function editAbout() {
    const m = state.me;
    openSheet(`
      <h2>About you</h2>
      <p class="sheet-sub">Shown on your card in Members.</p>
      <div class="field"><label for="ab-bio">What you do</label><input id="ab-bio" maxlength="140" value="${esc(m.bio || '')}" placeholder="e.g. Runs a bookkeeping practice for contractors"></div>
      <div class="field"><label for="ab-focus">Current focus <span class="opt">one line</span></label><input id="ab-focus" maxlength="120" value="${esc(m.focus || '')}" placeholder="What you're working on this month"></div>
      <div class="field"><label for="ab-help">Can help with <span class="opt">one per line</span></label><textarea id="ab-help" rows="3" maxlength="300">${esc((m.canHelpWith || []).join('\n'))}</textarea></div>
      <div class="sheet-actions"><button class="btn btn-ghost" data-cancel>Cancel</button><button class="btn btn-primary" id="ab-save">Save</button></div>`, (sheet) => {
      sheet.querySelector('#ab-save').addEventListener('click', async () => {
        await api.updateMember(m.id, {
          bio: sheet.querySelector('#ab-bio').value.trim(),
          focus: sheet.querySelector('#ab-focus').value.trim(),
          canHelpWith: sheet.querySelector('#ab-help').value.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 6)
        });
        await refresh();
        closeSheet();
        toast('Profile saved');
        rerender();
      });
    });
  }

  // Each of the six types gets exactly one of genius / competency / frustration, two of each.
  function editWorkingGenius() {
    const cur = state.me.workingGenius;
    const pick = {};
    if (cur) {
      cur.geniuses.forEach((k) => { pick[k] = 'g'; });
      cur.competencies.forEach((k) => { pick[k] = 'c'; });
      cur.frustrations.forEach((k) => { pick[k] = 'f'; });
    }
    const LBL = { g: 'Genius', c: 'Competency', f: 'Frustration' };
    const tally = () => ['g', 'c', 'f'].map((v) => Object.values(pick).filter((x) => x === v).length);
    openSheet(`
      <h2>Your Working Genius</h2>
      <p class="sheet-sub">Take the assessment at <a href="https://www.workinggenius.com" target="_blank" rel="noopener noreferrer">workinggenius.com</a>, then enter your results. Pick two of each.</p>
      <p class="total-line" id="wg-tally"></p>
      <div class="wg-edit" id="wg-edit">${WG.map(([k, n]) => `<div class="wg-edit-row" data-type="${k}">
        <span class="wg-edit-name"><span class="wg-chip">${k}</span>${esc(n)}</span>
        <div class="segmented" role="radiogroup" aria-label="${esc(n)}">${['g', 'c', 'f'].map((v) => `<button type="button" role="radio" class="seg-wg-${v} ${pick[k] === v ? 'on' : ''}" aria-checked="${pick[k] === v}" data-v="${v}">${LBL[v]}</button>`).join('')}</div>
      </div>`).join('')}</div>
      ${cur ? '<button class="link-btn" id="wg-clear">Remove my results</button>' : ''}
      <div class="sheet-actions"><button class="btn btn-ghost" data-cancel>Cancel</button><button class="btn btn-primary" id="wg-save">Save</button></div>`, (sheet) => {
      const drawTally = () => {
        const [g, c, f] = tally();
        const el = sheet.querySelector('#wg-tally');
        el.textContent = `Genius ${g} of 2, competency ${c} of 2, frustration ${f} of 2`;
        el.classList.toggle('over', g > 2 || c > 2 || f > 2);
      };
      drawTally();
      sheet.querySelector('#wg-edit').addEventListener('click', (e) => {
        const b = e.target.closest('[data-v]');
        if (!b) return;
        const row = b.closest('[data-type]');
        pick[row.dataset.type] = b.dataset.v;
        $$('[data-v]', row).forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b); });
        drawTally();
      });
      const clr = sheet.querySelector('#wg-clear');
      if (clr) clr.addEventListener('click', async () => {
        await api.updateMember(state.me.id, { workingGenius: null });
        await refresh();
        closeSheet();
        toast('Results removed');
        rerender();
      });
      sheet.querySelector('#wg-save').addEventListener('click', async () => {
        const [g, c, f] = tally();
        if (g !== 2 || c !== 2 || f !== 2) { toast('Pick exactly two of each'); return; }
        const by = (v) => WG.map(([k]) => k).filter((k) => pick[k] === v);
        await api.updateMember(state.me.id, { workingGenius: { geniuses: by('g'), competencies: by('c'), frustrations: by('f') } });
        await refresh();
        closeSheet();
        toast('Working Genius saved');
        rerender();
      });
    });
  }

  function renderAsks() {
    const sorted = state.asks.slice().sort((a, b) => ts(b.createdAt) - ts(a.createdAt));
    const open = sorted.filter((a) => a.status === 'open');
    const resolved = sorted.filter((a) => a.status !== 'open');
    const row = (a) => {
      const helpers = a.replies.filter((r) => r.canHelp).length;
      return `<a class="row ask-row ${a.status}" href="#/group/asks/${esc(a.id)}">${mark(a.status, 'row-mark')}
        <span class="row-main"><span class="row-title">${esc(a.title)}</span>
        <span class="row-sub">${esc(youOr(a.memberId))}, ${esc(relTime(a.createdAt))}${a.replies.length ? `. ${plural(a.replies.length, 'reply', 'replies')}` : ''}</span>
        ${helpers && a.status === 'open' ? `<span class="help-count">${helpers} can help</span>` : ''}</span>${chev}</a>`;
    };
    setView(`${pageHead('Asks', 'Need an intro, a second opinion or a hand? Ask the group.', { backHtml: back('#/group', 'Group') })}
      <button class="btn btn-primary btn-block" id="new-ask">Ask for help</button>
      <h2 class="sec">Open<span class="sec-count">${open.length}</span></h2>
      ${open.length ? `<div class="rows">${open.map(row).join('')}</div>` : empty('No open asks. If something is stuck, ask.')}
      ${resolved.length ? `<h2 class="sec">Resolved</h2><div class="rows">${resolved.map(row).join('')}</div>` : ''}`, 'group');
    $('#new-ask').addEventListener('click', newAsk);
  }

  function newAsk() {
    openSheet(`
      <h2>Ask for help</h2>
      <p class="sheet-sub">Be specific. The group sees it right away.</p>
      <div class="field"><label for="ask-title">What do you need?</label><input id="ask-title" maxlength="100" placeholder="e.g. Intro to a good bookkeeper"></div>
      <div class="field"><label for="ask-detail">Details <span class="opt">optional</span></label><textarea id="ask-detail" rows="3" maxlength="500" placeholder="Deadline, budget, what you've tried"></textarea></div>
      <div class="field"><span class="label">What kind of help? <span class="opt">optional</span></span>
        <div class="chip-pick" role="radiogroup" id="ask-needs">
          <button type="button" role="radio" class="chip on" aria-checked="true" data-n="">Not sure</button>
          ${Object.keys(NEEDS).map((k) => `<button type="button" role="radio" class="chip" aria-checked="false" data-n="${k}">${esc(NEEDS[k].label)}</button>`).join('')}
        </div><p class="field-help">We'll point out whose Working Genius fits.</p></div>
      <div class="sheet-actions"><button class="btn btn-ghost" data-cancel>Cancel</button><button class="btn btn-primary" id="ask-save">Post ask</button></div>`, (sheet) => {
      let needs = '';
      $$('#ask-needs [data-n]', sheet).forEach((b) => b.addEventListener('click', () => {
        needs = b.dataset.n;
        $$('#ask-needs [data-n]', sheet).forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b); });
      }));
      sheet.querySelector('#ask-save').addEventListener('click', async () => {
        const title = sheet.querySelector('#ask-title').value.trim();
        if (!title) { toast('Say what you need first'); return; }
        const a = await api.createAsk({ memberId: state.me.id, title, detail: sheet.querySelector('#ask-detail').value.trim(), needs: needs || null });
        await refresh();
        closeSheet();
        toast('Ask posted');
        location.hash = `#/group/asks/${a.id}`;
      });
    });
  }

  function renderAskDetail(id) {
    const a = state.asks.find((x) => x.id === id);
    if (!a) return location.replace('#/group/asks');
    const mine = isMe(a.memberId);
    const offered = a.replies.some((r) => isMe(r.memberId) && r.canHelp);
    const open = a.status === 'open';
    setView(`${back('#/group/asks', 'Asks')}
      <p class="owner-line">${avatar(a.memberId, 'sm')}${esc(youOr(a.memberId))}, ${esc(relTime(a.createdAt))}</p>
      <h1 class="page-title">${esc(a.title)}</h1>
      ${a.detail ? `<p class="lede">${esc(a.detail)}</p>` : ''}
      <p class="ask-state ${a.status}">${mark(a.status)}${open ? 'Open' : 'Resolved'}${a.needs && NEEDS[a.needs] ? `<span class="needs-tag">${esc(NEEDS[a.needs].label)}</span>` : ''}</p>
      ${a.needs && NEEDS[a.needs] ? (() => {
        const fits = NEEDS[a.needs].fits;
        const people = state.members.filter((m) => m.id !== a.memberId && geniusesOf(m).some((k) => fits.includes(k)));
        const nameOf = (m) => (isMe(m.id) ? 'you' : m.name.split(' ')[0]);
        return `<p class="fit-line"><b>People whose genius fits:</b> ${people.length
          ? esc(fits.length > 1
            ? people.map((m) => `${nameOf(m)} (${geniusesOf(m).filter((k) => fits.includes(k)).map((k) => WG_NAME[k]).join(', ')})`).join(', ')
            : `${people.map(nameOf).join(', ')} (${WG_NAME[fits[0]]})`)
          : `nobody has ${esc(fits.map((k) => WG_NAME[k]).join(' or '))} yet. Anyone can still help.`}</p>`;
      })() : ''}
      <div class="btn-row">
        ${open && !mine && !offered ? '<button class="btn btn-primary" id="can-help">I can help</button>' : ''}
        ${open && !mine && offered ? '<span class="offered">' + mark('done') + 'You offered to help</span>' : ''}
        ${mine || isAdmin() ? `<button class="btn btn-ghost" id="toggle-resolved">${open ? 'Mark resolved' : 'Reopen'}</button>` : ''}
      </div>
      <h2 class="sec">Replies<span class="sec-count">${a.replies.length}</span></h2>
      ${a.replies.length ? `<ol class="thread">${a.replies.map((r) => `<li class="${r.canHelp ? 'helps' : ''}">
        ${avatar(r.memberId, 'sm')}<div><p class="th-head"><b>${esc(youOr(r.memberId))}</b>${r.canHelp ? '<span class="help-pill">Can help</span>' : ''}<span class="when">${esc(relTime(r.createdAt))}</span></p>
        <p>${esc(r.text)}</p></div></li>`).join('')}</ol>` : `<p class="soon-line">${mine ? 'No replies yet. People get a nudge when you post.' : 'No replies yet. Be the first.'}</p>`}
      ${open ? `<form id="reply-form" class="reply-form">
        <label for="reply-text" class="label">Reply</label>
        <textarea id="reply-text" rows="2" maxlength="400" placeholder="${mine ? 'Add an update' : 'Suggest someone, share what worked, or offer a hand'}"></textarea>
        <button class="btn btn-ghost" type="submit">Send reply</button>
      </form>` : ''}`, 'group');

    const ch = $('#can-help');
    if (ch) ch.addEventListener('click', () => {
      openSheet(`<h2>Offer to help</h2>
        <p class="sheet-sub">${esc(firstName(a.memberId))} will see this on the ask.</p>
        <div class="field"><label for="help-text">How can you help?</label><textarea id="help-text" rows="3" maxlength="400" placeholder="e.g. I know someone. I'll text you their number tonight."></textarea></div>
        <div class="sheet-actions"><button class="btn btn-ghost" data-cancel>Cancel</button><button class="btn btn-primary" id="help-save">Send offer</button></div>`, (sheet) => {
        sheet.querySelector('#help-save').addEventListener('click', async () => {
          const text = sheet.querySelector('#help-text').value.trim() || 'I can help with this.';
          await api.replyToAsk(a.id, { memberId: state.me.id, text, canHelp: true });
          await refresh();
          closeSheet();
          toast('Offer sent');
          rerender();
        });
      });
    });
    const tr = $('#toggle-resolved');
    if (tr) tr.addEventListener('click', async () => {
      await api.updateAsk(a.id, { status: open ? 'resolved' : 'open' });
      await refresh();
      toast(open ? 'Marked resolved' : 'Reopened');
      rerender();
    });
    const rf = $('#reply-form');
    if (rf) rf.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = $('#reply-text').value.trim();
      if (!text) { toast('Write a reply first'); return; }
      await api.replyToAsk(a.id, { memberId: state.me.id, text, canHelp: false });
      await refresh();
      toast('Reply sent');
      rerender();
    });
  }

  /* ---------- Contact details and reminders (Supabase) ---------- */
  const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  // "(512) 555-0123", "512.555.0123", "+1 512 555 0123" -> "+15125550123". '' if blank, null if not a number.
  function toE164(raw) {
    const t = String(raw || '').trim();
    if (!t) return '';
    const d = t.replace(/\D/g, '');
    if (t.startsWith('+') && !d.startsWith('1')) return d.length >= 8 && d.length <= 15 ? `+${d}` : null;
    const ten = d.length === 11 && d[0] === '1' ? d.slice(1) : d;
    return ten.length === 10 && /^[2-9]/.test(ten) ? `+1${ten}` : null;
  }
  const prettyPhone = (e) => (/^\+1\d{10}$/.test(e || '') ? `(${e.slice(2, 5)}) ${e.slice(5, 8)}-${e.slice(8)}` : e || '');
  function missingContact(c) {
    const noE = !(c && c.email); const noP = !(c && c.phone);
    return noE && noP ? 'email and phone' : noE ? 'email' : noP ? 'phone' : '';
  }
  const switchRow = (id, title, sub, on) => `<label class="switch-row"><span class="sw-text"><b>${esc(title)}</b>
      <span class="sw-sub">${esc(sub)}</span></span>
    <input type="checkbox" role="switch" id="${id}" ${on ? 'checked' : ''}><span class="sw" aria-hidden="true"></span></label>`;

  // Email, mobile, the two reminder switches and (setup only) "What do you do".
  function contactFieldsHTML({ withBio = false, withPrefs = true } = {}) {
    const c = state.myContact || {};
    const prefs = state.prefs || { sms: true, email: true };
    return `<div class="field"><label for="ct-email">Email</label>
        <input id="ct-email" type="email" inputmode="email" autocomplete="email" autocapitalize="off" spellcheck="false" maxlength="120" placeholder="you@example.com" value="${esc(c.email || '')}"></div>
      <div class="field"><label for="ct-phone">Mobile phone</label>
        <input id="ct-phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="24" placeholder="(512) 555-0123" value="${esc(prettyPhone(c.phone))}">
        <p class="field-help">US mobile number. Used only for reminders.</p></div>
      ${withPrefs ? `${switchRow('ct-sms', 'Text me reminders', 'To your mobile phone', !!c.phone && prefs.sms !== false)}
      ${switchRow('ct-mail', 'Email me reminders', 'To your email', prefs.email !== false)}
      <p class="field-help">Meeting reminders still reach you by email or notification if you turn both off.</p>` : ''}
      ${withBio ? `<div class="field"><label for="ct-bio">What do you do <span class="opt">optional</span></label>
        <input id="ct-bio" maxlength="140" value="${esc((state.me && state.me.bio) || '')}" placeholder="e.g. Runs a bookkeeping practice for contractors"></div>` : ''}`;
  }
  // "Text me" follows the phone field until the person flips it themselves.
  function bindContactFields(root) {
    const sms = root.querySelector('#ct-sms');
    const phone = root.querySelector('#ct-phone');
    if (!sms || !phone) return;
    let touched = false;
    sms.addEventListener('change', () => { touched = true; });
    phone.addEventListener('input', () => { if (!touched) sms.checked = !!phone.value.trim(); });
  }
  // { email, phone, sms, emailOn, bio } or { error } after focusing the field to fix.
  function readContactFields(root) {
    const emailEl = root.querySelector('#ct-email');
    const phoneEl = root.querySelector('#ct-phone');
    const email = emailEl.value.trim();
    if (email && !EMAIL_RE.test(email)) { emailEl.focus(); return { error: 'Check the email address' }; }
    const phone = toE164(phoneEl.value);
    if (phone === null) { phoneEl.focus(); return { error: 'Enter a 10-digit US mobile number' }; }
    const sms = root.querySelector('#ct-sms');
    const mail = root.querySelector('#ct-mail');
    const bio = root.querySelector('#ct-bio');
    return { email: email || null, phone: phone || null, sms: sms ? sms.checked && !!phone : null,
      emailOn: mail ? mail.checked : null, bio: bio ? bio.value.trim() : null };
  }
  // Saves your contact row, then your toggles, then (if changed) your bio. Rejects with
  // a HandledError (toast already shown) if any step fails; earlier steps stay saved.
  async function saveMyContact(v) {
    const saved = await api.updateMyContact({ email: v.email, phone: v.phone });
    state.myContact = { email: saved.email, phone: saved.phone };
    if (state.contacts) {
      state.contacts = state.contacts.filter((x) => x.memberId !== state.me.id).concat({ memberId: state.me.id, email: saved.email, phone: saved.phone });
    }
    if (v.sms !== null || v.emailOn !== null) {
      const p = {};
      if (v.sms !== null) p.sms = v.sms;
      if (v.emailOn !== null) p.email = v.emailOn;
      state.prefs = Object.assign({}, state.prefs, await api.updateNotificationPrefs(p));
    }
    if (v.bio !== null && v.bio !== (state.me.bio || '')) {
      await api.updateMyProfile({ bio: v.bio });
      await refresh();
    }
  }

  // First run, after the rules: shown once until saved or skipped (Profile has the same fields).
  function renderProfileSetup() {
    showChrome(false);
    const cfg = state.config;
    setView(`
      <div class="onboard onboard-tight">
        ${cfg.logoSvg ? `<div class="logo-big logo-big-svg">${shorelineLogoSVG(96, 'var(--primary)')}</div>` : `<div class="logo-big" aria-hidden="true">${esc(cfg.logoText)}</div>`}
        <h1>Set up your profile</h1>
        <p class="lede">So meeting reminders reach you. Only you and ${esc(cfg.name)}'s admins see your email and phone.</p>
      </div>
      <form id="setup-form" class="setup-form" novalidate>
        ${contactFieldsHTML({ withBio: true })}
        <button class="btn btn-primary btn-block" type="submit" id="setup-save">Save and continue</button>
      </form>
      <button class="link-btn" id="setup-skip">Skip for now</button>`);
    window.scrollTo(0, 0);
    const form = $('#setup-form');
    bindContactFields(form);
    const done = (how, msg) => {
      store.set(setupKey(), how);
      toast(msg);
      if (location.hash !== '#/home') location.hash = '#/home'; else route();
    };
    let busy = false;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy) return;
      const v = readContactFields(form);
      if (v.error) { toast(v.error); return; }
      busy = true;
      $('#setup-save').disabled = true;
      try { await saveMyContact(v); } catch (err) { busy = false; $('#setup-save').disabled = false; return; }
      done('saved', 'Profile saved');
    });
    $('#setup-skip').addEventListener('click', () => done('skipped', 'You can add these any time in Profile'));
  }

  // Profile > Email, phone and reminders.
  function editContact() {
    openSheet(`
      <h2>Email, phone and reminders</h2>
      <p class="sheet-sub">Only you and the group's admins see these.</p>
      ${contactFieldsHTML()}
      <div class="sheet-actions"><button class="btn btn-ghost" data-cancel>Cancel</button><button class="btn btn-primary" id="ct-save">Save</button></div>`, (sheet) => {
      bindContactFields(sheet);
      let busy = false;
      sheet.querySelector('#ct-save').addEventListener('click', async () => {
        if (busy) return;
        const v = readContactFields(sheet);
        if (v.error) { toast(v.error); return; }
        busy = true;
        try { await saveMyContact(v); } catch (err) { busy = false; return; }
        store.set(setupKey(), 'saved');
        closeSheet();
        toast('Saved');
        rerender();
      });
    });
  }

  /* ---------- Admin roster tools (Supabase) ---------- */
  const contactOf = (id) => (state.contacts || []).find((c) => c.memberId === id) || { memberId: id, email: null, phone: null };
  const canAdminRoster = () => SUPA && isAdmin();

  function adminEditContact(m) {
    const c = contactOf(m.id);
    openSheet(`
      <h2>${esc(m.name.split(' ')[0])}'s contact</h2>
      <p class="sheet-sub">For reminders. Only admins and ${esc(m.name.split(' ')[0])} see these.</p>
      <div class="field"><label for="ac-email">Email</label>
        <input id="ac-email" type="email" inputmode="email" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="120" value="${esc(c.email || '')}"></div>
      <div class="field"><label for="ac-phone">Mobile phone</label>
        <input id="ac-phone" type="tel" inputmode="tel" autocomplete="off" maxlength="24" placeholder="(512) 555-0123" value="${esc(prettyPhone(c.phone))}"></div>
      <div class="sheet-actions"><button class="btn btn-ghost" data-cancel>Cancel</button><button class="btn btn-primary" id="ac-save">Save</button></div>`, (sheet) => {
      let busy = false;
      sheet.querySelector('#ac-save').addEventListener('click', async () => {
        if (busy) return;
        const emailEl = sheet.querySelector('#ac-email'); const phoneEl = sheet.querySelector('#ac-phone');
        const email = emailEl.value.trim();
        if (email && !EMAIL_RE.test(email)) { emailEl.focus(); toast('Check the email address'); return; }
        const phone = toE164(phoneEl.value);
        if (phone === null) { phoneEl.focus(); toast('Enter a 10-digit US mobile number'); return; }
        busy = true;
        let saved;
        try { saved = await api.adminSaveContact(m.id, { email: email || null, phone: phone || null }); } catch (e) { busy = false; return; }
        state.contacts = (state.contacts || []).filter((x) => x.memberId !== m.id).concat(saved);
        if (isMe(m.id)) state.myContact = { email: saved.email, phone: saved.phone };
        closeSheet();
        toast('Contact saved');
        rerender();
      });
    });
  }

  function addMemberSheet() {
    let role = 'member';
    openSheet(`
      <h2>Add a member</h2>
      <p class="sheet-sub">They join with the group's invite code and pick their name.</p>
      <div class="field"><label for="am-name">Name</label><input id="am-name" maxlength="80" autocomplete="off" placeholder="First and last name"></div>
      <div class="field"><span class="label">Role</span>
        <div class="segmented" role="radiogroup" aria-label="Role" id="am-role">
          <button type="button" role="radio" class="seg-active on" aria-checked="true" data-role="member">Member</button>
          <button type="button" role="radio" class="seg-active" aria-checked="false" data-role="admin">Admin</button>
        </div></div>
      <div class="field"><label for="am-email">Email <span class="opt">optional</span></label>
        <input id="am-email" type="email" inputmode="email" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="120"></div>
      <div class="field"><label for="am-phone">Mobile phone <span class="opt">optional</span></label>
        <input id="am-phone" type="tel" inputmode="tel" autocomplete="off" maxlength="24" placeholder="(512) 555-0123"></div>
      <div class="sheet-actions"><button class="btn btn-ghost" data-cancel>Cancel</button><button class="btn btn-primary" id="am-save">Add member</button></div>`, (sheet) => {
      $$('#am-role [data-role]', sheet).forEach((b) => b.addEventListener('click', () => {
        role = b.dataset.role;
        $$('#am-role [data-role]', sheet).forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b); });
      }));
      let busy = false;
      sheet.querySelector('#am-save').addEventListener('click', async () => {
        if (busy) return;
        const nameEl = sheet.querySelector('#am-name');
        const name = nameEl.value.trim().replace(/\s+/g, ' ');
        if (!name) { nameEl.focus(); toast('Add their name'); return; }
        const emailEl = sheet.querySelector('#am-email'); const phoneEl = sheet.querySelector('#am-phone');
        const email = emailEl.value.trim();
        if (email && !EMAIL_RE.test(email)) { emailEl.focus(); toast('Check the email address'); return; }
        const phone = toE164(phoneEl.value);
        if (phone === null) { phoneEl.focus(); toast('Enter a 10-digit US mobile number'); return; }
        busy = true;
        try { await api.addMember({ name, role, email: email || null, phone: phone || null }); } catch (e) { busy = false; return; }
        await refresh();
        await loadContact();
        closeSheet();
        toast(`Added ${name.split(' ')[0]}`);
        rerender();
      });
    });
  }

  function removeMemberSheet(m) {
    const first = m.name.split(' ')[0];
    openSheet(`
      <h2>Remove ${esc(first)}?</h2>
      <p class="sheet-sub">${esc(first)} is signed out and leaves the roster and hot seat rotation. Their commitments, posts and comments stay in the history.</p>
      <div class="sheet-actions"><button class="btn btn-ghost" data-cancel>Cancel</button><button class="btn btn-danger" id="rm-go">Remove ${esc(first)}</button></div>`, (sheet) => {
      let busy = false;
      sheet.querySelector('#rm-go').addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        try { await api.removeMember(m.id); } catch (e) { busy = false; return; }
        await refresh();
        closeSheet();
        toast(`${first} removed`);
        location.hash = '#/group/members';
      });
    });
  }

  function rotateInviteSheet() {
    openSheet(`
      <h2>New invite code</h2>
      <p class="sheet-sub">The old code stops working right away. People already signed in stay signed in, unless you sign them out.</p>
      ${switchRow('ri-signout', 'Also sign everyone else out', 'They enter the new code next time they open the app', false)}
      <div class="sheet-actions"><button class="btn btn-ghost" data-cancel>Cancel</button><button class="btn btn-primary" id="ri-go">Make new code</button></div>`, (sheet) => {
      let busy = false;
      sheet.querySelector('#ri-go').addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        let code;
        try { code = await api.rotateInviteCode(null, sheet.querySelector('#ri-signout').checked); } catch (e) { busy = false; return; }
        // Shown once: only a hash is stored, so nobody can look it up later.
        sheet.innerHTML = `<div class="grab" aria-hidden="true"></div>
          <h2>Your new invite code</h2>
          <p class="sheet-sub">Copy it now and send it to the group. It's shown only once.</p>
          <p class="invite-code" id="ri-code">${esc(code)}</p>
          <div class="sheet-actions"><button class="btn btn-ghost" id="ri-copy">${copyIcon}Copy code</button><button class="btn btn-primary" id="ri-done">Done</button></div>`;
        sheet.querySelector('#ri-copy').addEventListener('click', () => copyText(String(code), 'Invite code copied'));
        sheet.querySelector('#ri-done').addEventListener('click', () => closeSheet());
      });
    });
  }

  /* ---------- Profile ---------- */
  function renderProfile() {
    const other = GROUP === 'family' ? 'entrepreneur' : 'family';
    const otherName = other === 'family' ? 'The Shoreline' : 'Flight Club';
    setView(`<header class="page-head">${back('#/home', 'Home')}
      <div class="profile-head">${avatar(state.me.id, 'xl')}
        <div><h1 class="page-title">${esc(state.me.name)}</h1>
        <p class="page-sub">${state.me.role === 'admin' ? 'Admin' : 'Member'}, ${esc(state.config.name)}</p></div>
      </div></header>
      <h2 class="sec">About you</h2>
      <div class="rows">
        <button class="row" id="edit-about"><span class="row-main"><span class="row-title">What you do and your focus</span>
          <span class="row-sub">${esc(state.me.focus || state.me.bio || 'Add a line so the group knows how to help')}</span></span>${chev}</button>
        <button class="row" id="edit-wg"><span class="row-main"><span class="row-title">Working Genius${wgChips(state.me)}</span>
          <span class="row-sub">${state.me.workingGenius ? `Genius: ${esc(state.me.workingGenius.geniuses.map((k) => WG_NAME[k]).join(', '))}` : 'Not added yet'}</span></span>${chev}</button>
        <a class="row" href="https://www.workinggenius.com" target="_blank" rel="noopener noreferrer"><span class="row-main"><span class="row-title">Take the assessment at workinggenius.com</span>
          <span class="row-sub">Opens their site. Come back and enter your results.</span></span>${extIcon}</a>
        <a class="row" href="#/group/members/${esc(state.me.id)}"><span class="row-main"><span class="row-title">See your member card</span></span>${chev}</a>
      </div>
      ${isAdmin() ? (() => {
        const g = groupLocation();
        return `<h2 class="sec">Group settings</h2>
      <div class="rows">
        <button class="row" id="edit-loc"><span class="loc-badge sm" aria-hidden="true">${locIcon(g)}</span>
          <span class="row-main"><span class="row-title">Meeting location</span>
          <span class="row-sub">${esc(isZoom(g) ? `Zoom, ${shortUrl(g.url)}` : g.type === 'zoom' ? 'Zoom, link not added yet' : locText(g))}</span></span>${chev}</button>
      </div>`;
      })() : ''}
      ${SUPA ? (() => {
        const c = state.myContact;
        const p = state.prefs || {};
        const have = c ? [c.email, c.phone && prettyPhone(c.phone)].filter(Boolean).join(', ') : '';
        const missing = c ? missingContact(c) : '';
        const on = [c && c.phone && p.sms !== false ? 'Texts' : '', p.email !== false ? 'Email' : ''].filter(Boolean);
        return `<h2 class="sec">Reminders</h2>
      <div class="rows">
        <button class="row" id="edit-contact"><span class="row-main"><span class="row-title">Email, phone and reminders</span>
          <span class="row-sub">${c ? esc(have || 'Not added yet') : 'Not loaded. Check your connection.'}</span>
          ${c ? `<span class="row-sub">${esc(on.length ? `${on.join(' and ')} on` : 'Texts and email off')}${missing ? `. Add your ${esc(missing)}` : ''}</span>` : ''}</span>${chev}</button>
      </div>`;
      })() : ''}
      <h2 class="sec">Device</h2>
      <div class="rows">
        ${SUPA ? (() => {
          const snap = state.offline ? store.get('snapshot', null) : null;
          return `<div class="row static conn-row" id="conn-row"><span class="conn-dot ${state.offline ? 'off' : 'on'}" aria-hidden="true"></span>
          <span class="row-main"><span class="row-title">${state.offline ? 'Offline, showing cached' : 'Connected'}</span>
          <span class="row-sub">${state.offline ? `${snap && snap.savedAt ? `Saved ${esc(relTime(snap.savedAt))}. ` : ''}Changes may not save until you're back online.`
            : baseApi.realtimeConnected ? 'Live updates on' : 'Checks for updates every 30 seconds'}</span></span></div>`;
        })() : ''}
        <button class="row" id="switch-user"><span class="row-main"><span class="row-title">Switch user</span><span class="row-sub">${SUPA ? "Sign out on this device. You'll need the invite code again" : 'Pick a different name on this device'}</span></span>${chev}</button>
        <a class="row" href="?group=${other}${params.get('backend') === 'local' ? '&backend=local' : ''}"><span class="row-main"><span class="row-title">Switch group</span><span class="row-sub">Open ${esc(otherName)}</span></span>${chev}</a>
      </div>
      ${SUPA ? '' : `<h2 class="sec">Prototype</h2>
      <p class="soon-line">Your changes are saved on this device only. Reset to restore the sample data for ${esc(state.config.name)}.</p>
      <button class="btn btn-danger btn-block" id="reset">Reset demo data</button>`}`, '');

    $('#edit-about').addEventListener('click', editAbout);
    const ec = $('#edit-contact');
    if (ec) ec.addEventListener('click', editContact);
    $('#edit-wg').addEventListener('click', editWorkingGenius);
    const el = $('#edit-loc');
    if (el) el.addEventListener('click', editGroupLocation);
    $('#switch-user').addEventListener('click', () => signOutToInvite());
    const reset = $('#reset');
    if (reset) reset.addEventListener('click', async () => {
      if (!confirm('Reset all sample data for this group? Your edits will be lost.')) return;
      await api.resetDemo();
      store.remove('bannerDismissed');
      // Also forget rule agreements and "last seen" for announcements, so the demo starts fresh.
      try {
        Object.keys(localStorage).filter((k) => k.startsWith(store.key('rules:')) || k.startsWith(store.key('annSeen:')))
          .forEach((k) => localStorage.removeItem(k));
      } catch (e) { /* ignore */ }
      await loadData();
      state.me = memberById(store.get('user', null)) || null;
      toast('Demo data reset');
      if (!state.me) renderWho(); else route();
    });
  }

  /* ---------- Router ---------- */
  function route(keepScroll) {
    if (!state.config) return;
    if (!store.get('verified', false)) return renderInvite();
    if (!state.me) {
      // No roster to choose from (e.g. a stale "verified" flag from the demo): ask for the code again.
      if (!state.members || !state.members.length) { store.remove('verified'); return renderInvite(); }
      return renderWho();
    }
    if (!rulesAccepted()) return renderRulesGate();
    // First run with Supabase: ask for email and phone once (saved or skipped).
    if (SUPA && state.myContact && !contactComplete() && !store.get(setupKey(), null)) return renderProfileSetup();
    showChrome(true);
    const y = window.scrollY;
    if (keepScroll !== true) {
      closeSheet(true);
      state.editPrep = false;
    }
    const parts = (location.hash || '#/home').slice(2).split('/');
    const [a, b, c] = parts;
    const go = () => {
      switch (a) {
        case 'home': return renderHome();
        case 'meetings':
          if (b && c === 'checkins') return renderCheckins(b);
          if (b) return renderMeetingDetail(b);
          return renderMeetings();
        case 'track':
          if (b === 'goals') return renderGoals();
          if (b === 'score') return renderScoreboard();
          return renderCommitments();
        case 'goals': return renderGoalDetail(b);
        case 'hotseat': return renderHotSeat();
        case 'group':
          if (b === 'asks' && c) return renderAskDetail(c);
          if (b === 'asks') return renderAsks();
          if (b === 'members' && c) return renderMemberDetail(c);
          if (b === 'members') return renderMembers();
          if (b === 'announcements' && c) return renderAnnouncementDetail(c);
          if (b === 'announcements') return renderAnnouncements();
          if (b === 'ideas' && c) return renderIdeaDetail(c);
          if (b === 'ideas') return renderIdeas();
          if (b === 'books' && c) return renderBookDetail(c);
          if (b === 'books') return renderBooks();
          if (b === 'gettogethers' && c) return renderGetTogetherDetail(c);
          if (b === 'gettogethers') return renderGetTogethers();
          if (b === 'rules') return renderRules();
          return renderGroup();
        case 'profile': return renderProfile();
        default: return location.replace('#/home');
      }
    };
    go();
    window.scrollTo(0, keepScroll === true ? y : 0);
  }

  const COLLECTIONS = ['members', 'meetings', 'commitments', 'goals', 'checkins', 'asks', 'announcements', 'ideas', 'books', 'readingList', 'gettogethers'];
  /* Loads everything into state. Demo mode: throws on failure (init shows the error).
     Supabase mode: never throws. On failure it keeps what's on screen, or the last
     good copy saved on this device, sets state.offline and returns false. */
  async function loadData() {
    try {
      const [members, meetings, commitments, goals, checkins, asks, announcements, ideas, books, readingList, gettogethers] = await Promise.all([
        baseApi.getMembers(), baseApi.getMeetings(), baseApi.getCommitments(), baseApi.getGoals(), baseApi.getCheckins(), baseApi.getAsks(),
        baseApi.getAnnouncements(), baseApi.getIdeas(), baseApi.getBooks(), baseApi.getReadingList(), baseApi.getGetTogethers()
      ]);
      const groupLoc = await baseApi.getGroupLocation();
      Object.assign(state, { members, meetings, commitments, goals, checkins, asks, announcements, ideas, books, readingList, gettogethers, groupLocation: groupLoc });
      if (SUPA && baseApi.isSignedIn()) {
        state.offline = false;
        // Last good copy, for opening the app offline. Contact details are never in it.
        // Includes the server-only config (rules, version, usual place with the Zoom link):
        // config/<group>.json no longer has the link, so offline it comes from here.
        const cfgExtra = {};
        ['rules', 'rulesVersion', 'location'].forEach((k) => { if (state.config && state.config[k] !== undefined) cfgExtra[k] = state.config[k]; });
        const snap = { savedAt: new Date().toISOString(), groupLocation: groupLoc, config: cfgExtra };
        COLLECTIONS.forEach((k) => { snap[k] = state[k]; });
        store.set('snapshot', snap);
      }
      state.loaded = true;
    } catch (err) {
      if (!SUPA) throw err;
      state.offline = true;
      const snap = store.get('snapshot', null);
      if (!state.loaded && snap && baseApi.isSignedIn()) {
        COLLECTIONS.forEach((k) => { if (Array.isArray(snap[k])) state[k] = snap[k]; });
        state.groupLocation = snap.groupLocation || null;
        if (snap.config && state.config) Object.assign(state.config, snap.config);
        state.loaded = true;
      }
      if (state.me) state.me = memberById(state.me.id) || state.me;
      return false;
    }
    if (state.me) state.me = memberById(state.me.id) || state.me;
    return true;
  }

  // Supabase: your contact details and reminder toggles (admins: everyone's contacts).
  // Separate from loadData because they're private and not part of the cached copy.
  async function loadContact() {
    if (!SUPA || !baseApi.isSignedIn()) return;
    const [c, p] = await Promise.all([baseApi.getMyContact().catch(noteError), baseApi.getNotificationPrefs().catch(noteError)]);
    if (c) state.myContact = { email: c.email || null, phone: c.phone || null };
    if (p) state.prefs = p;
    const role = (state.me && state.me.role) || (state.session && state.session.role);
    state.contacts = role === 'admin' ? await baseApi.getContacts().catch(() => state.contacts) : null;
  }
  const contactComplete = () => !!(state.myContact && state.myContact.email && state.myContact.phone);
  const setupKey = () => `profileSetup:${state.me.id}`;

  // First load: skeleton rows in the group's own style (cards, rules, motif), not a spinner.
  function renderSkeleton() {
    $('#topbar').hidden = false;
    $('#tabbar').hidden = false;
    const row = (w) => `<div class="row static skel-row" aria-hidden="true"><span class="skel skel-dot"></span>
      <span class="row-main"><span class="skel skel-line" style="width:${w}%"></span><span class="skel skel-line skel-sub"></span></span></div>`;
    setView(`<div class="skel-wrap" role="status" aria-label="Loading ${esc(state.config.name)}">
      <div class="skel skel-hero" aria-hidden="true"></div>
      <span class="skel skel-line skel-sec" aria-hidden="true"></span>
      <div class="rows">${row(72)}${row(58)}${row(66)}</div>
      <span class="skel skel-line skel-sec" aria-hidden="true"></span>
      <div class="rows">${row(48)}${row(62)}</div>
    </div>`, 'home');
  }
  // Signed in but nothing could be loaded and nothing is cached.
  function renderLoadError() {
    showChrome(false);
    setView(`<div class="load-error"><b>Couldn't reach ${esc(state.config.name)}.</b>
      <p>Check your connection, then try again. Nothing you've saved is lost.</p>
      <button class="btn btn-primary" id="retry-load">Try again</button></div>`, '');
    $('#retry-load').addEventListener('click', async () => {
      renderSkeleton();
      await afterSignIn();
      if (!state.loaded) return renderLoadError();
      state.me = memberById(store.get('user', null)) || null;
      route();
    });
  }

  // Sheet open or someone typing: don't redraw under them.
  const isBusy = () => !!$('#sheet-root').innerHTML
    || !!(document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName));
  async function applyRemote() {
    if (isBusy()) { state.pendingRemote = true; return; }
    state.pendingRemote = false;
    await loadData();
    if (!isBusy()) rerender(); else state.pendingRemote = true;
  }

  function bindLiveUpdates() {
    if (!SUPA) return;
    // Another member changed something: the api already refetched it; redraw.
    window.addEventListener('mastermind:remote-change', () => { if (state.me) applyRemote(); });
    // A quick write (RSVP, status, like, comment...) was refused after the screen
    // showed it. The api has put its cache back; show that.
    // (Writes the screen waits for report through their own rejection instead.)
    window.addEventListener('mastermind:sync-error', (e) => {
      const d = e.detail || {};
      const err = d.error || d;
      noteError(err);
      if (d.background === false) return;
      toast(friendlyError(err), 4000);
      if (state.me) applyRemote();
    });
    // Session revoked (signed out elsewhere, removed, code rotated with sign-out).
    window.addEventListener('mastermind:signed-out', () => {
      if (!state.me && !store.get('verified', false)) return;
      clearSignedInState();
      closeSheet(true);
      toast('You were signed out. Enter the invite code to sign in again.', 4000);
      route();
    });
    window.addEventListener('online', async () => {
      if (!state.me) return;
      const ok = await loadData();
      if (ok) { await loadContact(); if (!isBusy()) rerender(); }
    });
    window.addEventListener('offline', () => {
      state.offline = true;
      if (location.hash === '#/profile' && !isBusy()) rerender();
    });
  }

  async function init() {
    // api rejections are already shown as a toast; don't also report them as uncaught.
    window.addEventListener('unhandledrejection', (e) => { if (e.reason instanceof HandledError) e.preventDefault(); });
    try {
      state.config = await baseApi.getConfig();
      if (!state.config || !state.config.colors) throw new Error(`Could not load config/${GROUP}.json`);
      applyBranding(state.config);
      bindLiveUpdates();
      if (SUPA && baseApi.isSignedIn()) {
        renderSkeleton();
        await afterSignIn();
        if (!baseApi.isSignedIn()) clearSignedInState();          // session was revoked
        else if (!state.loaded) { window.addEventListener('hashchange', () => route()); return renderLoadError(); }
      } else {
        if (SUPA) { store.remove('user'); store.remove('snapshot'); }  // no session: start at the invite
        await loadData();
      }
      state.me = memberById(store.get('user', null)) || null;
      window.addEventListener('hashchange', () => route());
      route();
      // Keep the countdown fresh without re-rendering (so typing in a form isn't lost).
      setInterval(() => {
        const busy = isBusy();
        // Someone else's change arrived while this person was mid-edit: apply it now.
        if (state.pendingRemote && !busy && state.me) { applyRemote(); return; }
        const el = $('#cd-num');
        const nm = heroMeeting();
        if (!el || !nm) return;
        // The join window opened/closed or the meeting started: redraw Home, unless someone is mid-edit.
        if (liveKey() !== homeLiveKey && !busy) { rerender(); return; }
        const cd = countdown(nm);
        el.textContent = cd.num;
        $('#cd-unit').textContent = cd.unit;
      }, 30000);
    } catch (err) {
      $('#view').innerHTML = `<div class="load-error"><b>Couldn't load the app.</b>
        <p>${esc(err.message)}. If you opened the file directly, serve the folder instead (see README).</p></div>`;
    }
  }

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  // Exposed for debugging and for the future backend swap.
  window.mastermind = { api, state };
  init();
})();
