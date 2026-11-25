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
    if (url.pathname === "/api/tunnel") return tunnelApi(request, env, ctx, url);
    if (url.pathname === "/api/box") return boxApi(request, env);
    if (url.pathname === "/api/register") return registerApi(request, env);
    if (["/api/app", "/api/app/ids", "/api/app/off", "/api/app/on"].includes(url.pathname)) return appApi(request, env, url.pathname);
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
    ctx.waitUntil(event.cron === "0 13 * * *" ? Promise.all([dailySummary(env), cleanupIds(env)])
                                              : cleanupTunnels(env, new URL("https://" + (env.SHARE_DOMAIN || "printerbuddy.stream"))));
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
//   hold: true keeps its spot on the network while it's not sharing; false gives it up (Remote access off).
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

async function netGet(env, net) {
  return (await env.BOXES.get(`net:${net}`, "json")) || { n: 0 };
}

// id:<id> = an ID the relay handed out, with its key. Boxes set up before that are known by their tunnel record.
async function owner(env, id) {
  return (await env.BOXES.get(`id:${id}`, "json")) || (await env.BOXES.get(`box:${id}`, "json"))
      || (await env.BOXES.get(`held:${id}`, "json"));
}

async function appOff(env, own) {
  return !!own.app && !!(await env.BOXES.get(`app:${own.app}`, "json"))?.off;
}

async function freeId(env) {
  for (let i = 0; i < 10; i++) {
    const r = new Uint32Array(1);
    crypto.getRandomValues(r);
    const c = String(1000000 + r[0] % 9000000);
    if (!(await owner(env, c))) return c;
  }
  return null;
}

async function markUsed(env, id) {
  const rec = await env.BOXES.get(`id:${id}`, "json");
  if (rec && !rec.used) await env.BOXES.put(`id:${id}`, JSON.stringify({ ...rec, used: true }), { metadata: { created: rec.created, used: true } });
}

async function freeSlot(env, box) {
  if (box.net) {
    const n = await netGet(env, box.net);
    n.n = Math.max(0, n.n - 1);
    await env.BOXES.put(`net:${box.net}`, JSON.stringify(n));
  }
  const total = Number(await env.BOXES.get("count") || 0);
  await env.BOXES.put("count", String(Math.max(0, total - 1)));
}

async function removeTunnel(env, host, tunnelId) {
  await cf(env, "DELETE", `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${tunnelId}`);
  const rec = await dnsRecord(env, host);
  if (rec) await cf(env, "DELETE", `/zones/${env.CF_ZONE_ID}/dns_records/${rec.id}`);
}

async function makeTunnel(env, id, host, port) {
  const t = await cf(env, "POST", `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel`, { name: `pb-u${id}`, config_src: "cloudflare" });
  try {
    await routing(env, t.id, host, port);
    await pointDns(env, host, t.id);
  } catch (e) {
    await removeTunnel(env, host, t.id).catch(() => {});
    throw e;
  }
  return t;
}

async function tunnelApi(request, env, ctx, url) {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID || !env.CF_ZONE_ID || !env.BOXES) {
    return json({ error: "Automatic setup isn't configured on this server yet." }, 503);
  }
  if (request.method !== "POST" && request.method !== "DELETE") return json({ error: "Method not allowed" }, 405);
  let b;
  try { b = await request.json(); } catch { return json({ error: "Bad request" }, 400); }
  const id = String(b.id || "");
  if (!/^\d{6,10}$/.test(id)) return json({ error: "Bad Printer Buddy ID" }, 400);
  const domain = (env.SHARE_DOMAIN || url.hostname).replace(/^www\./, "");
  const host = `u${id}.${domain}`;
  const kvKey = `box:${id}`, heldKey = `held:${id}`;
  const box = await env.BOXES.get(kvKey, "json");
  const held = box ? null : await env.BOXES.get(heldKey, "json");
  const keyHash = typeof b.key === "string" ? await sha256(b.key) : null;
  const own = (await env.BOXES.get(`id:${id}`, "json")) || box || held;

  if (!own) return json({ error: "This Printer Buddy ID wasn't handed out by the relay. Update Printer Buddy to get a box ID." }, 403);
  if ((box && keyHash !== box.key_hash) || (held && keyHash !== held.key_hash) || keyHash !== own.key_hash) {
    return json({ error: "This Printer Buddy ID is already set up on another box (or this box lost its key). " +
                        "Remove PB_USER_ID, PB_BOX_KEY and PB_TUNNEL_KEY from printer-buddy.env to get a new ID." }, 403);
  }

  try {
    if (request.method === "DELETE") {
      if (!box) {
        if (held && b.hold !== true) await env.BOXES.delete(heldKey);
        return json({ ok: true, note: "nothing to remove" });
      }
      try {
        await removeTunnel(env, host, box.tunnel_id);
      } catch (e) {
        return json({ error: `The tunnel is still connected. Stop cloudflared on the box and try again in a minute. (${e.message})` }, 409);
      }
      await env.BOXES.delete(kvKey);
      if (b.hold === true) await env.BOXES.put(heldKey, JSON.stringify({ key_hash: box.key_hash, net: box.net || null, held: Date.now() }));
      await freeSlot(env, box);
      return json({ ok: true });
    }

    if (await appOff(env, own)) return json({ error: "The app this box ID came from has been turned off by Printer Buddy." }, 403);
    const port = Number(b.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return json({ error: "Bad port" }, 400);

    if (box) {
      if (box.port !== port) {
        await routing(env, box.tunnel_id, host, port);
        box.port = port;
      }
      box.updated = Date.now();
      await env.BOXES.put(kvKey, JSON.stringify(box));
      return json({ token: box.token, hostname: host });
    }

    const total = Number(await env.BOXES.get("count") || 0);
    if (total >= Number(env.MAX_TUNNELS || 500)) return json({ error: "Wireless sharing is full right now. Please tell the Printer Buddy team." }, 503);

    const net = held ? held.net : networkOf(request.headers.get("cf-connecting-ip") || "unknown");
    const netInfo = net ? await netGet(env, net) : { n: 0 };
    if (!held) {
      const allowed = !!(await env.BOXES.get(`allowed:${id}`));
      const limit = allowed ? Number(env.REGISTERED_PER_NETWORK || 5) : 1;
      if (netInfo.n >= limit) {
        return json({ error: allowed ? `This network already has ${limit} boxes sharing.`
                                     : "This network already has a box sharing. Register this box with /register <box ID> in the Printer Buddy Discord to share up to 5 on one network." }, 429);
      }
    }

    const t = await makeTunnel(env, id, host, port);
    await env.BOXES.put(kvKey, JSON.stringify({ tunnel_id: t.id, token: t.token, key_hash: own.key_hash,
                                                port, net, created: Date.now(), updated: Date.now() }));
    if (held) await env.BOXES.delete(heldKey);
    if (net) await env.BOXES.put(`net:${net}`, JSON.stringify({ n: netInfo.n + 1 }));
    await env.BOXES.put("count", String(total + 1));
    await markUsed(env, id);

    if (env.DISCORD_WEBHOOK && !held) {
      ctx.waitUntil(fetch(env.DISCORD_WEBHOOK, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: `Box ${id} set up wireless sharing!` }),
      }).catch(() => {}));
    }
    return json({ token: t.token, hostname: host }, held ? 200 : 201);
  } catch (e) {
    return json({ error: `Cloudflare said: ${e.message}` }, 502);
  }
}

async function boxApi(request, env) {
  if (!env.BOXES) return json({ error: "Box IDs aren't set up on this server yet." }, 503);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let b;
  try { b = await request.json(); } catch { b = {}; }
  const net = networkOf(request.headers.get("cf-connecting-ip") || "unknown");
  const dayKey = `boxday:${net}:${new Date().toISOString().slice(0, 10)}`;
  const today = Number(await env.BOXES.get(dayKey) || 0);
  if (today >= Number(env.BOXES_PER_NETWORK_PER_DAY || 5)) return json({ error: "Too many new box IDs from this network today. Try again tomorrow." }, 429);

  let id, key, used = false;
  if (b && b.id !== undefined) {
    id = String(b.id);
    if (!/^\d{6,10}$/.test(id)) return json({ error: "Bad Printer Buddy ID" }, 400);
    if (await env.BOXES.get(`id:${id}`)) return json({ error: "This Printer Buddy ID already belongs to a box." }, 409);
    const old = await owner(env, id);
    if (old && (typeof b.key !== "string" || await sha256(b.key) !== old.key_hash)) {
      return json({ error: "This Printer Buddy ID is already set up on another box (or this box lost its key)." }, 403);
    }
    key = old ? b.key : newKey();
    used = !!old;
  } else {
    id = await freeId(env);
    if (!id) return json({ error: "Couldn't pick a free box ID, try again." }, 503);
    key = newKey();
  }
  const created = Date.now();
  await env.BOXES.put(`id:${id}`, JSON.stringify({ key_hash: await sha256(key), created, used }), { metadata: { created, used } });
  await env.BOXES.put(dayKey, String(today + 1), { expirationTtl: 2 * 24 * 3600 });
  return json({ id, key }, 201);
}

// The Discord bot puts a box on the allow list:  POST /api/register  {"id": "1234567"}  (authorization: Bearer <REGISTER_SECRET>)
async function registerApi(request, env) {
  if (!env.REGISTER_SECRET || !env.BOXES) return json({ error: "Registering isn't set up on this server yet." }, 503);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (request.headers.get("authorization") !== `Bearer ${env.REGISTER_SECRET}`) return json({ error: "Not allowed" }, 403);
  let b;
  try { b = await request.json(); } catch { return json({ error: "Bad request" }, 400); }
  const id = String(b.id || "");
  if (!/^\d{6,10}$/.test(id)) return json({ error: "Bad Printer Buddy ID" }, 400);
  if (!(await owner(env, id))) return json({ error: "No box has that ID." }, 404);
  await env.BOXES.put(`allowed:${id}`, "1");
  await markUsed(env, id);
  return json({ ok: true, id });
}

// Other programs that use the relay register as an app, and every box ID they get remembers the app:
//   POST /api/app               {"name"}  (Bearer REGISTER_SECRET) -> {"name", "key"}
//   POST /api/app/ids           {"name", "key"}                     -> {"ids": [{"id", "key"}, ...]}  its 50 box IDs, once
//   POST /api/app/off | /on     {"name"}  (Bearer REGISTER_SECRET)  every box ID from that app is refused / allowed again
async function appApi(request, env, path) {
  if (!env.REGISTER_SECRET || !env.BOXES) return json({ error: "Apps aren't set up on this server yet." }, 503);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let b;
  try { b = await request.json(); } catch { return json({ error: "Bad request" }, 400); }
  const name = String(b.name || "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,39}$/.test(name)) return json({ error: "App name: 2 to 40 letters, numbers, - or _" }, 400);
  const appKey = `app:${name}`, app = await env.BOXES.get(appKey, "json");

  if (path === "/api/app/ids") {
    if (!app || typeof b.key !== "string" || await sha256(b.key) !== app.key_hash) return json({ error: "App name and key don't match." }, 403);
    if (app.off) return json({ error: "This app has been turned off by Printer Buddy." }, 403);
    if (app.ids) return json({ error: "This app already got its box IDs." }, 409);
    const ids = [], created = Date.now();
    for (let i = 0; i < Number(env.APP_IDS || 50); i++) {
      const id = await freeId(env);
      if (!id) break;
      const key = newKey();
      await env.BOXES.put(`id:${id}`, JSON.stringify({ key_hash: await sha256(key), created, used: false, app: name }), { metadata: { created, used: false } });
      ids.push({ id, key });
    }
    await env.BOXES.put(appKey, JSON.stringify({ ...app, ids: ids.length }));
    return json({ ids }, 201);
  }

  if (request.headers.get("authorization") !== `Bearer ${env.REGISTER_SECRET}`) return json({ error: "Not allowed" }, 403);
  if (path === "/api/app") {
    if (app) return json({ error: "That app is already registered." }, 409);
    const key = newKey();
    await env.BOXES.put(appKey, JSON.stringify({ key_hash: await sha256(key), created: Date.now(), ids: 0, off: false }));
    return json({ name, key }, 201);
  }
  if (!app) return json({ error: "No app has that name." }, 404);
  await env.BOXES.put(appKey, JSON.stringify({ ...app, off: path === "/api/app/off" }));
  return json({ ok: true, name, off: path === "/api/app/off" });
}

async function listAll(env, prefix) {
  const out = [];
  let cursor;
  do {
    const page = await env.BOXES.list({ prefix, cursor });
    out.push(...page.keys.map(k => k.name));
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out;
}

// Hourly: remove tunnels that never connected within an hour (freed), and tunnels offline for 4 days
// (ID held for the box). Delete leftover pb-u tunnels with no record, then recount the slots.
async function cleanupTunnels(env, url) {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID || !env.CF_ZONE_ID || !env.BOXES) return;
  const domain = (env.SHARE_DOMAIN || url.hostname).replace(/^www\./, "");
  const now = Date.now(), HOUR = 3600 * 1000;
  const tunnels = new Map();
  for (let page = 1; ; page++) {
    const list = await cf(env, "GET", `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel?is_deleted=false&per_page=1000&page=${page}`);
    for (const t of list || []) if (/^pb-u\d{6,10}$/.test(t.name)) tunnels.set(t.name, t);
    if (!list || list.length < 1000) break;
  }

  const nets = {};
  let count = 0;
  for (const kvKey of await listAll(env, "box:")) {
    const id = kvKey.slice(4), box = await env.BOXES.get(kvKey, "json");
    if (!box) continue;
    const t = tunnels.get(`pb-u${id}`);
    tunnels.delete(`pb-u${id}`);
    const neverConnected = t && t.status === "inactive" && now - Date.parse(t.created_at) > HOUR;
    const offline = t && t.status === "down" && t.conns_inactive_at && now - Date.parse(t.conns_inactive_at) > 4 * 24 * HOUR;
    if (!t || neverConnected || offline) {
      if (t) { try { await removeTunnel(env, `u${id}.${domain}`, t.id); } catch { continue; } }
      await env.BOXES.delete(kvKey);
      if (offline) await env.BOXES.put(`held:${id}`, JSON.stringify({ key_hash: box.key_hash, net: box.net || null, held: now }));
      continue;
    }
    count++;
    if (box.net) nets[box.net] = (nets[box.net] || 0) + 1;
  }

  for (const [name, t] of tunnels) {
    if (now - Date.parse(t.created_at) < HOUR) continue;
    try { await removeTunnel(env, `${name.slice(3)}.${domain}`, t.id); } catch {}
  }

  for (const netKey of await listAll(env, "net:")) {
    const net = netKey.slice(4), cur = (await env.BOXES.get(netKey, "json")) || { n: 0 };
    const n = nets[net] || 0;
    if (cur.n !== n) await env.BOXES.put(netKey, JSON.stringify({ n }));
  }
  await env.BOXES.put("count", String(count));
}

// Daily: delete box IDs that were never used (no tunnel, no photo, not registered) 30 days after they were handed out.
async function cleanupIds(env) {
  if (!env.BOXES) return;
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  let cursor;
  do {
    const page = await env.BOXES.list({ prefix: "id:", cursor });
    for (const k of page.keys) {
      if (k.metadata && !k.metadata.used && k.metadata.created < cutoff) await env.BOXES.delete(k.name);
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
}

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
  if (!env.GITHUB_TOKEN || !env.DATA_REPO || !env.BOXES) return json({ error: "Photo sharing isn't set up on this server yet." }, 503);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let b;
  try { b = await request.json(); } catch { return json({ error: "Bad request" }, 400); }
  const id = String(b.id || ""), label = String(b.label || ""), source = String(b.source || "user");
  if (!/^\d{6,10}$/.test(id)) return json({ error: "Bad Printer Buddy ID" }, 400);
  const own = await owner(env, id);
  if (!own || typeof b.key !== "string" || await sha256(b.key) !== own.key_hash) {
    return json({ error: "This box ID and key don't match. Update Printer Buddy to get a box ID." }, 403);
  }
  if (await appOff(env, own)) return json({ error: "The app this box ID came from has been turned off by Printer Buddy." }, 403);
  await markUsed(env, id);
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
