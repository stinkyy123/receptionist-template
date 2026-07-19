# BUILD-NOTES.md — everything the code won't tell you

This is the tribal-knowledge dump for the BlueTap receptionist. If you're a fresh
Claude Code session (or a human) picking this up cold, read this **before** touching
anything. The code is clean but a lot of the *why* — and the deploy landmines — live
only here. Every rule below exists because something broke; the incidents are noted.

Repo layout:
- `worker/src/index.js` — the entire backend, ~1300 lines, single file on purpose (latency + one deploy artifact).
- `worker/wrangler.toml` — Worker config + cron; documents secret names.
- `deploy_retell_v15.js` — pushes the prompt + tools to the Retell LLM and patches agent settings.
- `vapi_live_prompt_v15.txt` — the live agent prompt ("Taylor"). (The `vapi_` filename is legacy; this is a **Retell** agent now, not Vapi.)
- Gitignored & NOT in the repo: `patch_worker_url.js`, `worker/get_google_token.js` (both contain leaked creds), all legacy `*.json` dumps.

---

## 1. What this system is

A phone receptionist for a plumbing company. Flow:

```
Caller → Twilio number → Retell voice agent ("Taylor") → tool calls → Cloudflare Worker
                                                                          ├─ Google Calendar (events)
                                                                          ├─ Google Sheets  (VA work-queue, "Bookings" tab)
                                                                          ├─ Twilio         (confirmation / reminder / owner-alert SMS)
                                                                          └─ Smarty         (US address validation)
```

**Core design principle — internalize this, everything follows from it:** the bot's
job on the call is to *not break trust* — stay smooth, never loop, never interrogate,
never claim something it can't guarantee. **Correctness happens backstage.** The
`bookAppointment` tool returns to Retell **instantly** with a friendly message; all the
real work (address validation, flagging, calendar write, SMS, Sheets logging) runs
**asynchronously** via `ctx.waitUntil()` so it adds **zero** call latency. Precision is
moved off the unreliable voice channel onto the reliable, typed SMS channel.

The Worker *is* the product. Competitors sell the bot and leave verification to the
buyer; this backstage reliability layer is the moat.

---

## 2. Deploy gotchas — READ THIS or you will ship into the void

There are two independent deploy targets: the **Worker** (Cloudflare) and the **Retell
agent** (prompt + tools + voice). They deploy separately and have different traps.

### 2a. The Retell "publish + re-pin" dance (the #1 footgun)

Pushing the LLM with `deploy_retell_v15.js` **only updates the draft.** It does NOT
reach live callers by itself. Two more steps are required:

1. `node deploy_retell_v15.js` — pushes `general_prompt` + `general_tools` to the LLM, patches agent settings. Prints the new LLM version.
2. **Publish the agent:** `POST https://api.retellai.com/publish-agent/{agent_id}` with body `{}`.
3. **Re-pin the phone number to the newly published version** (see below).

**The v54 stale-version incident:** for a long stretch, every "deploy" appeared to
succeed but live calls kept running old behavior — tools "failing," the pre-fix prompt,
etc. Root cause: the phone number **hard-pins a specific integer `agent_version`** in
its `inbound_agents` config. It does **not** follow "latest published." So publishing a
new version changes nothing for callers until you repoint the number. The number was
stuck on v54 while we published v57…v63.

Re-pin command:
```
PATCH https://api.retellai.com/update-phone-number/+14346615712
{ "inbound_agents": [ { "agent_id": "agent_a0816d675497be6750760cf772", "agent_version": <INT>, "weight": 1 } ] }
```

Non-obvious facts about this:
- `agent_version` **must be an integer.** There is **no "latest published" option** — `null` is rejected.
- The old single-agent fields `inbound_agent_id` / `inbound_agent_version` are **DEPRECATED (2026-03-31)** and return a 400. You must use the `inbound_agents` array.
- **How to find the version to pin after publishing:** `GET /get-agent/{agent_id}` returns the current *draft* version number; the version you just published = **draft − 1**. Verify before pinning: `GET /get-agent/{agent_id}?version=<N>` and check `is_published: true` plus the prompt/tool contents.

**Bottom line:** every prompt / tool / voice change = push → publish → re-pin. Skip the
re-pin and you've shipped to a draft nobody calls.

### 2b. Prompt and Worker must deploy together

A prompt that expects new Worker behavior (e.g. the `addressConfirm` tool param, or the
`needCity` re-ask response) run against an **un-deployed** Worker is a silent mismatch —
the agent asks for things the Worker doesn't handle, or vice versa. **Deploy the Worker
first, then push Retell.** If you can only do one, don't leave the pair split across a
real call window.

### 2c. Cloudflare token expiry

`npx wrangler deploy` fails with an auth error (invalid token / code ~10000) when the
Cloudflare API token is expired/wrong. Fixes:
- Create a fresh token with the **"Edit Cloudflare Workers"** template (permission: Account → Workers Scripts → Edit).
- Set it as `CLOUDFLARE_API_TOKEN` in the deploy shell.
- **Token type matters:** `cfut_…` (Workers) tokens work. `cfat_…` (R2) tokens do **not** — they return "Invalid access token [code: 9109]". Been burned by this twice.

### 2d. Worker-only vs Retell-only changes

- Changes purely in `worker/src/index.js` (address logic, SMS copy, state machine) need **only** `cd worker && npx wrangler deploy`. No Retell publish/re-pin.
- Changes to the prompt or tool schema need the full Retell dance. Voice/turn-taking changes go through `deploy_retell_v15.js`'s agent PATCH (or a direct `update-agent` PATCH) + publish + re-pin.

### 2e. The exact sequence that works (full deploy)

```bash
# 1. Worker
cd worker && npx wrangler deploy               # needs CLOUDFLARE_API_TOKEN (cfut_ Workers token)
cd ..

# 2. Retell LLM + agent settings
RETELL_API_KEY=… TOOL_SECRET=… node deploy_retell_v15.js

# 3. Publish
curl -X POST -H "Authorization: Bearer $RETELL_API_KEY" \
  https://api.retellai.com/publish-agent/agent_a0816d675497be6750760cf772 -d '{}'

# 4. Find published version (draft-1), then re-pin the phone (see 2a)
```

---

## 3. Retell configuration reference

### Current production values (agent `agent_a0816…`, version 75)

| Setting | Value | Controlled by |
|---|---|---|
| LLM model | `claude-4.5-haiku`, temp 0 | deploy script (model itself set once in dashboard) |
| voice_id / voice_model | `cartesia-Andrew` / `sonic-3.5` | **dashboard only** |
| voice_speed / voice_temperature / volume | 0.98 / 0.42 / 1.2 | **dashboard only** |
| interruption_sensitivity | **0.3** | deploy script (overwrites) |
| responsiveness | **1** | deploy script (overwrites) |
| enable_backchannel | **false** | deploy script (overwrites) |
| ambient_sound | **none** | deploy script (overwrites) |
| backchannel_frequency | 0.6 | **dashboard only** |
| stt_mode | `fast` | **dashboard only** |
| denoising_mode | `noise-and-background-speech-cancellation` (max) | **dashboard only** |
| language | `en-US` | **dashboard only** |
| Prompt size | ~2,550 tokens (deliberately trimmed) | the prompt file |

### Why these values (the tradeoffs, with history)

- **interruption_sensitivity = 0.3 (the echo incident).** On real phone calls, the
  caller's phone echoes the agent's own greeting back into the line; Retell's transcriber
  reads that echo as the *caller* speaking ("Agent: Hey, thanks for calling / User: thanks
  for calling"), the agent thinks it was interrupted, and it **restarts the greeting** —
  a stutter loop. Lowering interruption sensitivity makes the agent plow through its own
  echo. **This is the echo ↔ talk-over dial and there is no free lunch:** lower = ignores
  echo but a real caller must speak clearly to cut in; higher = easy to interrupt but the
  agent yields to echo. History: v54 shipped 0.75; an early "fix" set 0.3 with
  responsiveness 0.7 (0.3 was right for echo, but 0.7 responsiveness added latency);
  briefly restored to 0.75 (echo came back on real calls) → settled at 0.3.
  **Real echo cancellation is device/carrier-side — you cannot fully fix it in Retell.**
  If 0.3 still stutters for a given tester, go lower (0.2) — there's a floor where the
  agent becomes nearly un-interruptible.
- **responsiveness = 1 (the latency incident).** Lowering it to 0.7 made the agent feel
  laggy. Keep it snappy. Current latency: end-to-end p50 ~1.3s, LLM p50 ~0.9s, TTS ~75ms.
  The prompt is kept trimmed (~2,550 tokens, down from ~3,400) to hold LLM latency down.
- **backchannel off / ambient off.** Backchannel ("mm-hm") and the coffee-shop ambient
  track both add agent-side audio that can feed the echo loop and muddy transcription.
  Off = cleaner.

### What the deploy script overwrites vs. what's dashboard-only

`deploy_retell_v15.js` **OVERWRITES on every run:** the LLM `general_prompt` +
`general_tools`, and the agent's `interruption_sensitivity`, `responsiveness`,
`enable_backchannel`, `ambient_sound`.

It does **NOT** touch: `voice_id`, `voice_model`, `voice_speed`, `voice_temperature`,
`volume`, `stt_mode`, `denoising_mode`, `backchannel_frequency`, `language`, the LLM
`model`.

**⚠️ WARNING:** if you hand-edit a *script-controlled* field in the Retell dashboard, the
next `node deploy_retell_v15.js` **silently reverts it.** Tune experimentally in the
dashboard, then **codify the winning values into the script** so they survive.

### The IDs you'll need

- Production agent: `agent_a0816d675497be6750760cf772`
- Production LLM: `llm_b87d28588b771499db90d726e1f7`
- Phone number: `+14346615712` (Twilio; sends AND receives SMS)
- **TEST clone** (safe experimentation): agent `agent_a26c2a0991d9067eb5c71477cd` + its own LLM `llm_5192338a42eda6719d598d7353d1`. It has its own LLM so you can change *anything* (model, prompt, voice, turn-taking) without touching production. Test it via the Retell dashboard **web-call** button (no phone number attached). **Caveat:** its tools still point at the live Worker, so test bookings write to the real Bookings sheet — ignore/delete those rows.
- Tool URLs carry the `TOOL_SECRET` in the path: `https://bluetap-receptionist.hbrks56.workers.dev/t/<TOOL_SECRET>`.

---

## 4. Design decisions and the incidents behind them

### Pending-hold booking state machine
Nothing is written to the calendar at call-end. The Sheets `status` column is the source
of truth:
```
pending ──YES reply──────────────→ hard-confirmed ─→ (calendar event created)
   │                                   
   ├──deadline + delivered + clean──→ soft-confirmed ─→ (calendar event created)
   │                                   
   └──any flag / bad reply / undelivered──→ flagged ─→ VA callback
   later: → cancelled | rescheduled (terminal)
```
**First-transition-wins:** every writer re-reads the row and acts only if it's still
`pending` (compare-and-set), which kills the reply-vs-timeout race (a YES arriving the
same moment the sweeper fires).

### Hard vs soft vs flagged tiers + routing (the two-case SMS split)
`flagged = hardFlags.length > 0`. Flag reasons are split:
- **SOFT flags** — `model_uncertain(<non-address fields>)`, `address_capture_mismatch`, `address_autocorrected`. These ride the **pending confirm-SMS path**: the customer gets a normal "You're booked! … reply yes" SMS *with the address*, and reading/replying IS the verification. A soft-flagged row still requires an explicit YES (it will not auto-soft-confirm on silence).
- **HARD flags** — `address_undeliverable`/`no_match`, `address_missing_city`, `phone_invalid`, `datetime_unparsed`, `name_missing`, `high_ticket_review`. These take the **callback path**: a "someone from our team will call you" SMS (no address to mistakenly confirm) + an owner "⚠️ Needs review" alert. No calendar.

That's the **two-case SMS split**: *validated-but-uncertain* → confirm SMS; *validation-failed* → callback SMS.

### Ask-address-twice with server-side comparison
The prompt asks for the address **twice** — but **asking twice is the capture protocol,
not the uncertainty signal.** Earlier the model self-reported `uncertainFields:["address"]`
on essentially *every* call (it can't reliably do a "silent compare"), routing everyone to
callback. Fix: the model passes the **first** capture as `address` and the **second** as
`addressConfirm`; the **Worker** compares them (`addressesMatch()`, which normalizes
Drive/Dr, case, punctuation, and spoken numbers). Only a real difference produces the soft
`address_capture_mismatch`. **The Worker ignores any `"address"` the model puts in
`uncertainFields`** — address uncertainty is decided server-side. (Phone uses the same
philosophy: a channel-check question, second ask only if a different number is given.)

### Spoken-number digitizing (the Fox Run `no_match` incident)
The transcriber renders a spoken house number as **words** — "two thirteen Fox Run Drive",
"two one three Fox Run Drive" — which Smarty can't parse → `no_match` → callback, even
though the caller said the address perfectly. `digitizeLeadingNumber()` / `spokenToDigits()`
convert a leading run of number-words to digits before validation and before the capture
comparison: digit-by-digit ("two one three"→213), paired ("two thirteen"→213), and
arithmetic ("two hundred thirteen"→213, "forty two hundred"→4200). This also collapses the
two differing spellings to the same "213", killing the false `address_capture_mismatch`.

### Default-state augmentation
Smarty needs **city + state** (or ZIP) to resolve; "213 Fox Run Drive, Lynchburg" with no
state returns `no_match`. Since the business serves one state, `withDefaultState()` appends
`BUSINESS.defaultState` ("VA") before validating, so callers only need street + city.

### Smarty policy (the Fox Run → Fox Runn snap incident)
If Smarty says the address is **deliverable**, its standardized form becomes the ONE
canonical address used everywhere. Tiers (gate purely on Smarty's dpv confidence):
- **Deliverable + `dpv === "Y"`** (USPS-confirmed EXACT deliverable point) → trust the standardization **fully, no flag** — even if the street spelling changed (spoken "Fox Run" → the real deliverable "Fox Runn Dr"). The confirm SMS still shows it for the customer to eyeball.
- **Deliverable but non-exact (`dpv` S/D)** → SOFT `address_autocorrected` → confirm-SMS readback (NOT a callback).
- **`no_match` / undeliverable** → HARD callback.

**This policy evolved twice (both from over-flagging).** First it was strict "adopt only on
exact `dpv==="Y"`, else keep spoken + flag a human" — which sent *every* booking to callback.
Then it required `dpv==="Y"` AND a street-token-preservation check (`addressPreserved()`) —
but that **still** false-flagged legit USPS corrections (spoken "Fox Run" → standardized
"Fox Runn Dr", dpv Y) as `address_autocorrected` on *every* call, so they never auto-confirmed
and pinged "needs review" on silence. Current rule: at `dpv==="Y"`, Smarty is authoritative —
trust it, no flag. (`addressPreserved()` is now unused but left defined.)

### One canonical address on every surface (the mismatch incident)
The customer's confirmation SMS once showed the **raw spoken** address while the
owner alert and calendar event showed the **validated** one — confusing and untrustworthy.
Now a single `canonicalAddress` feeds the customer SMS, the reminder SMS, owner alerts, and
the calendar event/location.

### Emergency calls NEVER touch the calendar (the 2 PM-booked incident)
A real emergency got written to the calendar as a normal next-day 2 PM appointment while
the caller was verbally promised a callback. Fix is **defense-in-depth**:
- **Prompt:** the EMERGENCY route uses `qualifyEmergency` ONLY and is forbidden from calling `checkAvailability`/`bookAppointment`, even if the caller mentions a time.
- **Server guardrail:** the top of `verifyBookingBackstage` scans `emergencyKeywords`; if a `bookAppointment` slips through with emergency wording, it reroutes to `logEmergency()` — owner 🚨 alert + an `emergency-flagged` queue row (priority 1) + a customer reassurance SMS, and **returns before any calendar/pending path.**
- The spoken promise was softened to "I'm sending your info to our emergency line right now — someone will call you back as fast as possible" (no "15 minutes" until an actual auto-call leg is built; today it's SMS-only to the owner).

### Reschedule ordering: create-then-supersede
On a reschedule, create the NEW calendar event first, THEN delete the prior one
(`supersedePriorBooking`). Ordered this way so a failure creating the new event never
leaves the caller with **no** appointment.

### Idempotent calendar write
`commitToCalendar()` re-reads the row's event-id cell (compare-and-set) before creating an
event. Prevents double-writes from the reply-vs-sweeper race or webhook retries.

### Availability: fail-closed + pending-aware
`checkAvailability` returns **busy** on any Calendar API error (never reports a slot free
just because the API was unreachable — an error body has no `items`, which would otherwise
look like an empty calendar), and it also treats unexpired `pending` rows as busy so a slot
isn't double-offered before it's confirmed.

### Endpoint security
- Tool calls require the secret path `/t/<TOOL_SECRET>` (bare root → 404).
- `/sms-reply` and `/sms-status` verify the Twilio `X-Twilio-Signature` (HMAC-SHA1 of URL + sorted params with `TWILIO_AUTH_TOKEN`); mismatch → 403.
- This matters under pending-hold: a spoofed inbound "YES" would otherwise transition a booking to hard-confirmed and **create a real calendar event.**

### Prompt discipline (small but load-bearing)
- **Never** mention tools, errors, retries, or delays to the caller ("technical hiccup" is banned) — keep talking, flag backstage.
- **Never** read back digits, address, or name to verify — the SMS does QA.
- Closing recap says lowercase **"reply yes"** — the cartesia TTS spells all-caps "YES" as "Y-E-S". (The SMS body keeps "Reply YES"; caps is fine in text.)

---

## 5. Sheets schema (the "Bookings" tab)

Columns A–X, mirrored in the `COL` map in `index.js`. Order matters — `appendBookingRow`
writes a positional 24-element array.

| Col | Field | Notes |
|---|---|---|
| A | timestamp | ISO, row creation |
| B | bookingId | UUID |
| C | callId | Retell call id |
| D | name | |
| E | phone | E.164 |
| F | service | |
| G | rawAddress | what the caller said (spoken) |
| H | stdAddress | the **canonical** address (Smarty standardized when deliverable) |
| I | addressStatus | Smarty dpv code / error |
| J | requestedDateTime | human-readable |
| K | startIso | UTC ISO |
| L | calendarEventId | empty until confirmed |
| M | status | pending / hard-confirmed / soft-confirmed / flagged / emergency-flagged / cancelled / rescheduled |
| N | flagged | "true"/"false" (hard flags only) |
| O | flagReasons | `;`-joined reason codes |
| P | smsSentAt | |
| Q | smsReplyAt | |
| R | smsReplyText | |
| S | notes | |
| T | confirmDeadline | ISO; now + `noReplyTimeoutMin` |
| U | deliveryStatus | Twilio callback: delivered/undelivered/… |
| V | priority | 1–6 for the VA to sort (1 = emergency/most urgent) |
| W | smsSid | to correlate delivery callbacks |
| X | reminderSentAt | second-touch reminder timestamp |

Flag priority order: 1 emergency/distress · 2 · 3 asked-for-human · 4 broken channel
(undelivered/bad phone) · 5 bad address · 6 uncertain/high-ticket. **Adding a column means
updating BOTH the sheet header row AND the `COL` map** (and the positional array in
`appendBookingRow`).

The sweeper runs on cron `*/5 * * * *` (`scheduled()` handler): pending past deadline →
soft-confirm (if delivered + clean) or flag; confirmed rows nearing the appointment → send
the reminder SMS (touch 2).

---

## 6. Known edge cases & fragile / unfinished

- **Reschedule** matches the caller's most recent **active** booking by **phone**.
  **Cancellation** matches by **name + day** and returns `success` / `notFound` /
  `ambiguous`. On >1 match it **refuses to guess** — it tells the caller the office will
  confirm, and it **never** claims an appointment is cancelled unless the tool returned
  `success`. (This was a real bug once: the bot told callers "cancelled" while never
  touching the calendar.)
- **`{{from_number}}` substitution.** The prompt passes `CALLER_PHONE={{from_number}}`
  (the deploy script rewrites `{{customer.number}}` → `{{from_number}}`). If the template
  ever arrives unsubstituted, `normalizePhone` sees no digits and falls back to the real
  `callFromNumber` Retell passes separately — so SMS still reaches the caller. Safe, but
  know it.
- **Digitizer edge:** a street that literally starts with a number-word and has **no**
  house number ("Seven Oaks Lane") would be mis-digitized ("7 Oaks Lane"). Rare, and the
  SMS readback catches it.
- **Echo** is mitigated (interruption 0.3) but not eliminated — it's device/carrier
  acoustic physics; denoising is already at max. A handset/headset sidesteps it.
- **Uncertain pending rows never auto-soft-confirm** on silence — they need an explicit
  YES or they flag at the deadline (never auto-book a doubtful address).
- **Diag route pattern:** during debugging, a temporary secured `GET /diag/<TOOL_SECRET>`
  route (returns the last few rows as JSON) is added, used, and then removed. It is
  currently **removed** — re-add it the same way if you need to inspect live rows, and
  delete it after.
- **✅ Schedule is now ENFORCED server-side (was prompt-text only).** `checkAvailability` reads
  `BUSINESS.schedule` and **fails closed**: a **closed day**, an hour outside **that day's**
  open/close window, a same-day request **past `sameDayCutoffH`**, or a same-day start **later
  than `latestSameDaySlotH`** all return busy — no matter what the model proposes. Offered
  alternatives are constrained to the same window. **Emergencies are unaffected**: they route
  through `qualifyEmergency` and never touch the calendar, so `emergencyOnlyDays` (e.g. Sunday)
  still works. Omit the `schedule` block entirely and the Worker falls back to
  `businessStartH`/`businessEndH` (the old behavior) — backward compatible.
  ⚠️ **This changed BlueTap's live behavior:** Sunday was silently bookable before and is now
  correctly refused, and the 4 PM same-day cutoff / 5 PM latest slot are now real. That is the
  intended fix, but it IS a production behavior change — deploy it through the normal gates.
  `minFee` / `minFeeWaivedWithRepair` remain prompt-text (they're quoting rules, not scheduling).
- **✅ `getDate` returns exact weekday→date mappings (the model can't do date math).** On a live
  call the LLM (Haiku) said *"tomorrow is Sunday"* when today WAS Sunday, and booked a Tuesday it
  called "Monday" — schedule-enforcement blocks the wrong *booking* but not the wrong *spoken*
  date. Fix: `handleGetDate` now returns `today` / `tomorrow` / `upcoming` (9 days, each with
  `weekday`, `date` YYYY-MM-DD, and `open` from `hoursForDate`), and the prompt says read them
  verbatim + only mention a closed-day/hours limit when the resolved day is actually `open:false`.
  Reuses `easternDateStr` + `hoursForDate`, so it's timezone- and schedule-correct for any client.
  NOTE: the WORKER half is deployed; the PROMPT half awaits a Retell push (see the LLM-wedge note
  below) — but the enriched `getDate` output alone already stops the mis-statement, since the
  model now receives `tomorrow:{weekday,date,open}` explicitly instead of computing it.
- **⚠️ Retell LLM/agent can wedge into "published, no draft" — `update-retell-llm` then 400s
  ("Cannot update published LLM") and `update-agent` 400s ("Cannot update published agent other
  than version title").** Rapid/interleaved publishes (e.g. two sessions, or a failed deploy
  racing a dashboard edit) can leave the head published with no editable draft, locking the API
  out. **Un-wedge by making ANY edit in the Retell dashboard** (that forks a fresh draft); the API
  works again after. The phone pin is unaffected — keep callers on the last good published version
  (BlueTap: v75) until you can push.
- **✅ Timezone is now client-driven (was hardcoded Eastern — a silent booking corruption).**
  `easternOffset()` used a hardcoded `"America/New_York"`, and `easternToUTC()` (which converts
  EVERY booking, availability check and cancellation) inherited it — while calendar events were
  written with `timeZone: BUSINESS.timezone`. For any non-Eastern client the two disagreed: a
  Phoenix caller asking for **2 PM** was booked at **18:00Z = 11 AM local — three hours early.**
  The offset now derives from `BUSINESS.timezone`. For an Eastern client this is a **no-op**
  (verified: EDT offset −4 and 2 PM → 18:00Z, unchanged). The `eastern*` function names are
  **legacy** — they are timezone-generic now; don't be fooled by the names.
  **DST is handled per booking date** (not "today"): `easternToUTC()` probes the *booking's*
  date via `Intl` in the target zone. Proven in `tests/dst.test.js` — a Chicago client booking
  either side of the Nov fall-back gets −5 then −6, so the same 2 PM maps to different UTC
  (a static offset lookup would silently book an hour off). **Boundary:** the probe samples
  **noon UTC** of the booking date, which for every US zone lands 2–8 AM local — same calendar
  day, *after* the 2 AM switch — so business-hours bookings are always correct. A 00:00–02:00
  local booking on a transition day (outside all business hours) and UTC+12-ish zones (where
  noon UTC falls on the next local date) are the only theoretical gaps.
- **Config-logic traps are checked, not prevented.** `validate-config.js` flags the two that bite:
  an `emergencyKeyword` that also names a normal service (that service becomes unbookable — the
  guardrail reroutes it), and a `highTicketKeyword` that matches a cheap job (the "$199 faucet
  swap" over-flagging footgun). Run it before every build; the decisions are the owner's.
- **Open items:** rotate the leaked **Retell API key** (hardcoded in the gitignored
  `patch_worker_url.js`, and pasted in chat) and the **Google OAuth secret** (gitignored
  `get_google_token.js`); delete cosmetic test rows in the Bookings sheet; the legacy n8n
  "Retell - BlueTap Receptionist" workflow is retired/fallback and left untouched.

---

## 7. Client-specific vs. generic (the template-extraction guide)

To reuse this for another business (or another trade), change only the client-specific
bits; the logic is universal.

**CLIENT-SPECIFIC — change per business:**
- The entire `BUSINESS` config block (`worker/src/index.js`, ~line 14): `name`, `shortName`, `apptNoun`, `ownerName`, `ownerPhone`, `calendarId`, `timezone`, `meetingMin`, `businessStartH`/`businessEndH`, `bufferMin`, `twilioFrom`, `defaultState`, `sheetTab`, `baseUrl`, `noReplyTimeoutMin`, `reminderLeadHours`, `highTicketKeywords`, `emergencyKeywords`, `serviceCities`.
- The prompt (`vapi_live_prompt_v15.txt`): identity/name, FACTS (hours, service area, ZIPs), PRICING, the service menu, and any business-specific off-path lines.
- The Retell voice choice; the agent/LLM IDs; the phone number; `SHEETS_ID` (in `wrangler.toml`); the Worker name; **all secrets**.

**GENERIC — reuse as-is:**
- The pending-hold state machine; hard/soft/flagged tiering + the two-case SMS split.
- Ask-twice + server-side comparison; the address helpers `digitizeLeadingNumber` / `spokenToDigits` / `withDefaultState` / `addressesMatch` / `addressHasLocality`.
- The Smarty validation flow and deliverable→confirm policy; one-canonical-address rule.
- The emergency server-side guardrail pattern; idempotent calendar write; fail-closed + pending-aware availability; the sweeper; endpoint auth + Twilio signature verification.
- The whole deploy dance.

**Trades-generic note:** `emergencyKeywords` and `highTicketKeywords` are plumbing-flavored
today. For HVAC/electrical, swap those keyword lists and the prompt's FACTS/PRICING/service
menu — the state machine and verification logic don't change. This was always intended to
be trade-agnostic (plumbing now, HVAC/electrical later).

---

## 8. Secrets — where they live (values are NEVER in this repo; it's public)

Set on the Worker via `wrangler secret put <NAME>`:
- `GOOGLE_SERVICE_ACCOUNT` — service-account JSON; RS256-signs a JWT for Calendar + Sheets.
- `TWILIO_SID`, `TWILIO_AUTH_TOKEN` — SMS send AND inbound-signature verification. **Rotate the auth token in Twilio and on the Worker together**, or `/sms-reply` and `/sms-status` start returning 403 (they verify signatures with it).
- `SMARTY_AUTH_ID`, `SMARTY_AUTH_TOKEN` — Smarty US Street API (the server-side "Secret Key", not the embedded key).
- `TOOL_SECRET` — gates `/t/…` and **must match** the secret baked into the tool URLs by the deploy script. Change one → change both.
- `DASHBOARD_SECRET` — gates the read-only client dashboard at `/d/…` (see §9). Generate one per client (`openssl rand -hex 24`); it's independent of `TOOL_SECRET`.

The deploy script reads `RETELL_API_KEY`, `TOOL_SECRET`, and optional `RETELL_AGENT_ID`
from the environment — never hardcode them.

Google access: share **both** the Google Sheet and the Calendar with the service-account
email `bluetap-worker@civil-willow-490515-p4.iam.gserviceaccount.com` (GCP project
`civil-willow-490515-p4`), or you'll get 403 PERMISSION_DENIED.

`.gitignore` excludes the two leaked-credential helper scripts (`patch_worker_url.js`,
`worker/get_google_token.js`) and all legacy `*.json` dumps. **Never** commit secret
values — this repo is public.

---

## 9. Client dashboard (`/d/<DASHBOARD_SECRET>`)

A read-only, client-facing dashboard the owner opens from their phone. **Additive** — a new
GET branch in the router + new functions; it touches none of the booking / state-machine /
tool logic. **It never writes.**

- **Auth:** same secret-path pattern as `/t/`. `GET /d/<DASHBOARD_SECRET>` (constant-time compare);
  wrong/absent secret → 401. The secret is a Worker secret (`wrangler secret put DASHBOARD_SECRET`),
  never in the committed config.
- **What it shows (outcomes only, never mechanics):** revenue captured this month
  (confirmed+completed jobs × `BUSINESS.avgTicket`), calls handled + jobs booked (week/month with a
  same-portion trend), after-hours saves, emergencies escalated, and a recent-bookings list. Windows
  are keyed on the **call date** (row timestamp) in `BUSINESS.timezone`.
- **`dashHumanStatus` is the only place internal states become words** (hard/soft-confirmed →
  "Confirmed", completed → "Completed", flagged/pending → "Being confirmed", cancelled → "Cancelled").
  Unknown status → "Being confirmed" so a raw internal name can never leak. The page renders **no**
  status codes, flags, tiers, addresses, notes, or VA-queue terms. Adding a stat? Keep this invariant.
- **`avgTicket`** is a new `BUSINESS`/config field (dashboard revenue only — not used by booking/voice).
- **Cache:** the sheet READ is cached ~5 min per isolate (`_dashRows`); stats + HTML recompute each
  request so the windows stay live. The page also self-refreshes every 5 min (`<meta refresh>`).
- **`computeDashboardStats` + `renderDashboardHtml` are pure and exported** so the local preview runs
  the exact same code (no drift). Preview + demo:
  `node render.js <client> && node tools/preview-dashboard.js <client> [--now=YYYY-MM-DD]`
  → writes `clients/<client>/dist/dashboard-preview.html`. Seed fixture: `clients/<client>/demo-bookings.json`
  (relative-dated so it stays evergreen; **not** production data — the live worker reads the real sheet).
- **Deploy = worker-only** (§2d): `wrangler secret put DASHBOARD_SECRET` then `wrangler deploy`. No
  Retell push/publish/re-pin. Deliver the `/d/<secret>` link to the owner at handover.
