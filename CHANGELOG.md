# Changelog

All changes to the printerbuddy.stream Worker, newest first.

################################2026-11-20 sterling m ai################################

## Stop collecting the retired "crack" label

`crack` is dropped from the accepted photo labels; a box still sending it gets a success reply and the photo is thrown away rather than stored. *Why:* the label is no longer trained on, and refusing it outright would stall every photo queued behind it on older boxes.

Lines changed:
- `worker.js` — 230–233 drop `crack` from `LABELS` and add `RETIRED_LABELS`; 244 answer a retired label "sent" and discard it

################################end of entry################################
