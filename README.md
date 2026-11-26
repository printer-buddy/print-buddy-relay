<p align="center"><img src="https://raw.githubusercontent.com/printer-buddy/printer-buddy/nightly/assets/logo.png" alt="Printer Buddy" width="160"></p>

# printerbuddy.stream server (Cloudflare Worker)

`worker.js` does three jobs on `www.printerbuddy.stream`:

1. **Share relay** - `/share/user/<ID>/printer/...` is fetched through that box's tunnel, so viewers never see the box's home address.
2. **Box IDs** - `/api/box` hands a new box its ID at install. The box makes its own key and sends it (`{"key": "<64 hex>"}`), so asking again gets the same ID; a box that sends `{}` gets a key from the relay. The key goes with every tunnel request and photo.
3. **Automatic tunnels** - `/api/tunnel` lets a box set up its own tunnel (installer: turn Remote access on in Change setup).
   It creates tunnel `pb-u<ID>`, routes `https://u<ID>.printerbuddy.stream/share/...` to the box, makes the DNS record,
   and posts **"Box 1234567 set up wireless sharing!"** to Discord.

Only the box with the ID's key (kept in `printer-buddy.env` as `PB_BOX_KEY`) can set up, change, remove or get back its tunnel.
Limits: 5 new box IDs per network per day, one tunnel per ID, one box sharing at a time per network (IPv6 counts per /64),
5 on a network registered with `/register <box ID>` in the Discord (the network that box was last seen on), 500 in total. Removing a tunnel gives its slot back.
A box that was sharing before networks were counted counts toward the network it next asks from; if that network is
already full, its tunnel is removed and its ID held until there's room or it's registered.
Every hour the Worker removes tunnels that never connected within an hour, and tunnels offline for 4 days (that box gets the
same address back next time). Every day it deletes box IDs that were never used 30 days after they were handed out.
Other programs that use the relay register as an app and get 50 box IDs; each ID remembers its app, and turning an app off
stops every ID it got (tunnels and photos).
Every change to box IDs, tunnels, the allow list and apps is a job on a Cloudflare queue that runs one job at a time, so two
changes never overlap; a request waits about 20 seconds for its answer. On the Workers Free plan the queue takes about 3,300
jobs a day (10,000 operations, 3 per job): one per request, plus one per box when an app is turned off or the hourly cleanup removes it.

## Automatic deploys

`wrangler.toml` lets Cloudflare deploy `worker.js` itself on every push to GitHub, so there's no more pasting code:
**Workers & Pages > printer-buddy-share > Settings > Builds > Connect** > repository `printer-buddy`, branch `main`,
root directory `relay`, build command empty, deploy command `npx wrangler deploy`.
Dashboard variables are kept (`keep_vars`), secrets are never touched. The KV, D1 and queue bindings, the queue's one-job-at-a-time settings, the route and the triggers come from `wrangler.toml`.
The first deploy makes the D1 database `printer-buddy` and the queue `printer-buddy-jobs`, and the first job after it copies
the box records from KV into D1 (KV is left as it was).

## One-time setup

### 1. Cloudflare API token
Cloudflare dashboard > **My Profile > API Tokens > Create Token > Custom token**:

- Permissions:
  - **Account - Cloudflare Tunnel - Edit**
  - **Zone - DNS - Edit**
- Account resources: your account. Zone resources: **printerbuddy.stream** only.
- Create, and copy the token (shown once).

### 2. Account ID and Zone ID
Open **printerbuddy.stream** in the dashboard. The right-hand column of the Overview page shows **Zone ID** and **Account ID**.

### 3. KV storage (photo limits and AI stats)
**Workers & Pages > KV > Create namespace**, name it `printer-buddy-boxes`.

### 4. Discord webhook (announcements)
In Discord: **Server Settings > Integrations > Webhooks > New Webhook**, pick the channel, **Copy Webhook URL**.

### 5. Worker settings
Open the `printer-buddy-share` Worker (see the top of `worker.js` if it doesn't exist yet), paste in the current `worker.js`, **Deploy**, then **Settings**:

| Where | Name | Value |
|---|---|---|
| Bindings > Add > KV namespace | `BOXES` | `printer-buddy-boxes` |
| Bindings > Add > D1 database | `DB` | `printer-buddy` (made by the first deploy) |
| Bindings > Add > Queue | `JOBS` | `printer-buddy-jobs` (made by the first deploy) |
| Variables and Secrets (type **Secret**) | `CF_API_TOKEN` | token from step 1 |
| Variables and Secrets (type **Secret**) | `DISCORD_WEBHOOK` | URL from step 4 |
| Variables and Secrets (type **Text**) | `CF_ACCOUNT_ID` | from step 2 |
| Variables and Secrets (type **Text**) | `CF_ZONE_ID` | from step 2 |
| Variables and Secrets (type **Text**) | `SHARE_DOMAIN` | `printerbuddy.stream` |
| Variables and Secrets (type **Secret**) | `REGISTER_SECRET` | any long random text; the Discord bot sends it to register a box's network |
| Variables and Secrets (type **Text**) | `DISCORD_PUBLIC_KEY` | the Discord app's public key (see Discord commands below) |
| Variables and Secrets (type **Text**) | `DISCORD_GUILD_ID` | the Printer Buddy Discord server's ID; admin commands only work there |
| Variables and Secrets (type **Secret**) | `DISCORD_ADMIN_WEBHOOK` | webhook URL for an admin-only channel; app requests are posted there |
| optional (Text) | `MAX_TUNNELS` | default `500` |
| optional (Text) | `REGISTERED_PER_NETWORK` | default `5` |
| optional (Text) | `BOXES_PER_NETWORK_PER_DAY` | default `5` |
| optional (Text) | `APP_IDS` | box IDs per app, default `50` |

The Discord bot registers a box's network with
`curl -s -X POST https://www.printerbuddy.stream/api/register -H "authorization: Bearer <REGISTER_SECRET>" -H 'content-type: application/json' -d '{"id": "1234567"}'` → `{"ok": true, "id": "1234567"}`.

Apps (all `POST` with `content-type: application/json`):

| Endpoint | Body | Needs | Reply |
|---|---|---|---|
| `/api/app` | `{"name": "someapp"}` | `authorization: Bearer <REGISTER_SECRET>` | `{"name", "key"}` (the app's key; asking again gives the same key) |
| `/api/app/ids` | `{"name", "key"}` | the app's key | `{"ids": [{"id", "key"}, ...]}`, its 50 box IDs; asking again gives the same IDs and keys |
| `/api/app/off` | `{"name"}` | `authorization: Bearer <REGISTER_SECRET>` | `{"ok": true, "name", "off": true, "boxes"}`; then each of those boxes' tunnels is removed (cut if still connected) in its own job |
| `/api/app/on` | `{"name"}` | `authorization: Bearer <REGISTER_SECRET>` | `{"ok": true, "name", "off": false}` |

### Discord commands

The Worker answers Discord's slash commands itself at `https://www.printerbuddy.stream/api/discord`; no bot program runs anywhere.
Replies are only shown to the person who typed the command.

| Command | Who | What it does |
|---|---|---|
| `/register id:<box ID>` | anyone | registers the network that box was last seen on: up to 5 can share on it. A box the relay hasn't seen yet (no share link, Remote access off, no photos) can't be registered |
| `/register-app name:<name>` | anyone | asks for an app; admins are told in `DISCORD_ADMIN_WEBHOOK`. Once approved, the same person running it again gets `<name>-ids.csv` (its 50 box IDs and keys) and the app key |
| `/approve-app name:<name>` | admins | approves the app and makes its 50 box IDs |
| `/block app:<name>`, `/unblock app:<name>` | admins | turns the app off (its tunnels and photos are refused, running tunnels cut) or back on |

Admin commands are hidden from everyone without Administrator, and the Worker also checks that the person has
Administrator in the server set in `DISCORD_GUILD_ID`.

Set up once:

1. **Discord Developer Portal > New Application.** From **General Information** copy the **Application ID** and **Public Key**;
   put the Public Key in the Worker as `DISCORD_PUBLIC_KEY` (step 5) and deploy.
2. In **General Information**, set **Interactions Endpoint URL** to `https://www.printerbuddy.stream/api/discord` and save
   (Discord checks it right away, so the Worker has to be deployed first).
3. **Bot > Reset Token** and copy the bot token, then create the commands:

```bash
curl -s -X PUT "https://discord.com/api/v10/applications/<application ID>/commands" \
  -H "authorization: Bot <bot token>" -H "content-type: application/json" -d '[
  {"name": "register", "description": "Let this box share with up to 5 boxes on its network", "contexts": [0],
   "options": [{"type": 3, "name": "id", "description": "Box ID from the Printer Buddy menu", "required": true}]},
  {"name": "register-app", "description": "Ask for an app and get its 50 box IDs once approved", "contexts": [0],
   "options": [{"type": 3, "name": "name", "description": "App name", "required": true}]},
  {"name": "approve-app", "description": "Approve an app", "contexts": [0], "default_member_permissions": "0",
   "options": [{"type": 3, "name": "name", "description": "App name", "required": true}]},
  {"name": "block", "description": "Turn an app off", "contexts": [0], "default_member_permissions": "0",
   "options": [{"type": 3, "name": "app", "description": "App name", "required": true}]},
  {"name": "unblock", "description": "Turn an app back on", "contexts": [0], "default_member_permissions": "0",
   "options": [{"type": 3, "name": "app", "description": "App name", "required": true}]}
]'
```

4. **Installation > Default Install Settings > Guild Install**: add the `applications.commands` and `bot` scopes (no bot
   permissions are needed), then open the **Install Link** and add the app to the Printer Buddy server.
5. Put the server's ID in `DISCORD_GUILD_ID` (Discord: User Settings > Advanced > Developer Mode on, then right-click the
   server and copy its ID), and a webhook for an admin-only channel in `DISCORD_ADMIN_WEBHOOK`.

The route `www.printerbuddy.stream/*` must point at this Worker (it already does if share links work).

## Test it

Get a box ID:

```bash
curl -s -X POST https://www.printerbuddy.stream/api/box -H 'content-type: application/json' -d '{}'
```

Expected: `{"id": "1234567", "key": "..."}`. This makes a **real** tunnel named `pb-u<ID>` (you'll see it in Zero Trust > Networks > Tunnels, and the Discord post):

```bash
curl -s -X POST https://www.printerbuddy.stream/api/tunnel -H 'content-type: application/json' -d '{"id": "<id from above>", "port": 8080, "key": "<key from above>"}'
```

Expected: `{"token": "...", "hostname": "u<ID>.printerbuddy.stream"}`. Remove it again:

```bash
curl -s -X DELETE https://www.printerbuddy.stream/api/tunnel -H 'content-type: application/json' -d '{"id": "<id from above>", "key": "<key from above>"}'
```

| Reply | Meaning |
|---|---|
| `Automatic setup isn't configured on this server yet.` | a setting from step 5 is missing (or the D1 and queue bindings aren't named `DB` and `JOBS`) |
| `Cloudflare said: ... Authentication error` | the API token is wrong or lacks a permission from step 1 |
| `This Printer Buddy ID wasn't handed out by the relay` | get a box ID from `/api/box` first |
| `This Printer Buddy ID is already set up on another box` | the key didn't match that ID |
| `This network already has a box sharing` | another box on that network is sharing; register this box with `/register <box ID>` in the Discord |
| `Too many new box IDs from this network today` | 5 IDs per network per day; try tomorrow |
| `The tunnel is still connected` (on DELETE) | stop cloudflared on that box, wait a minute, try again |
| `The tunnel was removed, but its address couldn't be` (on DELETE) | the DNS step failed; try again in a minute |
| `Bad box key` | a new box's own key must be 64 hex characters |
| `The Printer Buddy server is busy. Try again in a minute.` | the queue didn't answer within about 20 seconds; the request still runs, and asking again with the same box key or app key gets its answer |
| `The Printer Buddy server is updating. Try again in a minute.` (photos) | right after a deploy, while the box records are copied from KV into D1 |

## Training photos (`/api/contribute`)

Boxes whose owner ticked **Help improve the AI** send labelled camera photos here. The Worker commits each one to a
**private GitHub repo** as `incoming/<label>/<box>-<time>-<source>-<score>-<verdict>-s<how bad>-xxxx.jpg`
(details in the commit message). **Review them:** move the good ones to `photos/<label>/` (fix the label folder if
it's wrong), delete junk. Only `photos/` is used for training.
Boxes never get GitHub access; only the Worker holds the token. Limits: 50 photos per box and 200 per network per day.

### Setup (once)

1. **Make the repo:** GitHub > New repository > name `printer-buddy-data`, **Private**, tick "Add a README" (the repo must not be empty).
2. **Make a token for the Worker:** GitHub > Settings > Developer settings > Fine-grained tokens > Generate new token
   - Repository access: **Only select repositories > printer-buddy-data**
   - Permissions: **Contents: Read and write** (nothing else)
   - Copy the token.
3. **Worker > Settings > Variables and Secrets:**

| Type | Name | Value |
|---|---|---|
| Secret | `GITHUB_TOKEN` | the token from step 2 |
| Text | `DATA_REPO` | `printer-buddy/printer-buddy-data` |
| optional (Text) | `CONTRIB_PER_BOX_PER_DAY` | default `50` |
| optional (Text) | `CONTRIB_PER_IP_PER_DAY` | default `200` |

Deploy. It uses the same `BOXES` KV binding for its daily counters.

### Test it

Commits a real photo to the data repo (delete it there afterwards):

```bash
curl -s -X POST https://www.printerbuddy.stream/api/contribute -H 'content-type: application/json' \
  -d "{\"id\": \"<box ID>\", \"key\": \"<box key>\", \"label\": \"ok\", \"source\": \"user\", \"image\": \"$(base64 -w0 some-photo.jpg)\"}"
```

Expected: `{"ok": true, "path": "incoming/ok/<box ID>-...jpg"}`. Labels: `ok, spaghetti, warping, first_layer, failure, stringing, blob, crack`.

### Was the AI right?

Each shared photo carries a verdict: **right**, **false_alarm** (the AI flagged a problem, the user said OK) or
**missed** (the AI said OK, the user labelled a failure). It's in the file name (`...-<verdict>-xxxx.jpg`), so
for the next model you can pick out exactly the photos it got wrong.

- **Totals:** open `https://www.printerbuddy.stream/api/ai-stats`, e.g.
  `{"models": {"basic-v1": {"right": 1134, "false_alarm": 41, "missed": 28, "photos": 1203, "right_percent": 94}}}`
- **Daily Discord report:** Worker > **Settings > Triggers > Cron Triggers > Add** > `0 13 * * *` (every day at
  13:00 UTC). Each morning it posts yesterday's numbers per model to `DISCORD_WEBHOOK`. Nothing is posted on days
  when no photos were shared.

## On a box

`./install.sh` > **2) Change setup** > **Remote access = on**. That's all.
To manage any box yourself, use the Cloudflare dashboard (Zero Trust > Networks > Tunnels, and DNS).

## License

Copyright (C) 2026 sterling motuz. Licensed under the GNU Affero General Public License v3.0 only (AGPL-3.0-only), with extra terms: keep the licence header in each file, and include a CHANGELOG of any changes. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The Printer Buddy name and logo are not covered by the licence.
