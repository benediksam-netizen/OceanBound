// Oceanbound — multiplayer web server
// Serves the game and runs live multiplayer (positions, chat, emotes, catches) plus a small
// saved database (reserved for later features) for everyone who opens the site.
// Run:  npm install && npm start      (PORT env var sets the port, default 3000)

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, "public", "index.html")) ? path.join(__dirname, "public") : __dirname;
const SERVE_OK = new Set(["index.html", "claude-shim.js", "og-image.jpg", "icon.png"]);
// The public address, used in the sitemap so search engines can find the game.
const SITE_URL = (process.env.SITE_URL || "http://localhost:3000").replace(/\/$/, "");
const _readFile = fs.readFile; fs.readFile = (f, cb) => (PUBLIC_DIR !== __dirname || SERVE_OK.has(path.basename(f))) ? _readFile(f, cb) : cb(new Error("not served"));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "db.json");
const MAX_MSG = 8192;          // bytes per incoming message
const MAX_PRESENCE = 4096;     // bytes per player's live state
const MAX_DOC = 16384;         // bytes per saved document
const MAX_DOCS = 20000;        // total saved documents
const RATE = 80;               // messages per second per connection

/* ---------------- saved database ---------------- */
fs.mkdirSync(DATA_DIR, { recursive: true });
let DB = {};
try { DB = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch (e) { DB = {}; }
let saveTimer = null;
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = DATA_FILE + ".tmp";
    fs.writeFile(tmp, JSON.stringify(DB), err => { if (!err) fs.rename(tmp, DATA_FILE, () => {}); });
  }, 500);
}
const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
function validPath(p, even) {
  if (typeof p !== "string" || p.length > 1000) return false;
  const s = p.split("/");
  if (!s.every(x => SEG.test(x) && x !== "." && x !== "..")) return false;
  return even ? s.length % 2 === 0 : s.length % 2 === 1;
}
// Who may write where: each player writes only their own profile and score.
function canWrite(p, uid) {
  const s = p.split("/");
  if (s.length !== 2) return false;
  return (s[0] === "profiles" || s[0] === "scores") && s[1] === uid;
}
function cmp(a, op, b) {
  switch (op) {
    case "==": return a === b; case "!=": return a !== b;
    case "<": return a < b; case "<=": return a <= b; case ">": return a > b; case ">=": return a >= b;
    case "in": return Array.isArray(b) && b.includes(a);
    case "not-in": return Array.isArray(b) && !b.includes(a);
    case "array-contains": return Array.isArray(a) && a.includes(b);
    default: return false;
  }
}
function runQuery(col, q) {
  const depth = col.split("/").length + 1;
  let rows = Object.keys(DB).filter(k => k.startsWith(col + "/") && k.split("/").length === depth)
    .map(k => ({ id: k.split("/").pop(), data: DB[k] }));
  for (const [f, op, v] of (q && q.where) || []) rows = rows.filter(r => r.data[f] !== undefined && cmp(r.data[f], op, v));
  if (q && q.orderBy) {
    const [f, dir] = q.orderBy, m = dir === "desc" ? -1 : 1;
    rows.sort((a, b) => {
      const x = a.data[f], y = b.data[f];
      if (x === undefined && y === undefined) return 0; if (x === undefined) return 1; if (y === undefined) return -1;
      return x < y ? -m : x > y ? m : 0;
    });
  } else rows.sort((a, b) => (a.id < b.id ? -1 : 1));
  const lim = Math.max(1, Math.min(1000, (q && q.limit) || 1000));
  return rows.slice(0, lim);
}
function dbOp(msg, uid) {
  const { op, path: p } = msg;
  if (op === "get") { if (!validPath(p, true)) throw "invalid_argument"; return { exists: p in DB, data: DB[p] ?? null }; }
  if (op === "query") { if (!validPath(p, false)) throw "invalid_argument"; return { docs: runQuery(p, msg.query || {}) }; }
  if (op === "set" || op === "update") {
    if (!validPath(p, true) || !canWrite(p, uid)) throw "invalid_argument";
    const d = msg.data;
    if (!d || typeof d !== "object" || Array.isArray(d)) throw "invalid_argument";
    const next = op === "update" ? (p in DB ? { ...DB[p], ...d } : null) : d;
    if (!next) throw "invalid_argument";
    if (Buffer.byteLength(JSON.stringify(next)) > MAX_DOC) throw "invalid_argument";
    if (!(p in DB) && Object.keys(DB).length >= MAX_DOCS) throw "quota_exceeded";
    DB[p] = next; saveSoon(); return {};
  }
  if (op === "delete") { if (!validPath(p, true) || !canWrite(p, uid)) throw "invalid_argument"; delete DB[p]; saveSoon(); return {}; }
  throw "invalid_argument";
}

/* ---------------- web server ---------------- */
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".json": "application/json" };
const server = http.createServer((req, res) => {
  let u = decodeURIComponent((req.url || "/").split("?")[0]);
  if (u === "/health") { res.writeHead(200, { "content-type": "text/plain" }); res.end("ok"); return; }
  // for search engines: allow everything, and point to the sitemap
  if (u === "/robots.txt") { res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }); res.end(`User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`); return; }
  if (u === "/sitemap.xml") { res.writeHead(200, { "content-type": "application/xml; charset=utf-8" });
    res.end(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${SITE_URL}/</loc><lastmod>${new Date().toISOString().slice(0, 10)}</lastmod><changefreq>weekly</changefreq><priority>1.0</priority></url>\n</urlset>\n`); return; }
  if (u === "/favicon.ico") u = "/icon.png";
  if (u === "/" || u === "") u = "/index.html";
  const f = path.normalize(path.join(PUBLIC_DIR, u));
  if (!f.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(f, (err, buf) => {
    if (err) { res.writeHead(404, { "content-type": "text/plain" }); res.end("Not found"); return; }
    res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream", "cache-control": u === "/index.html" ? "no-cache" : "public, max-age=3600" });
    res.end(buf);
  });
});

/* ---------------- live multiplayer ---------------- */
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: MAX_MSG });
const peers = new Map(); // peer id -> { ws, uid, presence, updatedAt }
const newPeerId = () => crypto.randomBytes(8).toString("hex");
const uidFor = token => "u_" + crypto.createHash("sha256").update("oceanbound|" + token).digest("base64url").slice(0, 22);
function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcast(obj, except) { const s = JSON.stringify(obj); for (const [id, p] of peers) if (id !== except && p.ws.readyState === 1) p.ws.send(s); }
const peerInfo = (id, p) => ({ peer: id, by: p.uid, presence: p.presence, updatedAt: p.updatedAt });

wss.on("connection", ws => {
  let me = null, count = 0, windowStart = Date.now();
  ws.on("message", raw => {
    const now = Date.now();
    if (now - windowStart > 1000) { windowStart = now; count = 0; }
    if (++count > RATE) return;
    let msg; try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg !== "object") return;

    if (msg.t === "hello") {
      if (me) return;
      const token = typeof msg.token === "string" && /^[A-Za-z0-9_-]{16,80}$/.test(msg.token) ? msg.token : crypto.randomBytes(24).toString("base64url");
      const id = newPeerId(), uid = uidFor(token);
      me = id;
      const presence = msg.presence && typeof msg.presence === "object" ? msg.presence : {};
      peers.set(id, { ws, uid, presence: Buffer.byteLength(JSON.stringify(presence)) <= MAX_PRESENCE ? presence : {}, updatedAt: now });
      send(ws, { t: "welcome", peer: id, uid, peers: [...peers].map(([pid, p]) => peerInfo(pid, p)) });
      broadcast({ t: "join", ...peerInfo(id, peers.get(id)) }, id);
      return;
    }
    if (!me) return;
    const p = peers.get(me);

    if (msg.t === "presence" && msg.presence && typeof msg.presence === "object" && !Array.isArray(msg.presence)) {
      if (Buffer.byteLength(JSON.stringify(msg.presence)) > MAX_PRESENCE) return;
      p.presence = msg.presence; p.updatedAt = now;
      broadcast({ t: "update", ...peerInfo(me, p) }, me);
      return;
    }
    if (msg.t === "emit" && typeof msg.topic === "string" && /^[a-z][a-z0-9_.-]{0,47}$/.test(msg.topic)) {
      broadcast({ t: "msg", topic: msg.topic, data: msg.data, peer: me, by: p.uid }, me);
      return;
    }
    if (msg.t === "db" && typeof msg.id === "number") {
      try { send(ws, { t: "dbr", id: msg.id, ok: true, result: dbOp(msg, p.uid) }); }
      catch (e) { send(ws, { t: "dbr", id: msg.id, ok: false, code: typeof e === "string" ? e : "upstream_error" }); }
      return;
    }
    if (msg.t === "ping") send(ws, { t: "pong" });
  });
  ws.on("close", () => { if (me && peers.delete(me)) broadcast({ t: "leave", peer: me }); });
  ws.on("error", () => {});
});

// Drop connections that stopped answering.
setInterval(() => { for (const [id, p] of peers) if (p.ws.readyState > 1) { peers.delete(id); broadcast({ t: "leave", peer: id }); } }, 10000);

server.listen(PORT, () => console.log(`Oceanbound is running on http://localhost:${PORT}`));
