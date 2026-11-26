# Changelog

All changes to the printerbuddy.stream Worker, newest first.

################################2026-11-26 sterling m security/register-carry-over################################

## Boxes registered before keep their 5, and asking for an ID again updates the box's network

Once the KV records are copied, the first start after this deploy registers the network of every box that was registered one at a time before (from its tunnel or held ID); a registered box with neither has no stored network and needs `/register` again. A box that asks `/api/box` again with its own key now updates the network the relay last saw it on. *Why:* the limit only reads registered networks, so every box registered before lost its 5 until it was registered again; and asking again for an ID was answered without the network being recorded, so `/register` used an old one.

Lines changed:
- `worker.js` — 192–195 copy the registered boxes' networks once; 389–392 asking again for an ID records the network

################################end of entry################################

################################2026-11-26 sterling m security/app-photos-only################################

## App box IDs only send photos

An app's box ID now gets 403 "App box IDs are for photos only." when it asks for a tunnel or is sent to `/register`. *Why:* apps only send photos; before, an app's ID and key could get a tunnel like a box, and registering one opened its network to 5.

Lines changed:
- `worker.js` — 661 the tunnel job refuses an app's ID; 754–756 the `register` job refuses an app's ID

################################end of entry################################

################################2026-11-26 sterling m security/register-network################################

## /register registers a network, not a single box

`/register id:<box ID>` now registers the network the relay last saw that box on, and up to 5 boxes can share on a registered network; every other network stays at 1. The relay remembers a box's latest network only after its key matched: when it gets its ID, asks for or removes its tunnel, or sends a photo. A box the relay hasn't seen yet can't be registered and gets "The relay hasn't seen that box yet". *Why:* the limit is 1 tunnel per network unless the network is registered; registering put only that one box on the allow list.

Lines changed:
- `worker.js` — 117 comment; 190–195 the `seen` and `allowed_nets` tables and `seenAt`; 356–357 the box's network is sent with a tunnel removal; 396, 459 comments; 516 the `/register` reply; 659 the tunnel job remembers the network; 664 the limit checks `allowed_nets`; 706, 711 a tunnel removal remembers the network; 730, 747 getting an ID remembers the network; 751–756 the `register` job registers the box's last network, or answers 409; 900 a photo remembers the network
- `README.md` — 15 the limit; 68, 77 `REGISTER_SECRET` and the register call; 96 what `/register` does

################################end of entry################################

################################2026-11-26 sterling m security/app-request-notice################################

## Admins hear about an app request even if the /register-app command timed out

The post to `DISCORD_ADMIN_WEBHOOK` about a new app request is now sent by the queue job that saves the request, instead of by the Discord command after the job answers. *Why:* if the queue answered after the command's 20 seconds, the request was saved but the admins were never told, and asking again only said "still waiting".

Lines changed:
- `worker.js` — 525 the `/register-app` command no longer posts to the admins; 766–776 the `app-request` job posts to the admins when it saves a new request

################################end of entry################################

################################2026-11-26 sterling m security/stale-tunnels################################

## A connected old box on a full network is cut, and a box never gets the token of a deleted tunnel

When a box from before networks were stored asks from a network that's already full and its tunnel is still connected, the tunnel is cut (no routing, no address) instead of failing; the box is kept, uncounted, and gets the same tunnel and address back once there's room. Removing a tunnel (the box's own `DELETE`, or the refusal above) marks the box unfinished before it starts, and when a cut or unfinished box asks for its tunnel, the relay first checks the tunnel still exists: if it was already deleted, the box gets a new tunnel (through the usual network check) instead of the deleted tunnel's token. A box's own record no longer counts against its network or the total while it asks again. *Why:* deleting a connected tunnel fails, so the old box kept sharing without being counted; and if removal deleted the tunnel but failed on the address, a later request was answered 200 with a token that could never connect.

Lines changed:
- `worker.js` — 662–664 a cut or unfinished box whose tunnel is gone gets a new one, and its own record isn't counted; 669–676 the refusal marks the box unfinished and cuts a connected tunnel instead of failing; 690, 694, 700 a new tunnel replaces the old record, without a second Discord post; 712 `untunnel` marks the box unfinished before removing

################################end of entry################################

################################2026-11-26 sterling m security/discord################################

## Discord commands: /register, /register-app, and admin approve and block; old boxes count toward their network

The Worker answers Discord's slash commands itself at `/api/discord` (the Discord app's Interactions Endpoint URL), so no bot program has to run anywhere; every request is checked against the app's Ed25519 public key (`DISCORD_PUBLIC_KEY`) and a bad signature gets 401. Discord wants an answer within 3 seconds, so the reply is "thinking…" first and the result is edited in afterwards, shown only to the person who typed the command. `/register id:<box ID>` (anyone) puts the box on the allow list. `/register-app name:<name>` (anyone) asks for an app and posts the request to `DISCORD_ADMIN_WEBHOOK`; once an admin approves it with `/approve-app name:<name>`, which makes the app and its 50 box IDs, the same person running `/register-app` again gets `<name>-ids.csv` with the 50 IDs and keys, plus the app key; anyone else is told the name is taken. `/block app:` and `/unblock app:` turn an app off and on. Admin commands are hidden from everyone without Administrator, and the Worker also checks that the person has Administrator in the server set in `DISCORD_GUILD_ID`. A box that was sharing before networks were stored now counts toward the network it next asks from; if that network is already full, its tunnel is removed and its ID held until there's room or it's registered. *Why:* the Printer Buddy UI and the relay's errors already told people to use `/register` in the Discord, but there was no command; apps had no way to ask for their box IDs; and boxes from before had no network, so they never counted toward the one-box limit.

Lines changed:
- `worker.js` — 37 route `/api/discord`; 185 apps remember a waiting request and who asked; 452–566 `discordApi`, `discordSigned`, `discordReply`, `isAdmin`, `discordCommand` and `appPairs`; 662–680 the tunnel job counts the networks first, refuses an old box on a full network (tunnel removed, ID held) and stores its network otherwise; 767–785 add the `app-request` and `app-approve` jobs
- `README.md` — 16–17 old boxes and the network limit; 69–71 `DISCORD_PUBLIC_KEY`, `DISCORD_GUILD_ID`, `DISCORD_ADMIN_WEBHOOK`; 89–132 the Discord commands and how to set them up

################################end of entry################################

################################2026-11-25 sterling m security/dns-held################################

## Removing a tunnel only takes its own address; an offline box keeps its ID when a removal is retried

Removing or cutting a tunnel deletes the `u<ID>` address only if it still points to that tunnel, so an old job can no longer take away the address of the box's newer tunnel. When the hourly cleanup removes a box that has been offline for 4 days, it saves the held ID before deleting the tunnel, so a retry after a failed address step still keeps the ID for that box; if a retry finds the tunnel connected again, it leaves the box and drops that held ID. A box that removes its own tunnel without `hold` also drops a held ID saved that way, so the ID is free again. Boxes that never connected still get no held ID. *Why:* jobs can arrive out of order, so a late removal of an old tunnel deleted the new tunnel's address; and a retry after the tunnel was deleted couldn't tell the box had been offline, so a box from before box IDs lost its ID.

Lines changed:
- `worker.js` — 259 and 288 removing and cutting use `tunnelDns`; 594 `untunnel` without `hold` deletes any held ID too; 267–272 add `tunnelDns` (the address only if it points to that tunnel); 674–685 `remove-box` saves the held ID before deleting the tunnel and drops it if the tunnel connected again

################################end of entry################################

################################2026-11-25 sterling m security/queue-retries################################

## Asking again after "busy" gets the same answer; removals and cuts finish after a failure

A new box can send its own key to `/api/box` (`{"key": "<64 hex>"}`); asking again with that key gets the same ID instead of a second one, and doesn't count against the network's 5 per day again. An app's key now comes from `REGISTER_SECRET` and each of its box keys from the app's key, so asking `/api/app` or `/api/app/ids` again gets the same key and the same IDs and keys instead of "already registered" / "already got its box IDs" (an app registered with a different key still gets "already registered"). Making a tunnel first looks for a `pb-u<ID>` tunnel left from an earlier try whose record wasn't saved, and uses it instead of making a second one. Removing a tunnel reads it first: one already deleted goes straight to removing its address, so a retry can finish, and the error says which step failed ("The tunnel was removed, but its address couldn't be" when only the address step failed). Cutting a turned-off app's box marks it unfinished until the cut is done, and the hourly cleanup sends the cut again for every unfinished one. The hourly cleanup's removal job reads the tunnel again and leaves a box that connected since the check. A photo whose box ID was deleted by the daily cleanup at that moment is refused before the upload. The README and the queue entry below say "about 20 seconds" instead of "up to". *Why:* a request that got "busy" could leave a second box ID or a batch of app keys nobody received; a failed record write left a stranded tunnel; a DNS failure was reported as "still connected" and a retry couldn't finish; a cut that failed every try was dropped while the tunnel stayed reachable; and the cleanup could remove a tunnel that had just reconnected.

Lines changed:
- `worker.js` — 188 index on the box key; 209 `owner` says which table the ID came from; 215–232 `randomIds`, `freeOf` and `freeIds`; 234–238 `hmac`; 241–274 `getTunnel`, `removeTunnel` reads the tunnel first and names the failed step, `stale` (the hourly rule, shared with the removal job); 288–294 `makeTunnel` uses a leftover tunnel; 365–374 `/api/box` takes the box's own key and answers an ID it already has; 398–399, 416–435 `/api/app` and `/api/app/ids` give the same key and IDs again; 464–475 the hourly cleanup uses `stale` and sends the unfinished cuts again; 500 copied cuts count as unfinished; 582–598 `untunnel` names the failed step, the `box` job answers an ID the box key already has; 619–635 the `app` and `app-ids` jobs answer the same key and IDs; 654–678 `cut-box` marks the box unfinished until done, `remove-box` reads the tunnel again; 733–735 `contributeApi` refuses an ID deleted in between
- `README.md` — 8 a new box sends its own key; 21 about 20 seconds; 79–80 asking again gives the same app key, IDs and keys; 115–117 the new replies
- `CHANGELOG.md` — the queue entry says about 20 seconds

################################end of entry################################

################################2026-11-25 sterling m security/queue-d1################################

## Box IDs, tunnels, the allow list and apps move to D1, and every change runs through a one-at-a-time queue

Box IDs, tunnel records, held IDs, the allow list and apps are kept in a D1 database instead of KV. Every request that changes them (`/api/box`, `/api/tunnel`, `/api/register`, `/api/app`, `/api/app/ids`, `/api/app/off`, `/api/app/on`) is sent as a job to the `printer-buddy-jobs` queue, which runs one job at a time; the request waits about 20 seconds for the job's answer, and answers "busy, try again" if it doesn't come (the job still runs). Requests that can be refused straight away (wrong key, app turned off, daily ID limit, missing secret) are refused before using the queue. Slot counts are counted from the records instead of being kept as numbers, so they can't drift and the hourly recount is gone. A new box's key and an app's keys never go through the queue: the Worker makes them and the queue only sees their hashes. Turning an app off sends one job per box, and the hourly cleanup one job per tunnel it removes, so each box gets its own run and its own 50 Cloudflare calls; a removal that fails is tried again by the queue. `/api/app/off` now answers with how many boxes it's cutting instead of how many were removed, cut or failed. The first job after deploying copies the box records from KV into D1, 300 keys per job, before doing its own work; KV keeps the photo limits and AI stats, and its old records are left as they were. A photo sent during that copy gets "updating, try again". Removed: the re-check after writing a record, records marked as holding no slot, and the stored `count`, `net:` and `boxday:` counters. *Why:* KV can't check and change a value in one step, so two boxes setting up at the same moment on one network could both get through the limit, and an app turned off while one of its boxes was setting up needed checks and rollbacks to catch it. Turning off an app with more than about 16 boxes, or an hourly cleanup with more than about 16 tunnels to remove, ran out of the 50 Cloudflare calls one run is allowed on Workers Free.

Lines changed:
- `worker.js` — 34 `tunnelApi` no longer takes `ctx`; 82 the daily trigger sends the ID cleanup as a job; 86–96 the queue handler runs one job and acks it, or has the queue try it again; 177–208 the D1 tables, `ready`, the shared refusal messages and `owner` as one D1 query with the app's off switch; 214–225 `freeIds` picks free IDs with one query; 257–275 `queueJob`, `sendJobs` and `viaQueue` (sends a job and checks for its answer every 500 ms for up to 20 s); 277–382 `tunnelApi`, `boxApi`, `registerApi` and `appApi` check what they can in D1 and send the rest as jobs; 384–415 the hourly cleanup sends one job per box or tunnel to remove, plus one that deletes answers older than an hour; 417–459 `migrateStep` copies KV into D1 and `runJob` skips a job that already has an answer and saves each job's changes together with its answer; 461–619 the jobs (`tunnel`, `untunnel`, `box`, `register`, `app`, `app-ids`, `app-on`, `app-off`, `cut-box`, `remove-box`, `remove-tunnel`, `tidy`, `cleanup-ids`); 635–650 `contributeApi` checks the box ID and key in D1 and answers "updating" during the copy
- `wrangler.toml` — 30 KV now holds photo limits and AI stats; 35–50 add the D1 database `DB` and the `printer-buddy-jobs` queue (one job at a time)
- `README.md` — 20–22 the queue and its daily limit; 29–31 what `wrangler.toml` sets up and the copy from KV; 47 what KV holds; 59–60 the D1 and queue bindings; 81–82 the new `/api/app/off` and `/api/app/on` replies; 108, 115–116 the binding names and the "busy" and "updating" replies

################################end of entry################################

################################2026-11-25 sterling m security/tunnel-slots################################

## Box IDs from the relay, keys on every request, allow list, apps, slots given back, hourly cleanup

New boxes get their ID and key from the relay at install (`/api/box`), 5 new IDs per network per day (IPv6 counted per /64). A box from before this keeps its own ID by sending it (with its tunnel key if it has a tunnel). Tunnel requests and photos (`/api/contribute`) now need the ID's key; an ID the relay never handed out is refused. The Discord bot puts a box on the allow list with `/api/register` (protected by `REGISTER_SECRET`): a box on the list can share with up to 5 boxes on its network, any other box only when no other box on its network is sharing. Removing a tunnel gives its slot back (the 500 total and the network's count). A box can drop its tunnel with `hold: true` and keep its address; only the box with its key can get its tunnel back, with the same address, and it goes through the same network check as any other box. Every hour the Worker removes tunnels that never connected within an hour (fakes or failed setups), tunnels offline for 4 days, and leftover `pb-u` tunnels it has no record of, then recounts the slots; a box set up while the cleanup runs keeps its record, and a box whose tunnel couldn't be removed is still counted. Every day it deletes box IDs that were never used (no tunnel, no photo, not registered) 30 days after they were handed out. If setup fails after the tunnel is made, that tunnel is deleted instead of left behind. Removing a tunnel deletes the tunnel before its DNS record, so a removal refused because the tunnel is still connected no longer leaves the box without its address. The 5-new-per-IP-per-day tunnel limit is gone. Other programs that use the relay register as an app (`/api/app`, protected by `REGISTER_SECRET`), get their 50 box IDs once (`/api/app/ids`, with the app's own key), and each of those IDs remembers its app. Turning an app off (`/api/app/off`, back on with `/api/app/on`) refuses tunnels and photos for every ID it got and removes the tunnels its boxes have running (a tunnel still connected loses its address and routing); the off switch is its own record, so an app getting its IDs at that moment can't turn it back on. A box setting up at the moment its app is turned off checks the switch again after its record is written, and removes the tunnel it made if the app is off. A connected tunnel that is cut is marked, and gets its routing and address back the next time its box asks after the app is on again; if the app is turned off again during that, the box stays cut. If the tunnel a refused setup made can't be removed, it's cut and kept, so turning the app back on restores the same tunnel. When cutting actually deletes the tunnel, its record is removed too (and its slot freed), so the box isn't left pointing at a tunnel that no longer exists. A record kept from a refused setup is marked as holding no slot, so removing it never frees a slot it didn't take, and it takes its slot when it's restored. Turning an app off keeps a box whose tunnel could only be cut (still connected) marked cut with its slot, so it comes back on the same tunnel when the app is turned on again. *Why:* the slot count only ever went up and anyone could fill all 500 with made-up IDs, after which nobody could turn on sharing; and anyone could send photos under any ID. Apps couldn't be told apart, so one app's boxes couldn't be cut off without cutting off everyone.

Lines changed:
- `worker.js` — 35–37 routes `/api/box`, `/api/register` and the app routes; 82–83 run the ID cleanup with the daily report and the tunnel cleanup on the hourly trigger; 95–104 describe box IDs, the key and `hold`; 156–234 add `networkOf`, `netGet`, `owner`, `appOff`, `freeId`, `markUsed`, `freeSlot`, `removeTunnel`, `cutTunnel` and `makeTunnel`; 235–347 `tunnelApi` needs the ID's key, refuses IDs from an app that's turned off (again after the record is written), puts a cut tunnel's routing and address back and checks the switch again after that, checks held IDs and the network limit (allow list) for every new tunnel, frees the slot on removal, keeps the address on `hold: true`; 349–539 add `boxApi`, `registerApi`, `appApi` (off marks, cuts or removes running tunnels), `listAll`, `cleanupTunnels` and `cleanupIds`; 561–565 `contributeApi` needs the ID's key and refuses IDs from an app that's turned off
- `wrangler.toml` — 35, 37 add the hourly trigger at :30
- `README.md` — 5, 8–9 box IDs; 13–19 the new limits, cleanup and apps; 59–74 `REGISTER_SECRET`, `REGISTERED_PER_NETWORK`, `BOXES_PER_NETWORK_PER_DAY`, `APP_IDS`, how the bot registers a box and the app endpoints (`NEW_PER_IP_PER_DAY` removed); 80–105 test with a box ID and key, new replies; 86–95 the tunnel test uses the ID it got; 140, 143 the photo test sends a box ID and key

################################end of entry################################

################################2026-11-20 sterling m ai################################

## Stop collecting the retired "crack" label

`crack` is dropped from the accepted photo labels; a box still sending it gets a success reply and the photo is thrown away rather than stored. *Why:* the label is no longer trained on, and refusing it outright would stall every photo queued behind it on older boxes.

Lines changed:
- `worker.js` — 230–233 drop `crack` from `LABELS` and add `RETIRED_LABELS`; 244 answer a retired label "sent" and discard it

################################end of entry################################
