//LICENSE
//
//Copyright (C) 2026  sterling motuz <Sterling@dexabyte.ca>
//
//for https://github.com/printer-buddy/printer-buddy
//
//SPDX-License-Identifier: AGPL-3.0-only
//
//Additional term (AGPL-3.0 section 7b, keep author credit): keep this header
//
//Additional term (AGPL-3.0 section 7c, mark changed versions): if you make any changes, you must include a CHANGELOG with all changes and their dates
import NEWS from "./news.json";

const SHARE = /^\/share\/user\/(\d{6,10})\/(printer\/\d{1,9}\/[A-Za-z0-9_-]{20,100}(?:\/(?:status|snapshot|stream|chat|flag))?)\/?$/;

const page = (title, text, status) => new Response(
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${title}</title>
<style>body{margin:0;background:#0B0B0D;color:#F4F2F8;font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;display:grid;place-items:center;min-height:100vh;text-align:center;padding:16px}
h1{margin:0 0 8px;font-size:26px}p{margin:0;color:#8E8A99}b{color:#FF8A1F}</style></head>
<body><div><p>Printer <b>Buddy</b></p><h1>${title}</h1><p>${text}</p></div></body></html>`,
  { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });

function newsApi() {
  const items = (Array.isArray(NEWS) ? NEWS : []).filter(n => n && n.id && n.title).slice(0, 50);
  return new Response(JSON.stringify({ items }), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=600", "access-control-allow-origin": "*" },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/tunnel") return tunnelApi(request, env, url);
    if (url.pathname === "/api/box") return boxApi(request, env);
    if (url.pathname === "/api/register") return registerApi(request, env);
    if (["/api/app", "/api/app/ids", "/api/app/off", "/api/app/on"].includes(url.pathname)) return appApi(request, env, url);
    if (url.pathname === "/api/contribute") return contributeApi(request, env);
    if (url.pathname === "/api/ai-stats") return statsApi(env);
    if (url.pathname === "/api/news") return newsApi();
    const m = url.pathname.match(SHARE);
    if (!m) {
      if (url.pathname === "/") return page("Printer Buddy", "Self-hosted 3D printer monitoring. Open a share link to watch a printer.", 200);
      return page("Link not found", "Check that you copied the whole link.", 404);
    }
    const chatPost = request.method === "POST" && (m[2].endsWith("/chat") || m[2].endsWith("/flag"));
    if (request.method !== "GET" && request.method !== "HEAD" && !chatPost) return new Response("Method not allowed", { status: 405 });
    let chatBody;
    if (chatPost) {
      chatBody = await request.text();
      if (chatBody.length > 4000) return new Response("Message too big", { status: 413 });
    }

    const domain = (env.SHARE_DOMAIN || url.hostname).replace(/^www\./, "");
    const target = `https://u${m[1]}.${domain}/share/${m[2]}${url.search}`;

    const headers = new Headers();
    if (chatPost) headers.set("content-type", "application/json");
    for (const h of ["accept", "accept-language", "user-agent", "range"]) {
      const v = request.headers.get(h);
      if (v) headers.set(h, v);
    }

    let res;
    try {
      res = await fetch(target, { method: request.method, headers, body: chatPost ? chatBody : undefined, redirect: "manual" });
    } catch {
      return offline(m[2]);
    }
    // 502/503/530 = the box or its tunnel is down (Cloudflare error 1033 comes back as 530)
    if ([502, 503, 504, 530].includes(res.status)) return offline(m[2]);

    const out = new Response(res.body, res);
    out.headers.delete("set-cookie");
    out.headers.set("cache-control", "no-store");
    out.headers.set("x-robots-tag", "noindex");
    out.headers.set("referrer-policy", "no-referrer");
    return out;
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(event.cron === "0 13 * * *" ? Promise.all([dailySummary(env), env.JOBS ? queueJob(env, "cleanup-ids", {}) : null])
                                              : cleanupTunnels(env, new URL("https://" + (env.SHARE_DOMAIN || "printerbuddy.stream"))));
  },

  async queue(batch, env) {
    for (const m of batch.messages) {
      try {
        await runJob(env, m.body);
        m.ack();
      } catch (e) {
        console.log(`job ${m.body && m.body.type} failed: ${e.message}`);
        m.retry();
      }
    }
  },
};

function offline(path) {
  if (/\/(status|snapshot|stream)$/.test(path)) {
    return new Response(JSON.stringify({ error: "This printer is offline right now. Try again later." }),
      { status: 503, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  }
  return page("Printer is offline", "This printer's box isn't reachable right now. Try again in a little while.", 503);
}

// A box gets its ID at install:  POST /api/box  {}  -> {"id": "1234567", "key": "..."}   (5 new IDs per network per day)
//   A box from before this sends its own ID (and its tunnel key if it has a tunnel) to keep that ID: {"id", "key"}.
// A box asks for its tunnel:   POST   /api/tunnel  {"id": "1234567", "port": 8080, "key": "<box key>"}
//   -> creates tunnel "pb-u<id>" routing https://u<id>.<domain>/share/... to http://localhost:<port>,
//      plus the DNS record, and returns {"token", "hostname"}. Asking again reuses the same tunnel and
//      updates the port if it changed, or re-creates it if it was removed while held.
// A box removes its tunnel:    DELETE /api/tunnel  {"id": "...", "key": "...", "hold": true|false}
//   hold: true keeps its address for that box while it's not sharing; false gives it up (Remote access off).
// Only the box holding the key can change, delete or get back its tunnel.
// One box sharing at a time per network, 5 for boxes on the allow list (/api/register).

const json = (data, status = 200) => new Response(JSON.stringify(data),
  { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function newKey() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, "0")).join("");
}

async function cf(env, method, path, body) {
  const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) {
    const err = new Error((j.errors || []).map(e => `${e.code}: ${e.message}`).join("; ") || `Cloudflare HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return j.result;
}

function routing(env, id, host, port) {
  return cf(env, "PUT", `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${id}/configurations`, {
    config: { ingress: [
      { hostname: host, path: "^/share/", service: `http://localhost:${port}`, originRequest: {} },
      { service: "http_status:404" },
    ] },
  });
}

async function dnsRecord(env, host) {
  const list = await cf(env, "GET", `/zones/${env.CF_ZONE_ID}/dns_records?type=CNAME&name=${encodeURIComponent(host)}`);
  return (list || [])[0] || null;
}

async function pointDns(env, host, tunnelId) {
  const rec = { type: "CNAME", name: host, content: `${tunnelId}.cfargotunnel.com`, proxied: true };
  const old = await dnsRecord(env, host);
  if (old) return cf(env, "PUT", `/zones/${env.CF_ZONE_ID}/dns_records/${old.id}`, rec);
  return cf(env, "POST", `/zones/${env.CF_ZONE_ID}/dns_records`, rec);
}

// IPv4 counts per address, IPv6 per /64 (one home gets a whole /64)
function networkOf(ip) {
  if (!ip.includes(":")) return ip;
  const [head, tail = ""] = ip.split("::");
  const h = head ? head.split(":") : [], t = tail ? tail.split(":") : [];
  const full = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return full.slice(0, 4).map(x => (parseInt(x, 16) || 0).toString(16)).join(":") + "::/64";
}

// Box IDs, tunnels, the allow list and apps live in D1. Every change to them is a job on the JOBS queue, which runs one
// job at a time (max_concurrency = 1), so two changes can never overlap. A request waits for its job's answer in results.
const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS ids (id TEXT PRIMARY KEY, key_hash TEXT, created INTEGER, used INTEGER DEFAULT 0, app TEXT)",
  "CREATE TABLE IF NOT EXISTS boxes (id TEXT PRIMARY KEY, tunnel_id TEXT, token TEXT, key_hash TEXT, port INTEGER, net TEXT, cut INTEGER DEFAULT 0, created INTEGER, updated INTEGER)",
  "CREATE TABLE IF NOT EXISTS held (id TEXT PRIMARY KEY, key_hash TEXT, net TEXT, held INTEGER)",
  "CREATE TABLE IF NOT EXISTS allowed (id TEXT PRIMARY KEY)",
  "CREATE TABLE IF NOT EXISTS apps (name TEXT PRIMARY KEY, key_hash TEXT, created INTEGER, ids INTEGER DEFAULT 0, off INTEGER DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS box_days (net TEXT, day TEXT, n INTEGER, PRIMARY KEY (net, day))",
  "CREATE TABLE IF NOT EXISTS results (job TEXT PRIMARY KEY, status INTEGER, body TEXT, created INTEGER)",
  "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)",
  "CREATE INDEX IF NOT EXISTS ids_key ON ids (key_hash)",
];
let schemaReady = false;

const sql = (env, query, ...args) => env.DB.prepare(query).bind(...args);

// true once the records from KV have been copied into D1
async function ready(env) {
  if (!schemaReady) {
    await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s)));
    schemaReady = true;
  }
  return (await sql(env, "SELECT v FROM meta WHERE k = 'migrated'").first("v")) === "1";
}

const NOT_HANDED_OUT = "This Printer Buddy ID wasn't handed out by the relay. Update Printer Buddy to get a box ID.";
const OTHER_BOX = "This Printer Buddy ID is already set up on another box (or this box lost its key). " +
                  "Remove PB_USER_ID, PB_BOX_KEY and PB_TUNNEL_KEY from printer-buddy.env to get a new ID.";
const APP_OFF = "The app this box ID came from has been turned off by Printer Buddy.";

// ids = an ID the relay handed out, with its key. Boxes set up before that are known by their tunnel record.
const OWNER = `SELECT w.r, w.key_hash, w.app, COALESCE((SELECT off FROM apps WHERE name = w.app), 0) AS off FROM (
  SELECT 1 AS r, key_hash, app FROM ids WHERE id = ?1
  UNION ALL SELECT 2, key_hash, NULL FROM boxes WHERE id = ?1
  UNION ALL SELECT 3, key_hash, NULL FROM held WHERE id = ?1) AS w ORDER BY w.r LIMIT 1`;
const owner = (env, id) => sql(env, OWNER, id).first();

function randomIds(count) {
  const pick = new Set();
  while (pick.size < count) {
    const r = new Uint32Array(1);
    crypto.getRandomValues(r);
    pick.add(String(1000000 + r[0] % 9000000));
  }
  return [...pick];
}

async function freeOf(env, candidates, n) {
  const taken = await sql(env, "SELECT value FROM json_each(?1) WHERE value IN (SELECT id FROM ids UNION SELECT id FROM boxes UNION SELECT id FROM held)",
                          JSON.stringify(candidates)).all();
  const no = new Set(taken.results.map(r => r.value));
  return candidates.filter(c => !no.has(c)).slice(0, n);
}

const freeIds = (env, n) => freeOf(env, randomIds(n + 10), n);

// An app's key comes from REGISTER_SECRET and each of its box keys from the app's key, so asking again gets the same keys.
async function hmac(secret, text) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function getTunnel(env, tunnelId) {
  try {
    const t = await cf(env, "GET", `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${tunnelId}`);
    return t && !t.deleted_at ? t : null;
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

// A tunnel already deleted (an earlier try) goes straight to the DNS step. e.step says which step failed.
async function removeTunnel(env, host, tunnelId) {
  let t;
  try { t = await getTunnel(env, tunnelId); } catch (e) { e.step = "read"; throw e; }
  if (t) {
    try { await cf(env, "DELETE", `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${tunnelId}`); } catch (e) { e.step = "delete"; throw e; }
  }
  try {
    const rec = await tunnelDns(env, host, tunnelId);
    if (rec) await cf(env, "DELETE", `/zones/${env.CF_ZONE_ID}/dns_records/${rec.id}`);
  } catch (e) {
    e.step = "dns";
    throw e;
  }
}

// the address only if it still points to this tunnel, so an old job can't take away a newer tunnel's address
async function tunnelDns(env, host, tunnelId) {
  const rec = await dnsRecord(env, host);
  return rec && rec.content === `${tunnelId}.cfargotunnel.com` ? rec : null;
}

// never connected within an hour, or offline for 4 days
function stale(t, now) {
  const HOUR = 3600 * 1000;
  return {
    neverConnected: t.status === "inactive" && now - Date.parse(t.created_at) > HOUR,
    offline: t.status === "down" && !!t.conns_inactive_at && now - Date.parse(t.conns_inactive_at) > 4 * 24 * HOUR,
  };
}

async function cutTunnel(env, host, tunnelId) {
  try {
    await removeTunnel(env, host, tunnelId);
    return true;
  } catch {
    await cf(env, "PUT", `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${tunnelId}/configurations`, { config: { ingress: [{ service: "http_status:404" }] } });
    const rec = await tunnelDns(env, host, tunnelId);
    if (rec) await cf(env, "DELETE", `/zones/${env.CF_ZONE_ID}/dns_records/${rec.id}`);
    return false;
  }
}

// A tunnel left from an earlier try whose record was never saved is used again instead of making a second one.
async function makeTunnel(env, id, host, port) {
  const name = `pb-u${id}`;
  const list = await cf(env, "GET", `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel?name=${name}&is_deleted=false`);
  const left = (list || []).find(x => x.name === name && !x.deleted_at);
  const t = left ? { id: left.id, token: await cf(env, "GET", `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${left.id}/token`) }
                 : await cf(env, "POST", `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel`, { name, config_src: "cloudflare" });
  try {
    await routing(env, t.id, host, port);
    await pointDns(env, host, t.id);
  } catch (e) {
    await removeTunnel(env, host, t.id).catch(() => {});
    throw e;
  }
  return t;
}

const queueJob = (env, type, data) => env.JOBS.send({ job: crypto.randomUUID(), type, data });

async function sendJobs(env, jobs) {
  for (let i = 0; i < jobs.length; i += 100) {
    await env.JOBS.sendBatch(jobs.slice(i, i + 100).map(j => ({ body: { job: crypto.randomUUID(), ...j } })));
  }
}

// D1 allows 50 queries per request on Workers Free, so this checks for the answer at most 40 times (20 s).
async function viaQueue(env, type, data) {
  const job = crypto.randomUUID();
  await env.JOBS.send({ job, type, data });
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 500));
    const r = await sql(env, "SELECT status, body FROM results WHERE job = ?", job).first();
    if (r) return [r.status, JSON.parse(r.body)];
  }
  return [503, { error: "The Printer Buddy server is busy. Try again in a minute." }];
}

async function tunnelApi(request, env, url) {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID || !env.CF_ZONE_ID || !env.DB || !env.JOBS) {
    return json({ error: "Automatic setup isn't configured on this server yet." }, 503);
  }
  if (request.method !== "POST" && request.method !== "DELETE") return json({ error: "Method not allowed" }, 405);
  let b;
  try { b = await request.json(); } catch { return json({ error: "Bad request" }, 400); }
  const id = String(b.id || "");
  if (!/^\d{6,10}$/.test(id)) return json({ error: "Bad Printer Buddy ID" }, 400);
  const domain = (env.SHARE_DOMAIN || url.hostname).replace(/^www\./, "");
  const host = `u${id}.${domain}`;
  const keyHash = typeof b.key === "string" ? await sha256(b.key) : null;

  if (await ready(env)) {
    const own = await owner(env, id);
    if (!own) return json({ error: NOT_HANDED_OUT }, 403);
    if (!keyHash || keyHash !== own.key_hash) return json({ error: OTHER_BOX }, 403);
    if (request.method === "POST" && own.off) return json({ error: APP_OFF }, 403);
  }
  if (request.method === "DELETE") return answer(await viaQueue(env, "untunnel", { id, key_hash: keyHash, hold: b.hold === true, host }));

  const port = Number(b.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return json({ error: "Bad port" }, 400);
  const net = networkOf(request.headers.get("cf-connecting-ip") || "unknown");
  return answer(await viaQueue(env, "tunnel", { id, port, key_hash: keyHash, net, host }));
}

const answer = ([status, body]) => json(body, status);

async function boxApi(request, env) {
  if (!env.DB || !env.JOBS) return json({ error: "Box IDs aren't set up on this server yet." }, 503);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let b;
  try { b = await request.json(); } catch { b = {}; }
  const net = networkOf(request.headers.get("cf-connecting-ip") || "unknown");
  const data = { net, day: new Date().toISOString().slice(0, 10) };
  if (b && b.id !== undefined) {
    data.id = String(b.id);
    if (!/^\d{6,10}$/.test(data.id)) return json({ error: "Bad Printer Buddy ID" }, 400);
    if (typeof b.key === "string") data.given_hash = await sha256(b.key);
  } else if (b && b.key !== undefined) {
    // a new box sends its own key, so asking again (after "busy") gets the same ID
    if (typeof b.key !== "string" || !/^[0-9a-f]{64}$/.test(b.key)) return json({ error: "Bad box key" }, 400);
    data.own_hash = await sha256(b.key);
  }
  if (await ready(env)) {
    const pre = await sql(env, "SELECT COALESCE((SELECT n FROM box_days WHERE net = ?1 AND day = ?2), 0) AS today, EXISTS(SELECT 1 FROM ids WHERE id = ?3) AS taken, " +
                               "(SELECT id FROM ids WHERE key_hash = ?4) AS mine", net, data.day, data.id ?? null, data.own_hash ?? null).first();
    if (pre.mine) return json({ id: pre.mine, key: b.key }, 201);
    if (pre.today >= Number(env.BOXES_PER_NETWORK_PER_DAY || 5)) return json({ error: "Too many new box IDs from this network today. Try again tomorrow." }, 429);
    if (data.id && pre.taken) return json({ error: "This Printer Buddy ID already belongs to a box." }, 409);
  }
  const key = newKey();
  data.new_hash = await sha256(key);
  const [status, body] = await viaQueue(env, "box", data);
  if (status !== 201) return json(body, status);
  return json({ id: body.id, key: body.key === "given" ? b.key : key }, 201);
}

// The Discord bot puts a box on the allow list:  POST /api/register  {"id": "1234567"}  (authorization: Bearer <REGISTER_SECRET>)
async function registerApi(request, env) {
  if (!env.REGISTER_SECRET || !env.DB || !env.JOBS) return json({ error: "Registering isn't set up on this server yet." }, 503);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (request.headers.get("authorization") !== `Bearer ${env.REGISTER_SECRET}`) return json({ error: "Not allowed" }, 403);
  let b;
  try { b = await request.json(); } catch { return json({ error: "Bad request" }, 400); }
  const id = String(b.id || "");
  if (!/^\d{6,10}$/.test(id)) return json({ error: "Bad Printer Buddy ID" }, 400);
  if (await ready(env) && !(await owner(env, id))) return json({ error: "No box has that ID." }, 404);
  return answer(await viaQueue(env, "register", { id }));
}

// Other programs that use the relay register as an app, and every box ID they get remembers the app:
//   POST /api/app               {"name"}  (Bearer REGISTER_SECRET) -> {"name", "key"}  asking again gets the same key
//   POST /api/app/ids           {"name", "key"}                     -> {"ids": [{"id", "key"}, ...]}  its 50 box IDs, the same ones every time
//   POST /api/app/off | /on     {"name"}  (Bearer REGISTER_SECRET)  every box ID from that app is refused / allowed again
async function appApi(request, env, url) {
  const path = url.pathname;
  if (!env.REGISTER_SECRET || !env.DB || !env.JOBS) return json({ error: "Apps aren't set up on this server yet." }, 503);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let b;
  try { b = await request.json(); } catch { return json({ error: "Bad request" }, 400); }
  const name = String(b.name || "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,39}$/.test(name)) return json({ error: "App name: 2 to 40 letters, numbers, - or _" }, 400);
  const checked = await ready(env);
  const app = checked ? await sql(env, "SELECT key_hash, ids, off FROM apps WHERE name = ?", name).first() : null;

  if (path === "/api/app/ids") {
    const keyHash = typeof b.key === "string" ? await sha256(b.key) : null;
    if (!keyHash || (checked && (!app || keyHash !== app.key_hash))) return json({ error: "App name and key don't match." }, 403);
    if (checked && app.off) return json({ error: "This app has been turned off by Printer Buddy." }, 403);
    const keyOf = id => hmac(b.key, id);
    let status, ids;
    if (checked && app.ids) {
      status = 200;
      const rows = (await sql(env, "SELECT id, key_hash FROM ids WHERE app = ? ORDER BY id", name).all()).results;
      const match = await Promise.all(rows.map(async r => r.key_hash === await sha256(await keyOf(r.id))));
      ids = rows.filter((r, i) => match[i]).map(r => r.id);
    } else {
      const offer = await Promise.all(randomIds(Number(env.APP_IDS || 50) + 10).map(async id => ({ id, hash: await sha256(await keyOf(id)) })));
      let body;
      [status, body] = await viaQueue(env, "app-ids", { name, key_hash: keyHash, n: Number(env.APP_IDS || 50), offer });
      if (status !== 201 && status !== 200) return json(body, status);
      ids = body.ids;
    }
    return json({ ids: await Promise.all(ids.map(async id => ({ id, key: await keyOf(id) }))) }, status);
  }

  if (request.headers.get("authorization") !== `Bearer ${env.REGISTER_SECRET}`) return json({ error: "Not allowed" }, 403);
  if (path === "/api/app") {
    const key = await hmac(env.REGISTER_SECRET, `app:${name}`);
    if (app) return app.key_hash === await sha256(key) ? json({ name, key }, 200) : json({ error: "That app is already registered." }, 409);
    const [status, body] = await viaQueue(env, "app", { name, key_hash: await sha256(key) });
    return status === 201 ? json({ name, key }, 201) : json(body, status);
  }
  if (checked && !app) return json({ error: "No app has that name." }, 404);
  const domain = (env.SHARE_DOMAIN || url.hostname).replace(/^www\./, "");
  return answer(await viaQueue(env, path === "/api/app/on" ? "app-on" : "app-off", { name, domain }));
}

// Hourly: remove tunnels that never connected within an hour (freed), and tunnels offline for 4 days
// (ID held for the box), and leftover pb-u tunnels with no record. Each removal is its own job.
async function cleanupTunnels(env, url) {
  if (!env.DB || !env.JOBS) return;
  if (!(await ready(env))) return queueJob(env, "migrate", {});
  const jobs = [{ type: "tidy", data: {} }];
  if (env.CF_API_TOKEN && env.CF_ACCOUNT_ID && env.CF_ZONE_ID) {
    const domain = (env.SHARE_DOMAIN || url.hostname).replace(/^www\./, "");
    const now = Date.now(), HOUR = 3600 * 1000;
    const tunnels = new Map();
    for (let page = 1; ; page++) {
      const list = await cf(env, "GET", `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel?is_deleted=false&per_page=1000&page=${page}`);
      for (const t of list || []) if (/^pb-u\d{6,10}$/.test(t.name)) tunnels.set(t.name, t);
      if (!list || list.length < 1000) break;
    }
    const { results: boxes } = await sql(env, "SELECT id, tunnel_id, created FROM boxes").all();
    for (const box of boxes) {
      const t = tunnels.get(`pb-u${box.id}`);
      tunnels.delete(`pb-u${box.id}`);
      const { neverConnected, offline } = t ? stale(t, now) : {};
      const young = !t && now - (box.created || 0) < HOUR;
      if (!young && (!t || neverConnected || offline)) {
        jobs.push({ type: "remove-box", data: { id: box.id, tunnel_id: box.tunnel_id, cf_id: t ? t.id : null, host: `u${box.id}.${domain}` } });
      }
    }
    for (const [name, t] of tunnels) {
      if (now - Date.parse(t.created_at) < HOUR) continue;
      jobs.push({ type: "remove-tunnel", data: { id: name.slice(4), cf_id: t.id, host: `${name.slice(3)}.${domain}` } });
    }
    const { results: cuts } = await sql(env, "SELECT boxes.id, boxes.tunnel_id FROM boxes JOIN ids ON ids.id = boxes.id JOIN apps ON apps.name = ids.app WHERE apps.off = 1 AND boxes.cut != 1").all();
    for (const b of cuts) jobs.push({ type: "cut-box", data: { id: b.id, tunnel_id: b.tunnel_id, host: `u${b.id}.${domain}` } });
  }
  await sendJobs(env, jobs);
}

// Copies the KV records into D1, 300 keys per job, and keeps its place in meta.
const MIGRATE = ["app:", "appoff:", "id:", "box:", "held:", "allowed:"];

async function migrateStep(env) {
  const at = JSON.parse((await sql(env, "SELECT v FROM meta WHERE k = 'migrate'").first("v")) || '{"p":0}');
  const prefix = MIGRATE[at.p];
  const page = await env.BOXES.list({ prefix, cursor: at.c, limit: 300 });
  const writes = [];
  for (const { name } of page.keys) {
    const k = name.slice(prefix.length);
    if (prefix === "appoff:") { writes.push(sql(env, "UPDATE apps SET off = 1 WHERE name = ?", k)); continue; }
    if (prefix === "allowed:") { writes.push(sql(env, "INSERT OR IGNORE INTO allowed (id) VALUES (?)", k)); continue; }
    const v = await env.BOXES.get(name, "json");
    if (!v) continue;
    if (prefix === "app:") {
      writes.push(sql(env, "INSERT OR IGNORE INTO apps (name, key_hash, created, ids, off) VALUES (?, ?, ?, ?, 0)", k, v.key_hash ?? null, v.created ?? 0, v.ids ?? 0));
    } else if (prefix === "id:") {
      writes.push(sql(env, "INSERT OR IGNORE INTO ids (id, key_hash, created, used, app) VALUES (?, ?, ?, ?, ?)", k, v.key_hash ?? null, v.created ?? 0, v.used ? 1 : 0, v.app ?? null));
    } else if (prefix === "box:") {
      writes.push(sql(env, "INSERT OR IGNORE INTO boxes (id, tunnel_id, token, key_hash, port, net, cut, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                      k, v.tunnel_id ?? null, v.token ?? null, v.key_hash ?? null, v.port ?? null, v.net ?? null, v.cut ? 2 : 0, v.created ?? 0, v.updated ?? 0));
    } else {
      writes.push(sql(env, "INSERT OR IGNORE INTO held (id, key_hash, net, held) VALUES (?, ?, ?, ?)", k, v.key_hash ?? null, v.net ?? null, v.held ?? 0));
    }
  }
  const next = page.list_complete ? { p: at.p + 1 } : { p: at.p, c: page.cursor };
  const done = next.p >= MIGRATE.length;
  writes.push(sql(env, "INSERT OR REPLACE INTO meta (k, v) VALUES ('migrate', ?)", JSON.stringify(next)));
  if (done) writes.push(sql(env, "INSERT OR REPLACE INTO meta (k, v) VALUES ('migrated', '1')"));
  await env.DB.batch(writes);
  return done;
}

async function runJob(env, job) {
  if (!(await ready(env)) && !(await migrateStep(env))) {
    await env.JOBS.send(job);
    return;
  }
  if (job.type === "migrate") return;
  if (await sql(env, "SELECT 1 FROM results WHERE job = ?", job.job).first()) return;
  const [status, body, writes = []] = await JOBS[job.type](env, job.data);
  await env.DB.batch([...writes, sql(env, "INSERT INTO results (job, status, body, created) VALUES (?, ?, ?, ?)", job.job, status, JSON.stringify(body), Date.now())]);
}

// Each job returns [status, body, writes]; the writes are saved together with its answer.
function keyRefused(own, box, held, keyHash) {
  if (!own) return [403, { error: NOT_HANDED_OUT }];
  if (!keyHash || (box && keyHash !== box.key_hash) || (held && keyHash !== held.key_hash) || keyHash !== own.key_hash) return [403, { error: OTHER_BOX }];
  return null;
}

const JOBS = {
  async tunnel(env, { id, port, key_hash: keyHash, net, host }) {
    const box = await sql(env, "SELECT * FROM boxes WHERE id = ?", id).first();
    const held = box ? null : await sql(env, "SELECT * FROM held WHERE id = ?", id).first();
    const own = await owner(env, id);
    const refused = keyRefused(own, box, held, keyHash);
    if (refused) return refused;
    if (own.off) return [403, { error: APP_OFF }];
    try {
      if (box) {
        if (box.port !== port || box.cut) {
          await routing(env, box.tunnel_id, host, port);
          if (box.cut) await pointDns(env, host, box.tunnel_id);
        }
        return [200, { token: box.token, hostname: host }, [sql(env, "UPDATE boxes SET port = ?, cut = 0, updated = ? WHERE id = ?", port, Date.now(), id)]];
      }
      const n = await sql(env, "SELECT COUNT(*) AS total, COALESCE(SUM(net = ?1), 0) AS here, EXISTS(SELECT 1 FROM allowed WHERE id = ?2) AS allowed FROM boxes", net, id).first();
      if (n.total >= Number(env.MAX_TUNNELS || 500)) return [503, { error: "Wireless sharing is full right now. Please tell the Printer Buddy team." }];
      const limit = n.allowed ? Number(env.REGISTERED_PER_NETWORK || 5) : 1;
      if (n.here >= limit) {
        return [429, { error: n.allowed ? `This network already has ${limit} boxes sharing.`
                                        : "This network already has a box sharing. Register this box with /register <box ID> in the Printer Buddy Discord to share up to 5 on one network." }];
      }
      const t = await makeTunnel(env, id, host, port);
      const now = Date.now();
      const writes = [
        sql(env, "INSERT INTO boxes (id, tunnel_id, token, key_hash, port, net, cut, created, updated) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)", id, t.id, t.token, own.key_hash, port, net, now, now),
        sql(env, "UPDATE ids SET used = 1 WHERE id = ?", id),
      ];
      if (held) writes.push(sql(env, "DELETE FROM held WHERE id = ?", id));
      if (env.DISCORD_WEBHOOK && !held) {
        await fetch(env.DISCORD_WEBHOOK, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: `Box ${id} set up wireless sharing!` }),
        }).catch(() => {});
      }
      return [held ? 200 : 201, { token: t.token, hostname: host }, writes];
    } catch (e) {
      return [502, { error: `Cloudflare said: ${e.message}` }];
    }
  },

  async untunnel(env, { id, key_hash: keyHash, hold, host }) {
    const box = await sql(env, "SELECT * FROM boxes WHERE id = ?", id).first();
    const held = box ? null : await sql(env, "SELECT * FROM held WHERE id = ?", id).first();
    const refused = keyRefused(await owner(env, id), box, held, keyHash);
    if (refused) return refused;
    if (!box) return [200, { ok: true, note: "nothing to remove" }, held && !hold ? [sql(env, "DELETE FROM held WHERE id = ?", id)] : []];
    try {
      await removeTunnel(env, host, box.tunnel_id);
    } catch (e) {
      if (e.step === "dns") return [502, { error: `The tunnel was removed, but its address couldn't be. Try again in a minute. (${e.message})` }];
      if (e.step === "delete") return [409, { error: `The tunnel is still connected. Stop cloudflared on the box and try again in a minute. (${e.message})` }];
      return [502, { error: `Cloudflare said: ${e.message}` }];
    }
    const writes = [sql(env, "DELETE FROM boxes WHERE id = ?", id)];
    if (hold) writes.push(sql(env, "INSERT OR REPLACE INTO held (id, key_hash, net, held) VALUES (?, ?, ?, ?)", id, box.key_hash, box.net, Date.now()));
    return [200, { ok: true }, writes];
  },

  async box(env, { id: given, given_hash: givenHash, new_hash: newHash, own_hash: ownHash, net, day }) {
    if (ownHash) {
      const mine = await sql(env, "SELECT id FROM ids WHERE key_hash = ?", ownHash).first("id");
      if (mine) return [201, { id: mine, key: "given" }];
    }
    const today = (await sql(env, "SELECT n FROM box_days WHERE net = ? AND day = ?", net, day).first("n")) || 0;
    if (today >= Number(env.BOXES_PER_NETWORK_PER_DAY || 5)) return [429, { error: "Too many new box IDs from this network today. Try again tomorrow." }];
    let id = given, hash = ownHash || newHash, used = 0, key = ownHash ? "given" : "new";
    if (given !== undefined) {
      if (await sql(env, "SELECT 1 FROM ids WHERE id = ?", given).first()) return [409, { error: "This Printer Buddy ID already belongs to a box." }];
      const old = await owner(env, given);
      if (old && (!givenHash || givenHash !== old.key_hash)) return [403, { error: "This Printer Buddy ID is already set up on another box (or this box lost its key)." }];
      if (old) [hash, used, key] = [givenHash, 1, "given"];
    } else {
      [id] = await freeIds(env, 1);
      if (!id) return [503, { error: "Couldn't pick a free box ID, try again." }];
    }
    return [201, { id, key }, [
      sql(env, "INSERT INTO ids (id, key_hash, created, used) VALUES (?, ?, ?, ?)", id, hash, Date.now(), used),
      sql(env, "INSERT INTO box_days (net, day, n) VALUES (?, ?, 1) ON CONFLICT (net, day) DO UPDATE SET n = n + 1", net, day),
    ]];
  },

  async register(env, { id }) {
    if (!(await owner(env, id))) return [404, { error: "No box has that ID." }];
    return [200, { ok: true, id }, [sql(env, "INSERT OR IGNORE INTO allowed (id) VALUES (?)", id), sql(env, "UPDATE ids SET used = 1 WHERE id = ?", id)]];
  },

  async app(env, { name, key_hash: keyHash }) {
    const app = await sql(env, "SELECT key_hash FROM apps WHERE name = ?", name).first();
    if (app) return app.key_hash === keyHash ? [201, { name }] : [409, { error: "That app is already registered." }];
    return [201, { name }, [sql(env, "INSERT INTO apps (name, key_hash, created, ids, off) VALUES (?, ?, ?, 0, 0)", name, keyHash, Date.now())]];
  },

  async "app-ids"(env, { name, key_hash: keyHash, n, offer }) {
    const app = await sql(env, "SELECT key_hash, ids, off FROM apps WHERE name = ?", name).first();
    if (!app || keyHash !== app.key_hash) return [403, { error: "App name and key don't match." }];
    if (app.off) return [403, { error: "This app has been turned off by Printer Buddy." }];
    if (app.ids) return [200, { ids: (await sql(env, "SELECT id FROM ids WHERE app = ? ORDER BY id", name).all()).results.map(r => r.id) }];
    const hashOf = new Map(offer.map(o => [o.id, o.hash]));
    const ids = await freeOf(env, offer.map(o => o.id), n), created = Date.now();
    const writes = ids.map(id => sql(env, "INSERT INTO ids (id, key_hash, created, used, app) VALUES (?, ?, ?, 0, ?)", id, hashOf.get(id), created, name));
    writes.push(sql(env, "UPDATE apps SET ids = ? WHERE name = ?", ids.length, name));
    return [201, { ids }, writes];
  },

  async "app-on"(env, { name }) {
    if (!(await sql(env, "SELECT 1 FROM apps WHERE name = ?", name).first())) return [404, { error: "No app has that name." }];
    return [200, { ok: true, name, off: false }, [sql(env, "UPDATE apps SET off = 0 WHERE name = ?", name)]];
  },

  // Turning an app off sends one cut-box job per box, so each box gets its own run and its own 50 outside calls.
  async "app-off"(env, { name, domain }) {
    if (!(await sql(env, "SELECT 1 FROM apps WHERE name = ?", name).first())) return [404, { error: "No app has that name." }];
    await sql(env, "UPDATE apps SET off = 1 WHERE name = ?", name).run();
    let boxes = [];
    if (env.CF_API_TOKEN && env.CF_ACCOUNT_ID && env.CF_ZONE_ID) {
      ({ results: boxes } = await sql(env, "SELECT boxes.id, boxes.tunnel_id FROM boxes JOIN ids ON ids.id = boxes.id WHERE ids.app = ?", name).all());
      await sendJobs(env, boxes.map(b => ({ type: "cut-box", data: { id: b.id, tunnel_id: b.tunnel_id, host: `u${b.id}.${domain}` } })));
    }
    return [200, { ok: true, name, off: true, boxes: boxes.length }];
  },

  // A tunnel that's still connected can't be deleted: it's cut (no routing, no address). cut = 2 while cutting, 1 once done;
  // the hourly cleanup sends the job again for a box of a turned-off app that isn't done.
  async "cut-box"(env, { id, tunnel_id: tunnelId, host }) {
    const box = await sql(env, "SELECT tunnel_id FROM boxes WHERE id = ?", id).first();
    const own = await owner(env, id);
    if (!box || box.tunnel_id !== tunnelId || !own || !own.off) return [200, { ok: true, note: "nothing to cut" }];
    await sql(env, "UPDATE boxes SET cut = 2 WHERE id = ?", id).run();
    const deleted = await cutTunnel(env, host, tunnelId);
    return [200, { ok: true, deleted }, [deleted ? sql(env, "DELETE FROM boxes WHERE id = ?", id) : sql(env, "UPDATE boxes SET cut = 1 WHERE id = ?", id)]];
  },

  // The tunnel is read again first: a box that connected since the hourly check is left alone.
  async "remove-box"(env, { id, tunnel_id: tunnelId, cf_id: cfId, host }) {
    const box = await sql(env, "SELECT key_hash, net, tunnel_id FROM boxes WHERE id = ?", id).first();
    if (!box || box.tunnel_id !== tunnelId) return [200, { ok: true, note: "changed since" }];
    if (cfId) {
      const t = await getTunnel(env, cfId);
      if (t) {
        const s = stale(t, Date.now());
        if (!s.neverConnected && !s.offline) return [200, { ok: true, note: "connected again" }, [sql(env, "DELETE FROM held WHERE id = ?", id)]];
        // held is saved before the tunnel is deleted, so a retry after a failed DNS step still keeps the ID for the box
        if (s.offline) await sql(env, "INSERT OR REPLACE INTO held (id, key_hash, net, held) VALUES (?, ?, ?, ?)", id, box.key_hash, box.net, Date.now()).run();
      }
      await removeTunnel(env, host, cfId);
    }
    return [200, { ok: true }, [sql(env, "DELETE FROM boxes WHERE id = ?", id)]];
  },

  async "remove-tunnel"(env, { id, cf_id: cfId, host }) {
    if (await sql(env, "SELECT 1 FROM boxes WHERE id = ? AND tunnel_id = ?", id, cfId).first()) return [200, { ok: true, note: "has a record" }];
    await removeTunnel(env, host, cfId);
    return [200, { ok: true }];
  },

  async tidy(env) {
    return [200, { ok: true }, [sql(env, "DELETE FROM results WHERE created < ?", Date.now() - 3600 * 1000)]];
  },

  // Daily: delete box IDs that were never used (no tunnel, no photo, not registered) 30 days after they were handed out.
  async "cleanup-ids"(env) {
    const day = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    return [200, { ok: true }, [
      sql(env, "DELETE FROM ids WHERE used = 0 AND created < ?", Date.now() - 30 * 24 * 3600 * 1000),
      sql(env, "DELETE FROM box_days WHERE day < ?", day),
    ]];
  },
};

// A box that opted in ("Help improve the AI") sends one labelled photo:
//   POST /api/contribute  {"id": "1234567", "label": "spaghetti", "source": "alert_yes",
//                          "image": "<base64 JPEG>", "meta": {"model": "basic-v1", "score": 0.87, ...}}
// The Worker commits it to the private data repo as incoming/<label>/<id>-<time>-<source>-<score>-...jpg
// (full details in the commit message). Boxes never get any GitHub access themselves.

const LABELS = ["ok", "spaghetti", "warping", "first_layer", "failure", "stringing", "blob"];
// labels that were dropped: older Printer Buddy versions may still send them. They're answered "sent" and
// thrown away (nothing stored), because a refused photo would hold up every photo queued after it.
const RETIRED_LABELS = ["crack"];
const SOURCES = ["alert_yes", "alert_no", "print_ok", "print_failed", "user"];
const VERDICTS = ["right", "false_alarm", "missed"];

async function contributeApi(request, env) {
  if (!env.GITHUB_TOKEN || !env.DATA_REPO || !env.BOXES || !env.DB || !env.JOBS) return json({ error: "Photo sharing isn't set up on this server yet." }, 503);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let b;
  try { b = await request.json(); } catch { return json({ error: "Bad request" }, 400); }
  const id = String(b.id || ""), label = String(b.label || ""), source = String(b.source || "user");
  if (!/^\d{6,10}$/.test(id)) return json({ error: "Bad Printer Buddy ID" }, 400);
  if (!(await ready(env))) {
    await queueJob(env, "migrate", {});
    return json({ error: "The Printer Buddy server is updating. Try again in a minute." }, 503);
  }
  const own = await owner(env, id);
  if (!own || typeof b.key !== "string" || await sha256(b.key) !== own.key_hash) {
    return json({ error: "This box ID and key don't match. Update Printer Buddy to get a box ID." }, 403);
  }
  if (own.off) return json({ error: APP_OFF }, 403);
  // an ID the relay handed out that the daily cleanup deleted in between is refused before the upload
  const marked = await sql(env, "UPDATE ids SET used = 1 WHERE id = ?", id).run();
  if (own.r === 1 && !marked.meta.changes) return json({ error: "This box ID and key don't match. Update Printer Buddy to get a box ID." }, 403);
  if (RETIRED_LABELS.includes(label)) return json({ ok: true, note: `${label} photos are no longer collected` }, 201);
  if (!LABELS.includes(label)) return json({ error: `label must be one of: ${LABELS.join(", ")}` }, 400);
  if (!SOURCES.includes(source)) return json({ error: "Bad source" }, 400);

  let bytes;
  try { bytes = Uint8Array.from(atob(String(b.image || "")), c => c.charCodeAt(0)); }
  catch { return json({ error: "image must be base64" }, 400); }
  if (bytes.length < 1000 || bytes.length > 1_000_000) return json({ error: "image must be 1 KB to 1 MB" }, 400);
  if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) return json({ error: "image must be a JPEG" }, 400);

  const day = new Date().toISOString().slice(0, 10);
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const boxKey = `contrib:box:${id}:${day}`, ipKey = `contrib:ip:${ip}:${day}`;
  const [nBox, nIp] = await Promise.all([env.BOXES.get(boxKey), env.BOXES.get(ipKey)]).then(v => v.map(x => Number(x || 0)));
  if (nBox >= Number(env.CONTRIB_PER_BOX_PER_DAY || 50) || nIp >= Number(env.CONTRIB_PER_IP_PER_DAY || 200)) {
    return json({ error: "Daily photo limit reached. The rest will be sent tomorrow." }, 429);
  }

  const meta = (b.meta && typeof b.meta === "object") ? b.meta : {};
  const verdict = VERDICTS.includes(b.verdict) ? b.verdict : "na";
  const sev = Number.isInteger(b.severity) && b.severity >= 1 && b.severity <= 10 ? b.severity : null;
  const model = /^[A-Za-z0-9._-]{1,40}$/.test(String(meta.model || "")) ? String(meta.model) : "unknown";
  const score = Number.isFinite(Number(meta.score)) ? Math.round(Number(meta.score) * 100) : "na";
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");      // 20261019T211429
  const rand = Math.random().toString(36).slice(2, 6);
  const path = `incoming/${label}/${id}-${stamp}-${source}-${score}-${verdict}-s${sev ?? "na"}-${rand}.jpg`;
  const message = `${label} from box ${id} (${source}, AI ${verdict.replace("_", " ")})\n\n` +
                  JSON.stringify({ id, label, source, verdict, severity: sev, meta }).slice(0, 4000);

  const api = `https://api.github.com/repos/${env.DATA_REPO}/contents/${path}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(api, {
      method: "PUT",
      headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json",
                 "user-agent": "printer-buddy-worker", "content-type": "application/json" },
      body: JSON.stringify({ message, content: String(b.image) }),
    });
    if (r.status === 201 || r.status === 200) {
      await Promise.all([
        env.BOXES.put(boxKey, String(nBox + 1), { expirationTtl: 2 * 24 * 3600 }),
        env.BOXES.put(ipKey, String(nIp + 1), { expirationTtl: 2 * 24 * 3600 }),
        verdict !== "na" ? countVerdict(env, model, verdict, day) : null,
      ]);
      return json({ ok: true, path }, 201);
    }
    if (r.status !== 409) {   // 409 = someone else committed at the same moment: try again
      const t = await r.text();
      return json({ error: `GitHub said ${r.status}: ${t.slice(0, 200)}` }, 502);
    }
    await new Promise(res => setTimeout(res, 300 * (attempt + 1)));
  }
  return json({ error: "GitHub was busy, try again later" }, 503);
}

// stats:<model>              all-time {right, false_alarm, missed}
// statsday:<YYYY-MM-DD>:<model>  same, for one day (kept 40 days) - used by the daily Discord summary
const emptyStats = () => ({ right: 0, false_alarm: 0, missed: 0 });

async function bump(env, key, verdict, ttl) {
  const cur = (await env.BOXES.get(key, "json")) || emptyStats();
  cur[verdict] = (cur[verdict] || 0) + 1;
  await env.BOXES.put(key, JSON.stringify(cur), ttl ? { expirationTtl: ttl } : undefined);
}

function countVerdict(env, model, verdict, day) {
  return Promise.all([bump(env, `stats:${model}`, verdict), bump(env, `statsday:${day}:${model}`, verdict, 40 * 24 * 3600)]);
}

const pct = s => { const n = s.right + s.false_alarm + s.missed; return n ? Math.round(100 * s.right / n) : 0; };

async function readStats(env, prefix) {
  const out = {};
  const list = await env.BOXES.list({ prefix });
  for (const k of list.keys) out[k.name.slice(prefix.length)] = (await env.BOXES.get(k.name, "json")) || emptyStats();
  return out;
}

async function statsApi(env) {
  if (!env.BOXES) return json({ error: "Not set up" }, 503);
  const models = await readStats(env, "stats:");
  const out = {};
  for (const [m, s] of Object.entries(models)) {
    out[m] = { ...s, photos: s.right + s.false_alarm + s.missed, right_percent: pct(s) };
  }
  return json({ models: out, note: "From labelled photos that Printer Buddy users chose to share." });
}

async function dailySummary(env) {
  if (!env.BOXES || !env.DISCORD_WEBHOOK) return;
  const y = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
  const day = await readStats(env, `statsday:${y}:`);
  const all = await readStats(env, "stats:");
  const lines = Object.entries(day).map(([m, s]) => {
    const t = all[m] || s, n = s.right + s.false_alarm + s.missed, tn = t.right + t.false_alarm + t.missed;
    return `**${m}**: ${pct(s)}% right over ${n} photos (${s.false_alarm} false alarms, ${s.missed} missed) - all time ${pct(t)}% over ${tn}`;
  });
  if (!lines.length) return;
  await fetch(env.DISCORD_WEBHOOK, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: `AI report for ${y}\n` + lines.join("\n") }),
  }).catch(() => {});
}
