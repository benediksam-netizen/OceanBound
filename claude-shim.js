// Keeps players' progress when the game moves to a new web address (see MOVE_TO in server.js).
(function () {
  try {
    const LS = window.localStorage;
    const sync = (method, url, body) => { const x = new XMLHttpRequest(); x.open(method, url, false); if (body) x.setRequestHeader("content-type", "application/json"); x.send(body || null); return x; };
    const m = location.search.match(/[?&]transfer=([a-f0-9]{32})/);
    if (m) {
      // Arrived at the new address: copy the old save in, without overwriting anything already here.
      const x = sync("GET", "/api/transfer/" + m[1]);
      if (x.status === 200) { const d = JSON.parse(x.responseText); for (const k in d) if (LS.getItem(k) === null) LS.setItem(k, d[k]); }
      history.replaceState(null, "", location.pathname + location.hash);
      return;
    }
    const mv = sync("GET", "/api/move");
    const to = mv.status === 200 ? JSON.parse(mv.responseText).to : null;
    if (!to) return;
    // On the old address: hand this player's data to the new one, then go there.
    const data = {}; let n = 0;
    for (let i = 0; i < LS.length; i++) { const k = LS.key(i); data[k] = LS.getItem(k); n++; }
    let q = "";
    if (n) { const x = sync("POST", "/api/transfer", JSON.stringify(data)); if (x.status !== 200) return; q = "?transfer=" + JSON.parse(x.responseText).token; }
    document.documentElement.style.visibility = "hidden";
    location.replace(location.protocol + "//" + to + (location.port ? ":" + location.port : "") + "/" + q + location.hash);
    throw new Error("moving"); // stop the rest of this page from starting
  } catch (e) { if (e && e.message === "moving") throw e; }
})();

// Connects the game to this website's own multiplayer server.
// It provides the same room / db / user features the game uses on claude.ai,
// so everyone who opens the site joins automatically — no accounts or invites.
(function () {
  "use strict";
  const LS = (() => { try { return window.localStorage; } catch (e) { return null; } })();
  const getTok = () => {
    let t = null; try { t = LS && LS.getItem("oceanboundToken"); } catch (e) {}
    if (!t || !/^[A-Za-z0-9_-]{16,80}$/.test(t)) {
      const a = new Uint8Array(24); crypto.getRandomValues(a);
      t = btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      try { LS && LS.setItem("oceanboundToken", t); } catch (e) {}
    }
    return t;
  };
  const TOKEN = getTok();
  const WS_URL = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws";

  let ws = null, connected = false, myPeer = null, myUid = null, myPresence = {}, backoff = 500;
  const others = new Map(); // peer -> {peer, by, presence, updatedAt}
  const peerSubs = new Set(), connSubs = new Set(), topicSubs = new Map(), uidWaiters = [];
  const pending = new Map(); let reqId = 1; const queue = [];
  let snapshot = Object.freeze([]), first = true;

  const freezePeer = p => Object.freeze({
    peer: p.peer, by: p.by, isMe: p.by === myUid, sameTab: p.peer === myPeer, kind: "viewer", guest: false,
    presence: Object.freeze(p.presence || {}), updatedAt: p.updatedAt
  });
  function rebuild(joined, left, updated) {
    const list = [];
    if (myPeer) list.push(freezePeer({ peer: myPeer, by: myUid, presence: myPresence, updatedAt: Date.now() }));
    for (const p of others.values()) list.push(freezePeer(p));
    snapshot = Object.freeze(list);
    const find = id => snapshot.find(x => x.peer === id);
    const ch = { peers: snapshot, joined: first ? snapshot : joined.map(find).filter(Boolean), left, updated: updated.map(find).filter(Boolean) };
    first = false;
    for (const f of peerSubs) { try { f(ch); } catch (e) { console.error(e); } }
  }
  function setConn(c) { if (c === connected) return; connected = c; for (const f of connSubs) { try { f(c); } catch (e) {} } }
  function sendRaw(o) { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(o)); return true; } return false; }

  function connect() {
    try { ws = new WebSocket(WS_URL); } catch (e) { setTimeout(connect, backoff); return; }
    ws.onopen = () => { backoff = 500; ws.send(JSON.stringify({ t: "hello", token: TOKEN, presence: myPresence })); };
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      const now = Date.now();
      if (m.t === "welcome") {
        myPeer = m.peer; myUid = m.uid; others.clear(); first = true;
        for (const p of m.peers) if (p.peer !== myPeer) others.set(p.peer, { ...p, updatedAt: now });
        setConn(true); rebuild([], [], []);
        while (uidWaiters.length) uidWaiters.shift()(myUid);
        while (queue.length) sendRaw(queue.shift());
      } else if (m.t === "join" || m.t === "update") {
        const was = others.has(m.peer); others.set(m.peer, { peer: m.peer, by: m.by, presence: m.presence, updatedAt: now });
        rebuild(was ? [] : [m.peer], [], was ? [m.peer] : []);
      } else if (m.t === "leave") {
        const p = others.get(m.peer); if (!p) return; others.delete(m.peer);
        rebuild([], [freezePeer(p)], []);
      } else if (m.t === "msg") {
        const subs = topicSubs.get(m.topic); if (!subs) return;
        const msg = Object.freeze({ topic: m.topic, data: m.data, peer: m.peer, by: m.by, isMe: m.by === myUid, sameTab: false, kind: "viewer", guest: false });
        for (const f of subs) { try { f(msg); } catch (e) { console.error(e); } }
      } else if (m.t === "dbr") {
        const r = pending.get(m.id); if (!r) return; pending.delete(m.id); clearTimeout(r.timer);
        m.ok ? r.resolve(m.result) : r.reject({ code: m.code || "upstream_error", message: m.code || "error" });
      }
    };
    ws.onclose = () => { setConn(false); ws = null; setTimeout(connect, backoff); backoff = Math.min(8000, backoff * 2); };
    ws.onerror = () => {};
  }
  connect();
  setInterval(() => sendRaw({ t: "ping" }), 20000);

  /* ---------- room ---------- */
  const room = Object.freeze({
    presence(patch) {
      if (!patch || typeof patch !== "object") return Promise.reject({ code: "invalid_argument" });
      const next = { ...myPresence };
      for (const k in patch) { if (patch[k] === null) delete next[k]; else next[k] = patch[k]; }
      if (new TextEncoder().encode(JSON.stringify(next)).length > 4096) return Promise.reject({ code: "invalid_argument", message: "presence over 4 KiB" });
      myPresence = next; sendRaw({ t: "presence", presence: myPresence });
      return Promise.resolve();
    },
    peers() { return snapshot; },
    onPeers(fn) { peerSubs.add(fn); if (myPeer) setTimeout(() => { if (peerSubs.has(fn)) fn({ peers: snapshot, joined: snapshot, left: [], updated: [] }); }, 0); return () => peerSubs.delete(fn); },
    emit(topic, data) {
      if (!/^[a-z][a-z0-9_.-]{0,47}$/.test(topic)) return Promise.reject({ code: "invalid_argument" });
      if (!connected) return Promise.resolve();
      sendRaw({ t: "emit", topic, data });
      const subs = topicSubs.get(topic);
      if (subs) { const msg = Object.freeze({ topic, data, peer: myPeer, by: myUid, isMe: true, sameTab: true, kind: "viewer", guest: false }); for (const f of subs) { try { f(msg); } catch (e) {} } }
      return Promise.resolve();
    },
    on(topic, fn) { if (!topicSubs.has(topic)) topicSubs.set(topic, new Set()); topicSubs.get(topic).add(fn); return () => topicSubs.get(topic).delete(fn); },
    connected() { return connected; },
    onConnection(fn) { connSubs.add(fn); setTimeout(() => { if (connSubs.has(fn)) fn(connected); }, 0); return () => connSubs.delete(fn); },
    canSendToClaudeSession() { return Promise.resolve("off"); },
    sendToClaudeSession() { return Promise.reject({ code: "claude_unavailable" }); }
  });

  /* ---------- saved database ---------- */
  function call(o) {
    return new Promise((resolve, reject) => {
      const id = reqId++, msg = { t: "db", id, ...o };
      const timer = setTimeout(() => { pending.delete(id); reject({ code: "upstream_error", message: "timeout" }); }, 12000);
      pending.set(id, { resolve, reject, timer });
      if (!sendRaw(msg)) queue.push(msg);
    });
  }
  const snapDoc = (id, exists, data) => Object.freeze({ id, exists, data: () => (exists ? JSON.parse(JSON.stringify(data)) : undefined), metadata: {} });
  function docRef(path) {
    const id = path.split("/").pop();
    return {
      id, path,
      get: () => call({ op: "get", path }).then(r => snapDoc(id, r.exists, r.data)),
      set: d => call({ op: "set", path, data: d }).then(() => undefined),
      update: d => call({ op: "update", path, data: d }).then(() => undefined),
      delete: () => call({ op: "delete", path }).then(() => undefined),
      onSnapshot(next, err) {
        let live = true, last = "";
        const tick = () => { if (!live) return; docRef(path).get().then(s => { const k = JSON.stringify([s.exists, s.data()]); if (k !== last) { last = k; next(s); } }, e => err && err(e)).finally(() => live && setTimeout(tick, 5000)); };
        tick(); return () => { live = false; };
      },
      collection: sub => collRef(path + "/" + sub)
    };
  }
  function query(path, q) {
    const self = {
      where: (f, op, v) => query(path, { ...q, where: [...(q.where || []), [f, op, v]] }),
      orderBy: (f, dir) => query(path, { ...q, orderBy: [f, dir || "asc"] }),
      limit: n => query(path, { ...q, limit: n }),
      get: () => call({ op: "query", path, query: q }).then(r => {
        const docs = r.docs.map(d => snapDoc(d.id, true, d.data));
        return { docs, size: docs.length, empty: !docs.length, docChanges: () => docs.map(doc => ({ type: "added", doc })), metadata: {} };
      }),
      onSnapshot(next, err) {
        let live = true, last = "";
        const tick = () => { if (!live) return; self.get().then(s => { const k = JSON.stringify(s.docs.map(d => [d.id, d.data()])); if (k !== last) { last = k; next(s); } }, e => err && err(e)).finally(() => live && setTimeout(tick, 5000)); };
        tick(); return () => { live = false; };
      }
    };
    return self;
  }
  function collRef(path) { const q = query(path, {}); return { ...q, id: path.split("/").pop(), path, doc: id => docRef(path + "/" + (id || Math.random().toString(36).slice(2, 12))), add: d => { const r = docRef(path + "/" + Math.random().toString(36).slice(2, 12)); return r.set(d).then(() => r); } }; }
  const db = Object.freeze({ doc: docRef, collection: collRef });

  /* ---------- player identity ---------- */
  const waitUid = () => myUid ? Promise.resolve(myUid) : new Promise(res => { uidWaiters.push(res); setTimeout(() => res(myUid), 8000); });
  const user = Object.freeze({
    id: waitUid,
    isOwner: () => Promise.resolve(false), canEdit: () => Promise.resolve(false), can: () => Promise.resolve(true),
    me: () => waitUid().then(id => ({ id, name: "", avatarUrl: "", color: "#4FA3E0", email: null, isOwner: false, canEdit: false })),
    profiles: ids => Promise.resolve(Object.fromEntries((ids || []).map(i => [i, { id: i, name: "", guest: false }]))),
    name: () => Promise.resolve(""), avatarUrl: () => Promise.resolve(null), search: () => Promise.resolve([]), email: () => Promise.resolve(null)
  });

  const NS = { room, db, user };
  window.claude = Object.freeze({ use: name => Promise.resolve(NS[name] || null) });
})();
