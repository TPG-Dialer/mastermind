/* Mastermind: Supabase data layer.
   Drop-in replacement for the `api` object in app.js: same method names,
   same arguments, same return shapes (README "Data shapes"). index.html loads
   it before app.js; app.js uses window.MASTERMIND_API when it is set.

   Needs window.MASTERMIND_SUPABASE = { url, anonKey, vapidPublicKey? } from
   config/supabase.js, loaded before this file. Exposes window.MASTERMIND_API,
   except with ?backend=local in the URL or when url/anonKey are missing: then
   app.js falls back to its built-in demo data.

   How it talks to Supabase
   - Tables and RPCs through PostgREST (fetch, no library needed).
   - Login through the `join` Edge Function: invite code -> roster -> a 6-digit
     code by email or text (requestCode / verifyCode) -> a session token.
     The token is kept in localStorage (mm:<group>:session) and sent as the
     x-session-token header; row-level security uses it to know who you are.
   - Everything read is cached in memory. Writes update the cache, so the app's
     "await api.x(); await refresh();" pattern costs no extra network round trips.
   - Quick, low-risk writes (RSVP, status, likes, comments, check-ins, reading
     status, profile) are optimistic: they resolve right away and are sent in
     the background. If the server refuses, the cache is put back and a
     `mastermind:sync-error` event fires. Writes with side effects (meeting
     changes, hot seat, action plan, get-togethers, new posts) wait for the server.
   - Other members' changes: a content-free Supabase Realtime broadcast says
     "table X changed"; the cache refetches that table and fires
     `mastermind:remote-change`. If Realtime can't connect, it polls the tiny
     group_activity table every 30 seconds instead.
*/
(function () {
  'use strict';

  const SB = window.MASTERMIND_SUPABASE || {};
  const GROUPS = ['family', 'entrepreneur'];
  const requested = window.MASTERMIND_GROUP || new URLSearchParams(location.search).get('group');
  const GROUP = GROUPS.includes(requested) ? requested : 'family';
  const TZ = 'America/Chicago';
  const REST = `${String(SB.url || '').replace(/\/$/, '')}/rest/v1`;
  const FN = `${String(SB.url || '').replace(/\/$/, '')}/functions/v1`;
  const OPTIMISTIC = SB.optimistic !== false;
  const MAX_AGE = 60 * 1000;          // without Realtime, cached data older than this is refetched
  const POLL_MS = 30 * 1000;
  const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js';

  /* ---------- Storage (same keys as app.js: mm:<group>:<key>) ---------- */
  const store = {
    key: (k) => `mm:${GROUP}:${k}`,
    get(k, fallback) {
      try { const raw = localStorage.getItem(this.key(k)); return raw == null ? fallback : JSON.parse(raw); } catch (e) { return fallback; }
    },
    set(k, v) { try { localStorage.setItem(this.key(k), JSON.stringify(v)); } catch (e) { /* ignore */ } },
    remove(k) { try { localStorage.removeItem(this.key(k)); } catch (e) { /* ignore */ } }
  };
  const session = {
    token: () => (store.get('session', null) || {}).token || null,
    memberId: () => (store.get('session', null) || {}).memberId || null,
    set: (s) => store.set('session', s),
    clear: () => store.remove('session')
  };

  const myId = () => session.memberId();

  /* ---------- Small helpers ---------- */
  const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
  const nowISO = () => new Date().toISOString();
  const uid = (p) => `${p}-${(crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2))}`;
  const pad = (n) => String(n).padStart(2, '0');
  const enc = encodeURIComponent;
  const emit = (name, detail) => window.dispatchEvent(new CustomEvent(`mastermind:${name}`, { detail }));

  const ctParts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  });
  // "2026-11-08T21:00:00+00:00" -> "2026-11-08T15:00:00-06:00", the shape the prototype data uses.
  function toCentral(iso) {
    if (!iso) return iso;
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    const p = {};
    for (const x of ctParts.formatToParts(d)) p[x.type] = x.value;
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
    const off = Math.round((asUtc - Math.floor(d.getTime() / 1000) * 1000) / 60000);
    const a = Math.abs(off);
    return `${p.year}-${p.month}-${p.day}T${pad(+p.hour % 24)}:${p.minute}:${p.second}${off < 0 ? '-' : '+'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
  }

  class ApiError extends Error {
    constructor(message, status, code) { super(message); this.status = status; this.code = code; }
  }

  /* ---------- HTTP ---------- */
  async function http(method, url, { body, prefer } = {}) {
    if (!SB.url || !SB.anonKey) throw new ApiError('Supabase is not configured (config/supabase.js)', 0);
    const h = { apikey: SB.anonKey, 'Content-Type': 'application/json' };
    // Legacy anon keys are JWTs and go in Authorization too; new sb_publishable_ keys must not.
    if (/^eyJ/.test(SB.anonKey)) h.Authorization = `Bearer ${SB.anonKey}`;
    const tok = session.token();
    if (tok) h['x-session-token'] = tok;
    if (prefer) h.Prefer = prefer;
    let res;
    try {
      res = await fetch(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
    } catch (e) {
      throw new ApiError("Can't reach the server. Check your connection and try again.", 0, 'network');
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    if (!res.ok) {
      const msg = (data && (data.message || data.error || data.hint)) || `Request failed (${res.status})`;
      const err = new ApiError(msg, res.status, data && data.code);
      if (data && typeof data === 'object') { err.data = data; err.detail = data.detail || null; }
      throw err;
    }
    return data;
  }
  const rest = (method, path, opts) => http(method, `${REST}/${path}`, opts);
  const rpc = (name, args) => http('POST', `${REST}/rpc/${name}`, { body: args || {} });
  const callFn = (name, body) => http('POST', `${FN}/${name}`, { body });
  const RETURN = 'return=representation';
  const UPSERT = 'resolution=merge-duplicates,return=representation';

  /* ---------- Row mapping: database (snake_case) -> app shapes ---------- */
  const comment = (c) => ({ memberId: c.member_id, text: c.text, createdAt: c.created_at });
  const byCreated = (a, b) => String(a.createdAt).localeCompare(String(b.createdAt));
  const MAP = {
    members: (r) => ({ id: r.id, name: r.name, role: r.role, bio: r.bio, focus: r.focus,
      canHelpWith: r.can_help_with || [], workingGenius: r.working_genius || null,
      enrolledAt: r.enrolled_at || null, enrolledBy: r.enrolled_by || null }),
    meetings: (r) => {
      const m = { id: r.id, datetime: toCentral(r.starts_at), title: r.title, durationMinutes: r.duration_minutes,
        agenda: r.agenda || [], hotSeatMemberId: r.hot_seat_member_id, hotSeatPrep: r.hot_seat_prep || null,
        actionPlan: r.action_plan || null, notes: r.notes || '',
        attendance: (r.meeting_attendance || []).map((a) => a.member_id),
        rsvps: (r.meeting_rsvps || []).map((x) => ({ memberId: x.member_id, status: x.status })) };
      if (r.location) m.location = r.location;      // omitted = group default, like the prototype
      return m;
    },
    commitments: (r) => {
      const c = { id: r.id, memberId: r.member_id, meetingId: r.meeting_id, text: r.text, status: r.status,
        updatedAt: r.updated_at, lastUpdateNote: r.last_update_note || '', goalId: r.goal_id || null };
      if (r.done_at) c.doneAt = r.done_at;
      return c;
    },
    goals: (r) => ({ id: r.id, memberId: r.member_id, period: r.period, title: r.title, why: r.why,
      targetDate: r.target_date, status: r.status, accountabilityAsk: r.accountability_ask }),
    checkins: (r) => {
      const k = { id: r.id, meetingId: r.meeting_id, memberId: r.member_id, win: r.win, challenge: r.challenge, submittedAt: r.submitted_at };
      if (r.edited_at) k.editedAt = r.edited_at;
      return k;
    },
    asks: (r) => ({ id: r.id, memberId: r.member_id, title: r.title, detail: r.detail, createdAt: r.created_at,
      status: r.status, needs: r.needs || null,
      replies: (r.ask_replies || []).map((x) => ({ memberId: x.member_id, text: x.text, createdAt: x.created_at, canHelp: !!x.can_help })).sort(byCreated) }),
    announcements: (r) => ({ id: r.id, authorId: r.author_id, title: r.title, body: r.body, createdAt: r.created_at,
      pinned: !!r.pinned, important: !!r.important, comments: (r.announcement_comments || []).map(comment).sort(byCreated) }),
    ideas: (r) => ({ id: r.id, memberId: r.member_id, type: r.type, title: r.title, note: r.note, url: r.url || '',
      createdAt: r.created_at, likes: (r.idea_likes || []).map((l) => l.member_id),
      comments: (r.idea_comments || []).map(comment).sort(byCreated) }),
    books: (r) => ({ id: r.id, title: r.title, author: r.author, suggestedBy: r.suggested_by, why: r.why,
      createdAt: r.created_at, groupBook: !!r.group_book, comments: (r.book_comments || []).map(comment).sort(byCreated) }),
    readingList: (r) => ({ bookId: r.book_id, memberId: r.member_id, status: r.status, updatedAt: r.updated_at }),
    gettogethers: (r) => ({ id: r.id, hostId: r.host_id, title: r.title, kind: r.kind, datetime: toCentral(r.starts_at),
      location: r.location, note: r.note, visibility: r.visibility,
      invitees: (r.get_together_invitees || []).map((i) => i.member_id),
      rsvps: (r.get_together_rsvps || []).map((x) => ({ memberId: x.member_id, status: x.status })), cancelled: !!r.cancelled }),
    trainings: (r) => ({ id: r.id, datetime: toCentral(r.starts_at), durationMinutes: r.duration_minutes, topic: r.topic,
      description: r.description, videoUrl: r.video_url, recordingUrl: r.recording_url,
      rsvps: (r.training_rsvps || []).map((x) => ({ memberId: x.member_id, status: x.status })) }),
    notes: (r) => {
      const n = { id: r.id, meetingId: r.meeting_id, source: r.source, title: r.title || '', summary: r.summary || '',
        keyPoints: r.key_points || [],
        nextSteps: (r.next_steps || []).map((x) => ({ text: x.text, memberId: x.memberId || null })),
        createdBy: r.created_by || null, createdAt: r.created_at, updatedAt: r.updated_at,
        editedBy: r.edited_by || null, editedAt: r.edited_at || null };
      if (r.source === 'zoom') n.zoom = { topic: r.zoom_topic || '', startAt: r.zoom_start_at ? toCentral(r.zoom_start_at) : null };
      return n;
    },
    settings: (r) => r
  };

  // What each collection fetches. RLS decides which rows come back.
  const QUERY = {
    members: 'members?select=id,name,role,bio,focus,can_help_with,working_genius,sort_order,enrolled_at,enrolled_by&removed_at=is.null&order=sort_order.asc,name.asc',
    meetings: 'meetings?select=*,meeting_rsvps(member_id,status),meeting_attendance(member_id)&cancelled_at=is.null&order=starts_at.asc',
    commitments: 'commitments?select=*&order=created_at.asc',
    goals: 'goals?select=*&order=created_at.asc',
    checkins: 'checkins?select=*&order=submitted_at.asc',
    asks: 'asks?select=*,ask_replies(member_id,text,created_at,can_help)&order=created_at.asc',
    announcements: 'announcements?select=*,announcement_comments(member_id,text,created_at)&order=created_at.asc',
    ideas: 'ideas?select=*,idea_likes(member_id),idea_comments(member_id,text,created_at)&order=created_at.asc',
    books: 'books?select=*,book_comments(member_id,text,created_at)&order=created_at.asc',
    readingList: 'reading_list?select=*',
    gettogethers: 'get_togethers?select=*,get_together_invitees(member_id),get_together_rsvps(member_id,status)&order=starts_at.asc',
    trainings: 'trainings?select=*,training_rsvps(member_id,status)&cancelled_at=is.null&order=starts_at.asc',
    // raw (the Zoom payload) isn't readable by the app; unattached Zoom notes come back for admins only.
    notes: 'meeting_notes?select=id,meeting_id,source,title,summary,key_points,next_steps,created_by,edited_by,edited_at,created_at,updated_at,zoom_topic,zoom_start_at&order=created_at.asc',
    settings: 'group_settings?select=rules,rules_version,location_default,location_override,meeting_rule,training_rule,agenda_template,notification_options,zoom_meeting_id'
  };
  // Realtime/polling table name -> cached collection.
  const TABLE_TO_COLL = {
    members: 'members', group_settings: 'settings', meetings: 'meetings', meeting_rsvps: 'meetings', meeting_attendance: 'meetings',
    trainings: 'trainings', training_rsvps: 'trainings', get_togethers: 'gettogethers', get_together_invitees: 'gettogethers',
    get_together_rsvps: 'gettogethers', goals: 'goals', commitments: 'commitments', checkins: 'checkins', asks: 'asks',
    ask_replies: 'asks', announcements: 'announcements', announcement_comments: 'announcements', ideas: 'ideas',
    idea_likes: 'ideas', idea_comments: 'ideas', books: 'books', book_comments: 'books', reading_list: 'readingList',
    meeting_notes: 'notes'
  };

  /* ---------- Cache ---------- */
  const cache = {};
  const loadedAt = {};
  const gen = {};          // bumped by remote changes, so an in-flight load doesn't clear a newer "dirty"
  const dirty = new Set();
  const inflight = {};

  function load(coll) {
    if (inflight[coll]) return inflight[coll];
    const startGen = gen[coll] || 0;
    inflight[coll] = rest('GET', QUERY[coll]).then((rows) => {
      cache[coll] = (rows || []).map(MAP[coll]);
      loadedAt[coll] = Date.now();
      if ((gen[coll] || 0) === startGen) dirty.delete(coll);
      return cache[coll];
    }).finally(() => { delete inflight[coll]; });
    return inflight[coll];
  }
  async function get(coll) {
    if (!session.token()) return coll === 'members' ? clone(store.get('roster', [])) : [];
    realtime.ensure();
    const fresh = cache[coll] && !dirty.has(coll) && (realtime.connected || Date.now() - loadedAt[coll] < MAX_AGE);
    if (!fresh) await load(coll);
    return clone(cache[coll]);
  }
  function markDirty(coll) { gen[coll] = (gen[coll] || 0) + 1; dirty.add(coll); }
  function clearCache() { Object.keys(cache).forEach((k) => { delete cache[k]; delete loadedAt[k]; }); dirty.clear(); }
  const findIn = (coll, id, what) => {
    const x = (cache[coll] || []).find((i) => i.id === id);
    if (!x && what) throw new ApiError(`${what} not found`, 404);
    return x;
  };

  /* One write.
     colls:      cached collections this write touches (refetched after the server answers)
     apply():    optional; changes the cache now and returns the optimistic result
     send():     the network call
     result():   what to resolve with once the server has answered and the cache is reloaded
     optimistic: resolve with apply()'s result right away instead of waiting */
  async function mutate({ colls, apply, send, result, optimistic }) {
    const snap = {};
    colls.forEach((c) => { if (cache[c]) snap[c] = clone(cache[c]); });
    let local;
    if (apply && colls.every((c) => cache[c])) {
      local = apply();
      emit('local-change', { collections: colls });
    }
    // background: the caller already got the optimistic result, so only this event reports a failure.
    const background = !!(optimistic && OPTIMISTIC && local !== undefined);
    const server = send().then(async (res) => {
      colls.forEach(markDirty);
      await Promise.all(colls.map((c) => load(c).catch(() => null)));
      return res;
    }, (err) => {
      colls.forEach((c) => { if (snap[c]) cache[c] = snap[c]; markDirty(c); });
      emit('sync-error', { message: err.message, error: err, collections: colls, background });
      throw err;
    });
    if (background) {
      server.catch(() => { /* reported through mastermind:sync-error */ });
      return clone(local);
    }
    const res = await server;
    return clone(result ? result(res) : (local !== undefined ? local : res));
  }

  /* ---------- Realtime (broadcast pings) with polling fallback ---------- */
  const realtime = {
    started: false, connected: false, client: null, channel: null, timer: null, seen: null, pending: new Set(), debounce: null,
    ensure() { if (!this.started && session.token()) { this.started = true; this.start().catch(() => this.poll()); } },
    async start() {
      rpc('touch_session').catch(() => {});
      const info = await rpc('get_session_info');
      if (!info) { handleSignedOut(); return; }
      try {
        await loadScript(SUPABASE_JS);
        if (!window.supabase || !window.supabase.createClient) throw new Error('supabase-js missing');
        this.client = window.supabase.createClient(SB.url, SB.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
        this.channel = this.client.channel(`mm-${info.realtimeKey}`, { config: { broadcast: { self: false } } })
          .on('broadcast', { event: 'change' }, (msg) => this.remote([msg && msg.payload && msg.payload.table]))
          .subscribe((status) => {
            this.connected = status === 'SUBSCRIBED';
            if (this.connected) this.stopPoll(); else this.poll();
          });
      } catch (e) {
        this.poll();
      }
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') { this.check(); rpc('touch_session').catch(() => {}); }
      });
    },
    poll() {
      if (this.timer) return;
      this.check();
      this.timer = setInterval(() => { if (document.visibilityState === 'visible') this.check(); }, POLL_MS);
    },
    stopPoll() { if (this.timer) { clearInterval(this.timer); this.timer = null; } },
    // One small request: when did each table last change?
    async check() {
      if (!session.token()) return;
      try {
        const rows = await rest('GET', 'group_activity?select=table_name,changed_at');
        const now = {};
        (rows || []).forEach((r) => { now[r.table_name] = r.changed_at; });
        if (this.seen) this.remote(Object.keys(now).filter((t) => now[t] !== this.seen[t]));
        this.seen = now;
      } catch (e) { /* offline; try next time */ }
    },
    remote(tables) {
      tables.filter(Boolean).forEach((t) => this.pending.add(t));
      clearTimeout(this.debounce);
      this.debounce = setTimeout(async () => {
        const colls = [...new Set([...this.pending].map((t) => TABLE_TO_COLL[t]).filter(Boolean))];
        this.pending.clear();
        if (!colls.length) return;
        colls.forEach(markDirty);
        await Promise.all(colls.filter((c) => cache[c]).map((c) => load(c).catch(() => null)));
        emit('remote-change', { collections: colls });
        listeners.forEach((cb) => { try { cb(colls); } catch (e) { /* ignore */ } });
      }, 400);
    },
    stop() {
      this.stopPoll();
      if (this.channel && this.client) this.client.removeChannel(this.channel);
      this.channel = null; this.connected = false; this.started = false; this.seen = null;
    }
  };
  const listeners = new Set();

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve();
      const s = document.createElement('script');
      s.src = src; s.async = true; s.crossOrigin = 'anonymous';
      s.onload = () => resolve(); s.onerror = () => reject(new Error(`Could not load ${src}`));
      document.head.appendChild(s);
    });
  }

  const defaultDeviceLabel = () => (navigator.userAgent.match(/iPhone|iPad|Android|Mac|Windows/) || [''])[0];
  // After verify-code: keep the token, forget the invite code.
  function startSession(res) {
    session.set({ token: res.sessionToken, memberId: res.member.id, createdAt: nowISO() });
    store.set('user', res.member.id);
    store.remove('pendingInvite');
    clearCache();
    realtime.ensure();
    return Object.assign({}, res.member);
  }

  function handleSignedOut() {
    session.clear();
    store.remove('verified');
    store.remove('user');
    clearCache();
    realtime.stop();
    emit('signed-out', {});
  }

  /* ---------- Field mapping for writes ---------- */
  const pickMap = (obj, map) => {
    const out = {};
    Object.keys(map).forEach((k) => { if (obj && k in obj) out[map[k]] = obj[k] === undefined ? null : obj[k]; });
    return out;
  };
  const MEETING_FIELDS = { datetime: 'starts_at', title: 'title', agenda: 'agenda', location: 'location',
    hotSeatMemberId: 'hot_seat_member_id', notes: 'notes', durationMinutes: 'duration_minutes' };
  const COMMITMENT_FIELDS = { text: 'text', status: 'status', lastUpdateNote: 'last_update_note', goalId: 'goal_id' };
  const GOAL_FIELDS = { period: 'period', title: 'title', why: 'why', targetDate: 'target_date', status: 'status', accountabilityAsk: 'accountability_ask' };
  const MEMBER_FIELDS = { bio: 'bio', focus: 'focus', canHelpWith: 'can_help_with', workingGenius: 'working_genius' };
  const ASK_FIELDS = { title: 'title', detail: 'detail', needs: 'needs', status: 'status' };
  const TRAINING_FIELDS = { datetime: 'starts_at', durationMinutes: 'duration_minutes', topic: 'topic', description: 'description',
    videoUrl: 'video_url', recordingUrl: 'recording_url' };

  // Upsert one "status" row (RSVPs, reading list) in a cached list of { memberId, status }.
  function setRsvp(list, memberId, status) {
    const r = list.find((x) => x.memberId === memberId);
    if (r) r.status = status; else list.push({ memberId, status });
  }

  /* ======================================================================
     The api object. Same methods as app.js, then Supabase-only extras.
     ====================================================================== */
  const api = {
    backend: 'supabase',

    /* Branding comes from config/<group>.json (instant, works offline) plus the
       database: public branding before login, rules and location after. */
    async getConfig() {
      const local = await fetch(`config/${GROUP}.json`, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
      let pub = null;
      try { pub = await rpc('get_group_config', { p_group: GROUP }); } catch (e) { /* use the file */ }
      const cfg = Object.assign({}, local, pub || {});
      if (session.token()) {
        try {
          const [s] = await load('settings');
          if (s) Object.assign(cfg, { rules: s.rules, rulesVersion: s.rules_version, location: s.location_default });
        } catch (e) { /* keep the file's values */ }
      }
      delete cfg.inviteCode;   // invite codes are checked by the join function now
      delete cfg.sheetId;
      cfg.backend = 'supabase';
      return cfg;
    },

    getMembers: () => get('members'),
    async updateMember(id, patch) {
      await get('members');
      const body = pickMap(patch, MEMBER_FIELDS);
      return mutate({
        colls: ['members'], optimistic: true,
        apply: () => { const m = findIn('members', id, 'Member'); Object.keys(MEMBER_FIELDS).forEach((k) => { if (k in patch) m[k] = patch[k]; }); return m; },
        send: () => rest('PATCH', `members?id=eq.${enc(id)}`, { body, prefer: RETURN }),
        result: () => findIn('members', id)
      });
    },

    getMeetings: () => get('meetings'),
    // patch.location = null clears the meeting's own place (back to the group default).
    async updateMeeting(id, patch) {
      const body = pickMap(patch, MEETING_FIELDS);
      if ('location' in patch && !patch.location) body.location = null;
      return mutate({
        colls: ['meetings'],
        send: () => rest('PATCH', `meetings?id=eq.${enc(id)}`, { body, prefer: RETURN }),
        result: () => findIn('meetings', id)
      });
    },
    async swapHotSeat(aId, bId) {
      return mutate({
        colls: ['meetings'],
        send: () => rpc('swap_hot_seat', { p_a: aId, p_b: bId }),
        result: () => [findIn('meetings', aId), findIn('meetings', bId)]
      });
    },
    async saveHotSeatPrep(meetingId, prep) {
      return mutate({
        colls: ['meetings'],
        send: () => rpc('save_hot_seat_prep', { p_meeting_id: meetingId, p_prep: prep }),
        result: () => findIn('meetings', meetingId)
      });
    },
    async saveActionPlan(meetingId, plan) {
      return mutate({
        colls: ['meetings', 'commitments'],
        send: () => rpc('save_action_plan', { p_meeting_id: meetingId, p_plan: plan }),
        result: (res) => ({ meeting: findIn('meetings', meetingId),
          commitment: findIn('commitments', res && res.commitment && res.commitment.id) })
      });
    },
    async setMeetingRsvp(meetingId, memberId, status) {
      await get('meetings');
      return mutate({
        colls: ['meetings'], optimistic: true,
        apply: () => { const m = findIn('meetings', meetingId, 'Meeting'); setRsvp(m.rsvps, memberId, status); return m; },
        send: () => rest('POST', 'meeting_rsvps?on_conflict=meeting_id,member_id',
          { body: { meeting_id: meetingId, member_id: memberId, status }, prefer: UPSERT }),
        result: () => findIn('meetings', meetingId)
      });
    },

    getCommitments: () => get('commitments'),
    async updateCommitment(id, patch) {
      await get('commitments');
      return mutate({
        colls: ['commitments'], optimistic: true,
        apply: () => {
          const c = findIn('commitments', id, 'Commitment');
          if (patch.status === 'done' && c.status !== 'done') c.doneAt = nowISO();
          if (patch.status && patch.status !== 'done') delete c.doneAt;
          Object.assign(c, patch, { updatedAt: nowISO() });
          return c;
        },
        send: () => rest('PATCH', `commitments?id=eq.${enc(id)}`, { body: pickMap(patch, COMMITMENT_FIELDS), prefer: RETURN }),
        result: () => findIn('commitments', id)
      });
    },
    async createCommitment(fields) {
      const id = fields.id || uid('c');
      return mutate({
        colls: ['commitments'],
        send: () => rest('POST', 'commitments', { prefer: RETURN, body: Object.assign({
          id, member_id: fields.memberId, meeting_id: fields.meetingId, text: fields.text,
          status: fields.status || 'not_started', last_update_note: fields.lastUpdateNote || '', goal_id: fields.goalId || null }) }),
        result: () => findIn('commitments', id)
      });
    },

    getGoals: () => get('goals'),
    async saveGoal(goal) {
      await get('goals');
      const existing = goal.id && findIn('goals', goal.id);
      if (existing) {
        return mutate({
          colls: ['goals'],
          send: () => rest('PATCH', `goals?id=eq.${enc(goal.id)}`, { body: pickMap(goal, GOAL_FIELDS), prefer: RETURN }),
          result: () => findIn('goals', goal.id)
        });
      }
      const id = uid('g');
      return mutate({
        colls: ['goals'],
        send: () => rest('POST', 'goals', { prefer: RETURN,
          body: Object.assign({ id, member_id: goal.memberId, status: 'active', accountability_ask: '' }, pickMap(goal, GOAL_FIELDS)) }),
        result: () => findIn('goals', id)
      });
    },

    getCheckins: () => get('checkins'),
    async saveCheckin({ meetingId, memberId, win, challenge }) {
      await get('checkins');
      return mutate({
        colls: ['checkins'], optimistic: true,
        apply: () => {
          let k = cache.checkins.find((x) => x.meetingId === meetingId && x.memberId === memberId);
          if (k) Object.assign(k, { win, challenge, editedAt: nowISO() });
          else { k = { id: uid('k'), meetingId, memberId, win, challenge, submittedAt: nowISO() }; cache.checkins.push(k); }
          return k;
        },
        send: () => rest('POST', 'checkins?on_conflict=meeting_id,member_id',
          { body: { meeting_id: meetingId, member_id: memberId, win, challenge }, prefer: UPSERT }),
        result: () => cache.checkins.find((x) => x.meetingId === meetingId && x.memberId === memberId)
      });
    },

    getAsks: () => get('asks'),
    async createAsk({ memberId, title, detail, needs }) {
      const id = uid('a');
      return mutate({
        colls: ['asks'],
        send: () => rest('POST', 'asks', { prefer: RETURN, body: { id, title, detail: detail || '', needs: needs || null } }),
        result: () => findIn('asks', id)
      });
    },
    async replyToAsk(id, { memberId, text, canHelp }) {
      await get('asks');
      return mutate({
        colls: ['asks'], optimistic: true,
        apply: () => { const a = findIn('asks', id, 'Ask'); a.replies.push({ memberId, text, canHelp: !!canHelp, createdAt: nowISO() }); return a; },
        send: () => rest('POST', 'ask_replies', { body: { id: uid('r'), ask_id: id, text, can_help: !!canHelp } }),
        result: () => findIn('asks', id)
      });
    },
    async updateAsk(id, patch) {
      await get('asks');
      return mutate({
        colls: ['asks'], optimistic: true,
        apply: () => { const a = findIn('asks', id, 'Ask'); Object.assign(a, patch); return a; },
        send: () => rest('PATCH', `asks?id=eq.${enc(id)}`, { body: pickMap(patch, ASK_FIELDS) }),
        result: () => findIn('asks', id)
      });
    },
    setAskNeeds(id, needs) { return api.updateAsk(id, { needs: needs || null }); },

    getAnnouncements: () => get('announcements'),
    async createAnnouncement({ authorId, title, body, pinned, important }) {
      const id = uid('an');
      return mutate({
        colls: ['announcements'],
        send: () => rest('POST', 'announcements', { prefer: RETURN,
          body: { id, title, body, pinned: !!pinned, important: !!important } }),
        result: () => findIn('announcements', id)
      });
    },
    async updateAnnouncement(id, patch) {
      await get('announcements');
      const body = pickMap(patch, { title: 'title', body: 'body', pinned: 'pinned', important: 'important' });
      return mutate({
        colls: ['announcements'], optimistic: true,
        apply: () => { const a = findIn('announcements', id, 'Announcement'); ['title', 'body', 'pinned', 'important'].forEach((k) => { if (k in patch) a[k] = patch[k]; }); return a; },
        send: () => rest('PATCH', `announcements?id=eq.${enc(id)}`, { body }),
        result: () => findIn('announcements', id)
      });
    },
    commentOnAnnouncement(id, { memberId, text }) { return addComment('announcements', 'announcement_comments', 'announcement_id', id, memberId, text); },

    getIdeas: () => get('ideas'),
    async createIdea({ memberId, type, title, note, url }) {
      const id = uid('i');
      return mutate({
        colls: ['ideas'],
        send: () => rest('POST', 'ideas', { prefer: RETURN, body: { id, type, title, note: note || '', url: url || '' } }),
        result: () => findIn('ideas', id)
      });
    },
    async toggleIdeaLike(id, memberId) {
      await get('ideas');
      const liked = (findIn('ideas', id, 'Idea').likes || []).includes(memberId);
      return mutate({
        colls: ['ideas'], optimistic: true,
        apply: () => { const i = findIn('ideas', id); i.likes = liked ? i.likes.filter((x) => x !== memberId) : i.likes.concat(memberId); return i; },
        send: () => (liked
          ? rest('DELETE', `idea_likes?idea_id=eq.${enc(id)}&member_id=eq.${enc(memberId)}`)
          : rest('POST', 'idea_likes', { body: { idea_id: id }, prefer: 'resolution=ignore-duplicates' })),
        result: () => findIn('ideas', id)
      });
    },
    commentOnIdea(id, { memberId, text }) { return addComment('ideas', 'idea_comments', 'idea_id', id, memberId, text); },

    getBooks: () => get('books'),
    async createBook({ title, author, suggestedBy, why }) {
      const id = uid('b');
      return mutate({
        colls: ['books'],
        send: () => rest('POST', 'books', { prefer: RETURN, body: { id, title, author: author || '', why: why || '' } }),
        result: () => findIn('books', id)
      });
    },
    async setGroupBook(bookId) {
      return mutate({ colls: ['books'], send: () => rpc('set_group_book', { p_book_id: bookId || null }), result: () => cache.books });
    },
    commentOnBook(id, { memberId, text }) { return addComment('books', 'book_comments', 'book_id', id, memberId, text); },
    getReadingList: () => get('readingList'),
    // status want|reading|finished, or null to take the book off your list.
    async setReadingStatus(bookId, memberId, status) {
      await get('readingList');
      const row = status ? { bookId, memberId, status, updatedAt: nowISO() } : null;
      return mutate({
        colls: ['readingList'], optimistic: true,
        apply: () => {
          const list = cache.readingList;
          const i = list.findIndex((r) => r.bookId === bookId && r.memberId === memberId);
          if (!status) { if (i >= 0) list.splice(i, 1); return null; }
          if (i >= 0) Object.assign(list[i], row); else list.push(row);
          return row;
        },
        send: () => (status
          ? rest('POST', 'reading_list?on_conflict=book_id,member_id', { body: { book_id: bookId, member_id: memberId, status }, prefer: UPSERT })
          : rest('DELETE', `reading_list?book_id=eq.${enc(bookId)}&member_id=eq.${enc(memberId)}`)),
        result: () => (status ? cache.readingList.find((r) => r.bookId === bookId && r.memberId === memberId) || row : null)
      });
    },

    /* Get-togethers: the server only returns open ones plus closed ones you host,
       are invited to, or (admins) all. */
    getGetTogethers: () => get('gettogethers'),
    async saveGetTogether(ev) {
      const id = ev.id || uid('gt');
      const p = { id, title: ev.title, kind: ev.kind, datetime: ev.datetime, location: ev.location, note: ev.note,
        visibility: ev.visibility, invitees: ev.visibility === 'closed' ? (ev.invitees || []) : [] };
      return mutate({
        colls: ['gettogethers'],
        send: () => rpc('save_get_together', { p }),
        result: (savedId) => findIn('gettogethers', savedId || id)
      });
    },
    async rsvpGetTogether(id, memberId, status) {
      await get('gettogethers');
      return mutate({
        colls: ['gettogethers'], optimistic: true,
        apply: () => { const e = findIn('gettogethers', id, 'Get-together'); setRsvp(e.rsvps, memberId, status); return e; },
        send: () => rest('POST', 'get_together_rsvps?on_conflict=get_together_id,member_id',
          { body: { get_together_id: id, member_id: memberId, status }, prefer: UPSERT }),
        result: () => findIn('gettogethers', id)
      });
    },
    async cancelGetTogether(id) {
      return mutate({
        colls: ['gettogethers'],
        send: () => rest('PATCH', `get_togethers?id=eq.${enc(id)}`, { body: { cancelled: true } }),
        result: () => findIn('gettogethers', id)
      });
    },

    /* Meeting notes: one manual note (admins write it) and one Zoom AI Companion note per meeting.
       Shape: { id, meetingId, source: 'manual'|'zoom', title, summary, keyPoints: [string],
                nextSteps: [{ text, memberId|null }], createdBy, createdAt, updatedAt, editedBy, editedAt,
                zoom?: { topic, startAt } }.  meetingId is null for a Zoom note that matched no meeting (admins only). */
    async getNotes(meetingId) { return (await get('notes')).filter((n) => n.meetingId === meetingId); },
    // Every note the caller can see, each with `text` (title, summary, points and steps) for search.
    async listNotesIndex() { return (await get('notes')).map((n) => Object.assign(n, { text: noteText(n) })); },
    // New manual note: { meetingId, title, summary, keyPoints, nextSteps }. Edit: { id, ...fields to change }.
    // A Zoom note keeps its title (the server refuses a change); meetingId files an unattached one.
    async saveNotes(note) {
      const body = {};
      if ('title' in note) body.title = note.title || '';
      if ('summary' in note) body.summary = note.summary || '';
      if ('keyPoints' in note) body.key_points = (note.keyPoints || []).filter(Boolean);
      if ('nextSteps' in note) body.next_steps = (note.nextSteps || []).filter((x) => x && x.text)
        .map((x) => (x.memberId ? { text: x.text, memberId: x.memberId } : { text: x.text }));
      if ('meetingId' in note && note.id) body.meeting_id = note.meetingId;
      const id = note.id || uid('nt');
      return mutate({
        colls: ['notes'],
        send: () => (note.id ? rest('PATCH', `meeting_notes?id=eq.${enc(id)}`, { body, prefer: RETURN })
          : rest('POST', 'meeting_notes', { body: Object.assign({ id, meeting_id: note.meetingId }, body), prefer: RETURN })),
        result: () => findIn('notes', id)
      });
    },
    async deleteNotes(id) {
      return mutate({ colls: ['notes'], send: () => rest('DELETE', `meeting_notes?id=eq.${enc(id)}`), result: () => true });
    },

    /* Group's usual meeting place: the admin's override, or null for the config default. */
    async getGroupLocation() {
      if (!session.token()) return null;
      const s = (await get('settings'))[0];
      return (s && s.location_override) || null;
    },
    async setGroupLocation(loc) {
      return mutate({ colls: ['settings'], send: () => rpc('set_group_location', { p_location: loc || null }), result: () => loc || null });
    },

    // The prototype's "Reset demo data". With a real backend it only clears this
    // device's cached copy; it never deletes anything on the server.
    async resetDemo() { clearCache(); return true; },

    /* ==================== Supabase-only extras ==================== */

    /* Login, step 1: check the invite code and get the roster for "Who are you?". */
    async verifyInvite(code) {
      const res = await callFn('join', { action: 'roster', group: GROUP, inviteCode: code });
      const roster = (res.members || []).map((m) => ({ id: m.id, name: m.name, role: m.role, bio: '', focus: '', canHelpWith: [], workingGenius: null }));
      store.set('roster', roster);
      store.set('pendingInvite', code);
      store.set('verified', true);       // app.js's gate key
      return roster;
    },
    /* Login, step 2: pick your name -> a 6-digit code goes to your email or phone.
       Resolves to one of (see supabase/functions/join/index.ts):
         { sent: true, channel, maskedTo, resendAfter, expiresIn, options, smsAvailable, devCode?, enroll? }
         { sent: false, active: true, ... }   a code from a moment ago is still good
         { choose: true, options }            email and text both possible: call again with a channel
         { enroll: true, smsAvailable }       no email or phone on file (first sign-in): call again
                                              with selfContact { email, phone? } (phone in E.164)
       selfContact is accepted only while the member has nothing on file; it's saved when
       the code is verified. Pass it again on resend / switch channel.
       Rejects with an ApiError whose .code says why (contact_exists, bad_email, bad_phone,
       no_channel, resend_wait, too_many_codes, send_failed with .detail, bad_invite). */
    async requestCode(memberId, channel, selfContact) {
      const code = store.get('pendingInvite', null);
      if (!code) throw new ApiError('Enter the invite code first.', 400, 'bad_invite');
      return callFn('join', Object.assign({ action: 'request-code', group: GROUP, inviteCode: code, memberId },
        channel ? { channel } : {},
        selfContact ? { selfContact: { email: selfContact.email || '', phone: selfContact.phone || '' } } : {}));
    },
    /* Login, step 3: the code from the email or text. Stores the session and the app's 'user' key.
       Resolves to the member; .enrolled is true when this first sign-in saved their email/phone. */
    async verifyCode(memberId, code, deviceLabel) {
      const invite = store.get('pendingInvite', null);
      if (!invite) throw new ApiError('Enter the invite code first.', 400, 'bad_invite');
      const res = await callFn('join', { action: 'verify-code', group: GROUP, inviteCode: invite, memberId,
        code: String(code || '').replace(/\D/g, ''), deviceLabel: deviceLabel || defaultDeviceLabel() });
      const member = startSession(res);
      if (res.enrolled) member.enrolled = true;
      return member;
    },
    async signOut() {
      try { await rpc('sign_out'); } catch (e) { /* already gone */ }
      handleSignedOut();
      return true;
    },
    // { memberId, groupId, name, role, realtimeKey, rulesVersion, rulesAcceptedAt } or null.
    async getSession() {
      if (!session.token()) return null;
      const info = await rpc('get_session_info');
      if (!info) handleSignedOut();
      return info;
    },
    isSignedIn: () => !!session.token(),

    /* Ground rules: stored on the server per member and rules version. */
    async acceptRules(version) { return rpc('accept_rules', { p_version: version || 1 }); },

    /* Trainings (Flight Club). Admins edit; everyone RSVPs. */
    getTrainings: () => get('trainings'),
    async saveTraining(t) {
      const isNew = !t.id;
      const id = t.id || uid('tr');
      const body = pickMap(t, TRAINING_FIELDS);
      return mutate({
        colls: ['trainings'],
        send: () => (isNew ? rest('POST', 'trainings', { body: Object.assign({ id }, body), prefer: RETURN })
          : rest('PATCH', `trainings?id=eq.${enc(id)}`, { body, prefer: RETURN })),
        result: () => findIn('trainings', id)
      });
    },
    async rsvpTraining(id, memberId, status) {
      await get('trainings');
      return mutate({
        colls: ['trainings'], optimistic: true,
        apply: () => { const t = findIn('trainings', id, 'Training'); setRsvp(t.rsvps, memberId, status); return t; },
        send: () => rest('POST', 'training_rsvps?on_conflict=training_id,member_id',
          { body: { training_id: id, member_id: memberId, status }, prefer: UPSERT }),
        result: () => findIn('trainings', id)
      });
    },

    /* Attendance (admin): replace the list for a meeting. */
    async setAttendance(meetingId, memberIds) {
      return mutate({
        colls: ['meetings'],
        send: async () => {
          await rest('DELETE', `meeting_attendance?meeting_id=eq.${enc(meetingId)}`);
          if (memberIds.length) await rest('POST', 'meeting_attendance', { body: memberIds.map((m) => ({ meeting_id: meetingId, member_id: m })) });
        },
        result: () => findIn('meetings', meetingId)
      });
    },

    /* Reminders: your toggles, contact details and this device's push subscription. */
    // { sms, email, nudges } for you (defaults if the row is missing).
    async getNotificationPrefs() {
      const rows = await rest('GET', `notification_prefs?select=sms,email,nudges&member_id=eq.${enc(myId())}`);
      return rows[0] || { sms: true, email: true, nudges: true };
    },
    async setNotificationPrefs(p) {
      const rows = await rest('PATCH', `notification_prefs?member_id=eq.${enc(myId())}`,
        { body: pickMap(p, { sms: 'sms', email: 'email', nudges: 'nudges' }), prefer: RETURN });
      // Every member gets a prefs row from a trigger; no row back means the update didn't apply.
      if (!rows || !rows[0]) throw new ApiError("Couldn't save your reminder settings.", 404);
      return { sms: rows[0].sms, email: rows[0].email, nudges: rows[0].nudges };
    },
    updateNotificationPrefs(p) { return api.setNotificationPrefs(p); },
    async getMyContact() {
      const rows = await rest('GET', `member_contacts?select=email,phone&member_id=eq.${enc(myId())}`);
      return rows[0] || { email: null, phone: null };
    },
    // phone in E.164 (+15125550123). Pass memberId to edit someone else's (admins).
    // Sends both fields: a missing one is saved as empty.
    async saveContact({ email, phone, memberId }) {
      const rows = await rest('POST', 'member_contacts?on_conflict=member_id', { prefer: UPSERT,
        body: { member_id: memberId || myId(), email: email || null, phone: phone || null } });
      const r = (rows && rows[0]) || {};
      return { memberId: r.member_id || memberId || myId(), email: r.email || null, phone: r.phone || null };
    },
    updateMyContact({ email, phone }) { return api.saveContact({ email, phone }); },
    // Admins: everyone's contact rows in the group. Members get only their own (RLS).
    // [{ memberId, email, phone }]; members with no row are simply missing.
    async getContacts() {
      const rows = await rest('GET', 'member_contacts?select=member_id,email,phone');
      return (rows || []).map((r) => ({ memberId: r.member_id, email: r.email || null, phone: r.phone || null }));
    },
    adminSaveContact(memberId, { email, phone }) { return api.saveContact({ memberId, email, phone }); },
    // Your own profile fields (bio, focus, canHelpWith, workingGenius).
    updateMyProfile(patch) { return api.updateMember(myId(), patch); },
    // Needs a service worker with a 'push' handler (see supabase/README.md) and VAPID public key in config.
    async enablePush() {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new ApiError('This browser does not support notifications. On iPhone, add the app to your Home Screen first.', 0);
      if (!SB.vapidPublicKey) throw new ApiError('Push is not configured yet (vapidPublicKey).', 0);
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw new ApiError('Notifications are turned off for this app.', 0);
      const reg = await navigator.serviceWorker.ready;
      const key = Uint8Array.from(atob(SB.vapidPublicKey.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - SB.vapidPublicKey.length % 4) % 4)), (c) => c.charCodeAt(0));
      const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      const j = sub.toJSON();
      await rest('POST', 'push_subscriptions?on_conflict=endpoint', { prefer: 'resolution=ignore-duplicates',
        body: { endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, user_agent: navigator.userAgent.slice(0, 300) } });
      return true;
    },
    async disablePush() {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (!sub) return true;
      await rest('DELETE', `push_subscriptions?endpoint=eq.${enc(sub.endpoint)}`).catch(() => {});
      await sub.unsubscribe();
      return true;
    },

    /* Admin: roster and invite code. */
    rotateInviteCode: (code, revokeSessions) => rpc('admin_rotate_invite_code', { p_code: code || null, p_revoke_sessions: !!revokeSessions }),
    async addMember({ name, role, email, phone }) {
      return mutate({ colls: ['members'], send: () => rpc('admin_add_member', { p_name: name, p_role: role || 'member', p_email: email || null, p_phone: phone || null }),
        result: (m) => findIn('members', m && m.id) });
    },
    async removeMember(id) { return mutate({ colls: ['members', 'meetings'], send: () => rpc('admin_remove_member', { p_member_id: id }), result: () => true }); },
    async restoreMember(id) { return mutate({ colls: ['members'], send: () => rpc('admin_restore_member', { p_member_id: id }), result: () => findIn('members', id) }); },
    // p: { name?, role?, sortOrder?, email?, phone? }
    async adminUpdateMember(id, p) { return mutate({ colls: ['members'], send: () => rpc('admin_update_member', { p_member_id: id, p }), result: () => findIn('members', id) }); },
    // Clears the member's email and phone and signs them out everywhere: their next
    // sign-in adds an email again ("First time here?"). Not for yourself.
    async adminResetSignin(id) { return mutate({ colls: ['members'], send: () => rpc('admin_reset_member_signin', { p_member_id: id }), result: () => findIn('members', id) }); },

    /* Live updates. cb(collections) runs after other members' changes are in the cache.
       Also fired as window event 'mastermind:remote-change'. Returns an unsubscribe function. */
    subscribe(cb) { listeners.add(cb); realtime.ensure(); return () => listeners.delete(cb); },
    on(name, cb) { const h = (e) => cb(e.detail); window.addEventListener(`mastermind:${name}`, h); return () => window.removeEventListener(`mastermind:${name}`, h); },
    get realtimeConnected() { return realtime.connected; }
  };

  // Search text for a note (same in app.js's demo layer).
  function noteText(n) {
    return [n.title, n.summary].concat(n.keyPoints || [], (n.nextSteps || []).map((x) => x.text)).join('\n');
  }

  // Comments share one shape everywhere: { memberId, text, createdAt }.
  async function addComment(coll, table, fk, id, memberId, text) {
    await get(coll);
    return mutate({
      colls: [coll], optimistic: true,
      apply: () => { const it = findIn(coll, id, 'Item'); it.comments = it.comments || []; it.comments.push({ memberId, text, createdAt: nowISO() }); return it; },
      send: () => rest('POST', table, { body: { id: uid('cm'), [fk]: id, text } }),
      result: () => findIn(coll, id)
    });
  }

  // ?backend=local (or no project configured) keeps the prototype's demo data in app.js.
  const forceLocal = new URLSearchParams(location.search).get('backend') === 'local';
  if (!forceLocal && SB.url && SB.anonKey) window.MASTERMIND_API = api;
})();
