// ============================================================================
// @@brand@@ Receptionist Worker  (reliability layer)
// Retell -> this Worker -> Google Calendar + Sheets (VA queue) + Twilio + USPS
//
// Design principle: the bot's job is to NOT break trust during the call.
// Correctness happens backstage. The bookAppointment tool returns to Retell
// INSTANTLY; all verification (USPS address check, flagging, calendar write,
// Sheets logging, the "Reply YES" SMS) runs asynchronously via ctx.waitUntil()
// so it never adds call latency.
//
// Business specifics live in BUSINESS so this is reusable across trades.
// ============================================================================

const BUSINESS = {
  name: "@@name@@",
  shortName: "@@shortName@@",
  apptNoun: "@@apptNoun@@",
  ownerName: "@@ownerName@@",
  ownerPhone: "@@ownerPhone@@",
  calendarId: "@@calendarId@@",
  timezone: "@@timezone@@",
  meetingMin: @@meetingMin@@,
  businessStartH: @@businessStartH@@,
  businessEndH: @@businessEndH@@,
  bufferMin: @@bufferMin@@,
  twilioFrom: "@@twilioFrom@@",      // number we send from AND receive replies on
  defaultState: "@@defaultState@@",
  sheetTab: "@@sheetTab@@",
  baseUrl: "@@baseUrl@@",
  noReplyTimeoutMin: @@noReplyTimeoutMin@@,           // pending window before soft-confirm/flag
  reminderLeadHours: @@reminderLeadHours@@,            // send the reminder SMS this long before the appt
  // services that always warrant a human glance before dispatch (high ticket).
  // NOTE: bare "replacement" was removed — it flagged $199 faucet/toilet swaps;
  // the genuinely expensive jobs are covered by the specific keywords below.
  highTicketKeywords: @@highTicketKeywords@@,
  // an emergency must NEVER land on the calendar as a normal booking — if any of
  // these surface in a bookAppointment call, the backstage guardrail reroutes it
  emergencyKeywords: @@emergencyKeywords@@,
  // service-area localities — used to detect whether an address carries a city so
  // Smarty can exact-match it (a bare street routes everything to the callback path)
  serviceCities: @@serviceCities@@
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET") {
      return new Response("@@brand@@ Receptionist Worker running", { status: 200 });
    }
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    // --- Inbound Twilio webhooks (signature-verified inside handlers) -------
    if (url.pathname === "/sms-reply")  return handleSmsReply(request, env, ctx);
    if (url.pathname === "/sms-status") return handleSmsStatus(request, env, ctx);

    // --- Retell tool calls: authenticated secret path /t/<TOOL_SECRET> ------
    if (url.pathname.startsWith("/t/")) {
      const provided = url.pathname.slice(3);
      if (!env.TOOL_SECRET || !timingSafeEqual(provided, env.TOOL_SECRET)) {
        return new Response("Unauthorized", { status: 401 });
      }
      return handleToolCall(request, env, ctx);
    }

    return new Response("Not Found", { status: 404 });
  },

  // --- Cloudflare Cron: no-reply confirmation sweeper -----------------------
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sweepUnconfirmedBookings(env));
  }
};

function respond(data) {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" }
  });
}

// Constant-time string compare (avoids leaking secret length via timing).
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

// Verify Twilio's X-Twilio-Signature: base64(HMAC-SHA1(authToken, url + sorted k+v)).
async function verifyTwilioSignature(request, env, params) {
  const sig = request.headers.get("X-Twilio-Signature");
  if (!sig || !env.TWILIO_AUTH_TOKEN) return false;
  let data = request.url;
  for (const k of Object.keys(params).sort()) data += k + params[k];
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.TWILIO_AUTH_TOKEN),
    { name: "HMAC", hash: "SHA-1" }, false, ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return timingSafeEqual(sig, expected);
}

async function formToObject(request) {
  const obj = {};
  try {
    const form = await request.formData();
    for (const [k, v] of form.entries()) obj[k] = typeof v === "string" ? v : "";
  } catch {}
  return obj;
}

async function handleToolCall(request, env, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return respond({ result: JSON.stringify({ error: "Invalid JSON body" }) });
  }

  const toolName = body.name || body.toolName || "";
  const params = body.args || body.parameters || {};
  // Retell injects caller ID in the call object — fallback when LLM passes bad phone
  const callFromNumber = body.call?.from_number || body.from_number || null;
  const callId = body.call?.call_id || body.call_id || body.toolCallId || "unknown";

  let result;
  try {
    switch (toolName) {
      case "getDate":           result = handleGetDate(); break;
      case "checkAvailability": result = await handleCheckAvailability(params, env); break;
      case "bookAppointment":   result = handleBookAppointment(params, env, ctx, callFromNumber, callId); break;
      case "qualifyEmergency":  result = await handleQualifyEmergency(params, env, callFromNumber); break;
      case "cancelAppointment": result = await handleCancelAppointment(params, env); break;
      case "takeMessage":       result = await handleTakeMessage(params, env, callFromNumber); break;
      default:                  result = { error: `Unknown tool: ${toolName}` };
    }
  } catch (e) {
    result = { error: e.message };
  }
  return respond({ result: JSON.stringify(result) });
}

// ============================================================================
// GOOGLE AUTH (service account JWT -> access token). Scope now includes Sheets.
// ============================================================================
async function getGoogleToken(env) {
  const sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT);
  const now = Math.floor(Date.now() / 1000);

  const b64url = obj => btoa(JSON.stringify(obj))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

  const header = b64url({ alg: "RS256", typ: "JWT" });
  const payload = b64url({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  });

  const signingInput = `${header}.${payload}`;

  const pemContent = sa.private_key
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\n/g, "");

  const keyBytes = Uint8Array.from(atob(pemContent), c => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8", keyBytes.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false, ["sign"]
  );

  const sigBytes = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", cryptoKey,
    new TextEncoder().encode(signingInput)
  );

  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBytes)))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${signingInput}.${sig}`
    })
  });

  const tokenData = await tokenResp.json();
  if (!tokenData.access_token) throw new Error("Service account auth failed: " + JSON.stringify(tokenData));
  return tokenData.access_token;
}

// ============================================================================
// TIME / DATE HELPERS  (unchanged logic)
// ============================================================================
function easternOffset(utcDate) {
  const noonUTC = new Date(Date.UTC(
    utcDate.getUTCFullYear(), utcDate.getUTCMonth(), utcDate.getUTCDate(), 12, 0, 0
  ));
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "numeric", hour12: false
  }).formatToParts(noonUTC);
  const easternNoon = parseInt(parts.find(p => p.type === "hour")?.value || "8");
  return easternNoon - 12;
}

function easternToUTC(dateStr, timeStr) {
  const [year, month, day] = dateStr.split("-").map(Number);
  const [hours, minutes] = timeStr.split(":").map(Number);
  const approx = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const offset = easternOffset(approx);
  return new Date(Date.UTC(year, month - 1, day, hours - offset, minutes, 0));
}

function parseTextDateTime(text) {
  const lc = text.toLowerCase();
  const weekdays = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
  const months = ["january","february","march","april","may","june","july","august","september","october","november","december"];

  const now = new Date();
  const offset = easternOffset(now);
  const localNow = new Date(now.getTime() + offset * 3600000);

  let base = new Date(localNow);
  base.setHours(0, 0, 0, 0);

  if (lc.includes("tomorrow")) {
    base = new Date(base.getTime() + 86400000);
  } else if (!lc.includes("today")) {
    const monthMatch = lc.match(new RegExp(`(${months.join("|")})\\s+(\\d{1,2})`));
    if (monthMatch) {
      const mIdx = months.indexOf(monthMatch[1]);
      const d = parseInt(monthMatch[2]);
      base = new Date(localNow.getFullYear(), mIdx, d, 0, 0, 0, 0);
      if (base < localNow) base.setFullYear(localNow.getFullYear() + 1);
    } else {
      for (let i = 1; i <= 7; i++) {
        const d = new Date(localNow.getTime() + i * 86400000);
        if (lc.includes(weekdays[d.getDay()])) {
          base = new Date(base.getTime() + i * 86400000);
          break;
        }
      }
    }
  }

  let hour = 9, minute = 0;
  const m = lc.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (m) {
    hour = (+m[1]) % 12;
    minute = m[2] ? +m[2] : 0;
    if (m[3] === "pm") hour += 12;
    else if (!m[3] && +m[1] <= 7) hour += 12;
  }

  const startLocal = new Date(base);
  startLocal.setHours(hour, minute, 0, 0);
  return new Date(startLocal.getTime() - offset * 3600000);
}

// "YYYY-MM-DD" for the given instant, in business-local time.
function easternDateStr(d) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS.timezone, year: "numeric", month: "2-digit", day: "2-digit"
  }).format(d);
}

function formatDisplay(dateUTC) {
  const displayDate = dateUTC.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: BUSINESS.timezone });
  const displayTime = dateUTC.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: BUSINESS.timezone });
  return `${displayDate} at ${displayTime}`;
}

// Normalize phone to E.164; returns null if clearly unusable
function normalizePhone(rawPhone, fallback = null) {
  let digits = (rawPhone || "").replace(/\D/g, "");
  if (digits.length < 10 && fallback) {
    digits = (fallback || "").replace(/\D/g, "");
  }
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  if (digits.length >= 10) return "+" + digits;
  return null;
}

// ============================================================================
// SIMPLE SYNCHRONOUS TOOLS
// ============================================================================
function handleGetDate() {
  const now = new Date();
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true
  }).format(now);
  return { nowIso: now.toISOString(), localTime: formatted, timezone: "America/New_York" };
}

async function handleCheckAvailability(params, env) {
  const { requestedDate, requestedTime, estimatedDuration = BUSINESS.meetingMin } = params;
  if (!requestedDate || !requestedTime) return { error: "requestedDate and requestedTime required" };

  const requestedStart = easternToUTC(requestedDate, requestedTime);
  const requestedEnd = new Date(requestedStart.getTime() + estimatedDuration * 60000);
  const dayStart = easternToUTC(requestedDate, "00:00");
  const dayEnd = easternToUTC(requestedDate, "23:59");

  const token = await getGoogleToken(env);
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(BUSINESS.calendarId)}/events?` +
    new URLSearchParams({ timeMin: dayStart.toISOString(), timeMax: dayEnd.toISOString(), singleEvents: "true", orderBy: "startTime" });

  const eventsResp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  // FAIL CLOSED. Never report a slot free just because the calendar is unreachable —
  // an error body has no `items`, which would otherwise look like an empty calendar.
  if (!eventsResp.ok) {
    return {
      error: "calendar_unavailable",
      available: false,
      message: "I can't reach the calendar right now — take the caller's preferred window and have the office confirm."
    };
  }
  const eventsData = await eventsResp.json();
  if (!Array.isArray(eventsData.items)) {
    return {
      error: "calendar_unavailable",
      available: false,
      message: "I can't reach the calendar right now — take the caller's preferred window and have the office confirm."
    };
  }
  const events = eventsData.items.filter(e => e.start?.dateTime);

  // Treat still-holding PENDING bookings (not yet on the calendar) as busy,
  // until their confirm_deadline passes — prevents offering one slot twice.
  const busyIntervals = events.map(e => ({ start: e.start.dateTime, end: e.end.dateTime }));
  try {
    if (env.SHEETS_ID) {
      const rows = await sheetsGetAll(env, token);
      const nowMs = Date.now();
      for (const r of rows) {
        if ((r[COL.status] || "").toLowerCase() !== "pending") continue;
        const dl = Date.parse(r[COL.confirmDeadline] || "");
        const sMs = Date.parse(r[COL.startIso] || "");
        if (!dl || dl < nowMs || !sMs) continue;
        busyIntervals.push({ start: r[COL.startIso], end: new Date(sMs + BUSINESS.meetingMin * 60000).toISOString() });
      }
    }
  } catch {}

  const offset = easternOffset(requestedStart);
  const localStartH = new Date(requestedStart.getTime() + offset * 3600000).getUTCHours() +
    new Date(requestedStart.getTime() + offset * 3600000).getUTCMinutes() / 60;
  const localEndH = new Date(requestedEnd.getTime() + offset * 3600000).getUTCHours() +
    new Date(requestedEnd.getTime() + offset * 3600000).getUTCMinutes() / 60;

  if (localStartH < BUSINESS.businessStartH || localEndH > BUSINESS.businessEndH) {
    return { available: false, message: `We schedule between 7 AM and 7 PM Eastern.` };
  }

  const BUFFER_MS = BUSINESS.bufferMin * 60000;
  function hasConflict(evtStart, evtEnd, reqStart, reqEnd) {
    return (new Date(evtStart).getTime() - BUFFER_MS) < reqEnd.getTime() &&
           (new Date(evtEnd).getTime() + BUFFER_MS) > reqStart.getTime();
  }

  const busy = busyIntervals.filter(iv => hasConflict(iv.start, iv.end, requestedStart, requestedEnd));
  if (busy.length === 0) {
    return { available: true, message: `Yes, ${requestedDate} at ${requestedTime} is available.` };
  }

  const alternatives = [];
  for (let min = BUSINESS.businessStartH * 60; min <= BUSINESS.businessEndH * 60 - estimatedDuration; min += 30) {
    const h = String(Math.floor(min / 60)).padStart(2, "0");
    const m2 = String(min % 60).padStart(2, "0");
    const cStart = easternToUTC(requestedDate, `${h}:${m2}`);
    const cEnd = new Date(cStart.getTime() + estimatedDuration * 60000);
    const free = !busyIntervals.some(iv => hasConflict(iv.start, iv.end, cStart, cEnd));
    if (free) {
      alternatives.push({
        time: cStart.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/New_York" })
      });
      if (alternatives.length >= 3) break;
    }
  }

  return { available: false, message: "That slot is not available.", alternatives };
}

// ============================================================================
// bookAppointment — respond INSTANTLY, verify in the background
// ============================================================================
function handleBookAppointment(params, env, ctx, callFromNumber, callId) {
  // Soft-capture only. NEVER reject the caller — best-guess + flag downstream.
  const name = (params.name || "").trim();
  const phone = normalizePhone(params.phone, callFromNumber);
  const address = (params.address || "").trim();
  const addressConfirm = (params.addressConfirm || "").trim();

  // City guard (defense-in-depth with the prompt): a street with no city/town
  // can't be exact-matched by Smarty, so it would route every booking to the
  // callback path. Re-ask for the city instead of booking a resolvable-less
  // address. This is the ONLY thing that blocks the instant booking response.
  if (address && !addressHasLocality(address)) {
    return {
      success: false,
      needCity: true,
      message: "Got it — and what city or town is that address in?"
    };
  }

  const service = (params.service || "Service call").trim();
  const notes = params.notes || "";
  const uncertainFields = Array.isArray(params.uncertainFields) ? params.uncertainFields : [];

  let startUTC;
  if (params.requestedDate && params.requestedTime) {
    startUTC = easternToUTC(params.requestedDate, params.requestedTime);
  } else if (params.requestedText) {
    startUTC = parseTextDateTime(params.requestedText);
  } else {
    startUTC = null;
  }

  const booking = {
    bookingId: crypto.randomUUID(),
    callId,
    name, phone, address, addressConfirm, service, notes, uncertainFields,
    startUTC: startUTC ? startUTC.toISOString() : null,
    displayDateTime: startUTC ? formatDisplay(startUTC) : (params.requestedText || "time TBD"),
    rawRequestedText: params.requestedText || ""
  };

  // Run all verification AFTER we respond — zero added call latency.
  ctx.waitUntil(verifyBookingBackstage(booking, env));

  // Immediate, trust-preserving response to Retell. Nothing is booked yet —
  // the caller is told a confirmation text is coming (pending-hold model).
  return {
    success: true,
    message: `Perfect${name ? ", " + name.split(" ")[0] : ""} — I'm sending your confirmation text right now.`
  };
}

async function verifyBookingBackstage(b, env) {
  try {
    // EMERGENCY GUARDRAIL: if the model misrouted an emergency into a booking,
    // never let it reach the calendar. Reroute to the emergency path and stop.
    const emgHay = `${b.service} ${b.notes} ${b.rawRequestedText}`.toLowerCase();
    if (BUSINESS.emergencyKeywords.some(k => emgHay.includes(k))) {
      await logEmergency(env, {
        name: b.name, phone: b.phone, address: b.address, service: b.service,
        description: b.notes || b.rawRequestedText || b.service, severity: "critical"
      });
      return;
    }

    const flagReasons = [];

    // --- Address validation (Smarty) --------------------------------------
    // Digitize a spoken house number ("two thirteen" -> "213") before validating.
    const spokenAddr = digitizeLeadingNumber(b.address);
    let usps = { checked: false, deliverable: false, dpv: "", standardized: "", error: "no_address" };
    if (spokenAddr && spokenAddr.length >= 5) {
      usps = await validateAddressSmarty(withDefaultState(spokenAddr), env);
    } else {
      flagReasons.push("address_missing_or_too_short");
    }
    if (usps.checked && !usps.deliverable) {
      flagReasons.push(`address_undeliverable(${usps.dpv || usps.error || "no_match"})`);
    }

    // Canonical address: if Smarty says the address is DELIVERABLE, use its
    // standardized form as the ONE version on every surface. An exact match
    // (dpv "Y", no new street token) is fully clean. A deliverable address that
    // Smarty auto-corrected (e.g. Run->Runn) is only SOFT-flagged — the customer
    // verifies it by reading the standardized address in the confirm SMS, not via
    // a callback. Only an UNRESOLVABLE address (no_match/undeliverable, flagged
    // above) keeps the spoken value and takes the human-callback path.
    let canonicalAddress = spokenAddr;
    if (usps.checked && usps.deliverable) {
      canonicalAddress = usps.standardized;
      // dpv "Y" = USPS-confirmed EXACT deliverable point: trust Smarty's
      // standardization fully (e.g. spoken "Fox Run" -> real "Fox Runn Dr"),
      // no flag — the confirm SMS still shows it for the customer to eyeball.
      // Only a non-exact deliverable (dpv S/D) is soft-flagged for confirmation.
      if (usps.dpv !== "Y") {
        flagReasons.push(`address_autocorrected(${usps.standardized})`);
      }
    }

    // --- Heuristic hard flags ---------------------------------------------
    if (!b.phone) flagReasons.push("phone_invalid");
    if (!b.startUTC) flagReasons.push("datetime_unparsed");
    if (!b.name || b.name.length < 2) flagReasons.push("name_missing");
    if (b.address && !addressHasLocality(b.address)) flagReasons.push("address_missing_city");
    // Address uncertainty is decided HERE, not by the model. Asking twice is the
    // capture protocol; only a real mismatch between the two captures (after
    // normalizing Drive/Dr etc.) is the uncertainty signal. Ignore any "address"
    // the model put in uncertainFields; still honor its other self-reports.
    if (b.addressConfirm && !addressesMatch(b.address, b.addressConfirm)) {
      flagReasons.push("address_capture_mismatch");
    }
    const otherUncertain = (b.uncertainFields || []).filter(f => f.toLowerCase() !== "address");
    if (otherUncertain.length) flagReasons.push("model_uncertain(" + otherUncertain.join(",") + ")");
    const svcLc = (b.service || "").toLowerCase();
    if (BUSINESS.highTicketKeywords.some(k => svcLc.includes(k))) flagReasons.push("high_ticket_review");

    // HARD vs SOFT flags. Soft = model-reported uncertainty on data that still
    // validated (e.g. ask-twice address mismatch, but Smarty exact-matched) — it
    // rides the confirm-SMS pending path; the customer reading the typed address
    // IS the verification. Hard = a real failure → human-callback path, no SMS
    // the customer could mistakenly confirm.
    const isSoft = r => r.startsWith("model_uncertain") || r === "address_capture_mismatch"
      || r.startsWith("address_autocorrected");
    const hardFlags = flagReasons.filter(r => !isSoft(r));
    const flagged = hardFlags.length > 0;
    const uncertain = flagReasons.some(isSoft);   // recorded for the sweeper
    const nowIso = new Date().toISOString();
    const token = await getGoogleToken(env);

    // PENDING-HOLD: nothing is written to the calendar here. The calendar write
    // happens only on hard-confirm (YES reply) or soft-confirm (clean deadline).
    let status, confirmDeadline = "", priority = 0;
    if (flagged) {
      status = "flagged";
      priority = flagPriority(hardFlags);
    } else {
      // Clean OR soft-uncertain: both take the pending confirm-SMS path. The
      // uncertainty is preserved in flagReasons so the sweeper won't silently
      // auto-confirm it without an explicit YES.
      status = "pending";
      confirmDeadline = new Date(Date.now() + BUSINESS.noReplyTimeoutMin * 60000).toISOString();
    }

    // Reschedule: retire the caller's prior active booking now (removes its
    // calendar event if it had one). The new booking is still just pending.
    if (/reschedule/i.test(b.notes || "") && b.phone) {
      try { await supersedePriorBooking(env, b.phone, b.bookingId); }
      catch (e) { flagReasons.push("reschedule_supersede_failed"); }
    }

    // Write the row FIRST (source of truth) so any fast delivery/reply callback
    // can find it. smsSentAt + smsSid are patched in after the SMS is sent.
    await appendBookingRow(env, [
      nowIso, b.bookingId, b.callId, b.name, b.phone || "", b.service,
      b.address, canonicalAddress || "", usps.dpv || usps.error || "",
      b.displayDateTime, b.startUTC || "", "",                 // L calendarEventId (empty)
      status, String(flagged), flagReasons.join("; "),
      "", "", "", b.notes || "",                               // smsSentAt/Reply/Text, notes
      confirmDeadline, "", priority ? String(priority) : "", "", ""  // T-X
    ]);

    if (flagged) {
      // No calendar write. VA works it from the queue and calls the customer.
      // Courtesy text (not a booking confirmation) so the promised text still lands.
      if (b.phone) {
        try {
          await sendSms(
            b.phone,
            `${BUSINESS.name}: got your request for ${b.service}. Someone from our team will call you shortly to lock in the details.`,
            env
          );
        } catch {}
      }
      await sendSms(
        BUSINESS.ownerPhone,
        `⚠️ Needs review — call this customer, nothing is booked yet.\n\n` +
        `${b.name || "(no name)"} — ${b.service}\nWhen: ${b.displayDateTime}\n` +
        `Phone: ${b.phone || "(invalid)"}\nSaid: ${b.address || "(none)"}\n` +
        `Address check: ${usps.standardized || usps.error || "no match"}\n` +
        `Why: ${flagReasons.join("; ")}`,
        env
      );
      return;
    }

    // PENDING: send the 2-door confirm SMS with a delivery callback, then stamp
    // smsSentAt + smsSid onto the row so /sms-status can correlate delivery.
    if (b.phone) {
      const sid = await sendSms(
        b.phone,
        `${BUSINESS.name}: You're booked! ${b.service} on ${b.displayDateTime}` +
        `${canonicalAddress ? ` — ${canonicalAddress}` : ""}.\n\n` +
        `Reply YES to confirm, or call ${BUSINESS.ownerPhone} if anything needs changing.`,
        env,
        BUSINESS.baseUrl + "/sms-status"
      );
      const rows = await sheetsGetAll(env, token);
      const idx = rows.findIndex(r => r[COL.bookingId] === b.bookingId);
      if (idx !== -1) {
        const rr = idx + 2;
        await sheetsPutRange(env, token, `${BUSINESS.sheetTab}!P${rr}`, [[nowIso]]); // smsSentAt
        await sheetsPutRange(env, token, `${BUSINESS.sheetTab}!W${rr}`, [[sid]]);     // smsSid
      }
    }
  } catch (e) {
    // Last-ditch: make sure a dropped booking is still visible to a human.
    try {
      await sendSms(
        BUSINESS.ownerPhone,
        `⚠ BOOKING PIPELINE ERROR - ${BUSINESS.name}\n${b.name || ""} ${b.phone || ""} ${b.displayDateTime}\n${e.message}`,
        env
      );
    } catch {}
  }
}

// Only called on confirmation (hard/soft). Writes a clean event with full job
// context in the title so a naked calendar slot never reaches the tech.
async function createCalendarEvent(b, addressForRecords, env, token, confirmTier) {
  const startUTC = new Date(b.startUTC);
  const endUTC = new Date(startUTC.getTime() + BUSINESS.meetingMin * 60000);
  const plainStatus = confirmTier === "soft-confirmed" ? "confirmed (auto)" : "confirmed";
  const tierLabel = confirmTier === "hard-confirmed" ? "confirmed by customer"
    : confirmTier === "soft-confirmed" ? "auto-confirmed (text delivered, no reply)"
    : "confirmed";
  const summary = `${b.service} — ${b.name} — ${plainStatus}`;
  const desc =
    `${BUSINESS.name} — ${tierLabel}\n\n` +
    `Customer: ${b.name}\nPhone: ${b.phone}\nService: ${b.service}\n` +
    `Address (spoken): ${b.address}\nAddress (verified): ${addressForRecords}\n\n` +
    `Scheduled: ${b.displayDateTime}\nNotes: ${b.notes || "None"}\n` +
    `\n--- AI Receptionist (bookingId ${b.bookingId})`;

  const resp = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(BUSINESS.calendarId)}/events`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        summary,
        location: addressForRecords,
        description: desc,
        start: { dateTime: startUTC.toISOString(), timeZone: BUSINESS.timezone },
        end: { dateTime: endUTC.toISOString(), timeZone: BUSINESS.timezone },
        colorId: confirmTier === "soft-confirmed" ? "5" : "10"  // 5=banana (soft), 10=green (hard)
      })
    }
  );
  if (!resp.ok) {
    throw new Error("calendar_create_failed_" + resp.status + ": " + (await resp.text()).slice(0, 120));
  }
  const data = await resp.json();
  return data.id || "";
}

// ===== Bookings row column map (0-based within A..X) =====
const COL = {
  timestamp:0, bookingId:1, callId:2, name:3, phone:4, service:5, rawAddress:6,
  stdAddress:7, addressStatus:8, requestedDateTime:9, startIso:10, calendarEventId:11,
  status:12, flagged:13, flagReasons:14, smsSentAt:15, smsReplyAt:16, smsReplyText:17,
  notes:18, confirmDeadline:19, deliveryStatus:20, priority:21, smsSid:22, reminderSentAt:23
};

// Reconstruct the booking fields createCalendarEvent needs from a sheet row.
function rowToBooking(row) {
  return {
    bookingId: row[COL.bookingId] || "",
    name: row[COL.name] || "",
    phone: row[COL.phone] || "",
    service: row[COL.service] || "",
    address: row[COL.rawAddress] || "",
    startUTC: row[COL.startIso] || "",
    displayDateTime: row[COL.requestedDateTime] || "",
    notes: row[COL.notes] || ""
  };
}

// Idempotent: if the row already has an event id, do nothing. Otherwise create
// the event and write its id back. Prevents double-writes from retries/races.
async function commitToCalendar(env, token, dataRowIndex, row, confirmTier) {
  const rr = dataRowIndex + 2;
  if (!row[COL.startIso]) return "";
  // Fresh idempotency check against the LIVE cell (not the stale snapshot),
  // shrinking the reply-vs-sweeper race window to a couple of API calls.
  const live = await sheetsGetRange(env, token, `${BUSINESS.sheetTab}!L${rr}`);
  const existing = (live[0] && live[0][0]) || row[COL.calendarEventId] || "";
  if (existing) return existing;
  const b = rowToBooking(row);
  const addressForRecords = row[COL.stdAddress] || b.address;
  const eventId = await createCalendarEvent(b, addressForRecords, env, token, confirmTier);
  await sheetsPutRange(env, token, `${BUSINESS.sheetTab}!L${rr}`, [[eventId]]);
  return eventId;
}

// Lower number = more urgent. 1-3 originate in emergency/message paths.
function flagPriority(reasons) {
  const j = reasons.join(" ");
  if (/undelivered|failed|phone_invalid/.test(j)) return 4;  // broken channel
  if (/address_(undeliverable|missing)/.test(j))  return 5;  // bad address
  return 6;                                                   // uncertain / high-ticket
}

async function deleteCalendarEvent(eventId, token) {
  const resp = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(BUSINESS.calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }
  );
  // 404/410 mean it's already gone — that's the desired end state.
  if (!resp.ok && resp.status !== 404 && resp.status !== 410) {
    throw new Error("calendar_delete_failed_" + resp.status);
  }
}

// Cancel/replace the caller's most recent still-active booking (reschedule path).
async function supersedePriorBooking(env, phone, exceptBookingId) {
  if (!env.SHEETS_ID) return;
  const token = await getGoogleToken(env);
  const rows = await sheetsGetAll(env, token);
  const active = ["pending", "hard-confirmed", "soft-confirmed", "flagged"];
  for (let i = rows.length - 1; i >= 0; i--) {
    if (normalizePhone(rows[i][COL.phone] || "") !== phone) continue;
    if (rows[i][COL.bookingId] === exceptBookingId) continue;
    if (!active.includes((rows[i][COL.status] || "").toLowerCase())) continue;
    const eventId = rows[i][COL.calendarEventId] || "";
    if (eventId) await deleteCalendarEvent(eventId, token);
    await sheetsUpdateStatus(env, token, i, { status: "rescheduled" });
    return;
  }
}

// Cancel an active booking that lives only in the queue (e.g. still pending,
// not yet on the calendar). Matches by name; if a date is given, require it too.
async function cancelPendingInSheet(env, token, nameNeedle, dateStr) {
  const rows = await sheetsGetAll(env, token);
  const active = ["pending", "hard-confirmed", "soft-confirmed", "flagged"];
  for (let i = rows.length - 1; i >= 0; i--) {
    if (!active.includes((rows[i][COL.status] || "").toLowerCase())) continue;
    if (!(rows[i][COL.name] || "").toLowerCase().includes(nameNeedle)) continue;
    if (dateStr && rows[i][COL.startIso] && easternDateStr(new Date(rows[i][COL.startIso])) !== dateStr) continue;
    const eventId = rows[i][COL.calendarEventId] || "";
    if (eventId) { try { await deleteCalendarEvent(eventId, token); } catch {} }
    await sheetsUpdateStatus(env, token, i, { status: "cancelled" });
    return true;
  }
  return false;
}

// ============================================================================
// Smarty US Street Address API  (address verification + DPV)
// Pass the whole spoken address as `street`; Smarty parses it.
// Returns { checked, deliverable, dpv, standardized, error }.
//   checked=false  -> infra/config issue, do NOT flag the address
//   checked=true & deliverable=false -> genuine bad address -> flag
// ============================================================================
async function validateAddressSmarty(raw, env) {
  try {
    if (!env.SMARTY_AUTH_ID || !env.SMARTY_AUTH_TOKEN) {
      return { checked: false, deliverable: false, dpv: "", standardized: "", error: "smarty_not_configured" };
    }
    const qs = new URLSearchParams({
      "auth-id": env.SMARTY_AUTH_ID,
      "auth-token": env.SMARTY_AUTH_TOKEN,
      street: raw,
      candidates: "1"
    });
    const resp = await fetch(`https://us-street.api.smarty.com/street-address?${qs}`);
    if (!resp.ok) {
      // 401/402/429/etc. are auth/billing/rate issues, not the address's fault.
      return { checked: false, deliverable: false, dpv: "", standardized: "", error: `smarty_http_${resp.status}` };
    }
    const data = await resp.json();
    if (!Array.isArray(data) || data.length === 0) {
      // Empty result = Smarty could not match it = undeliverable/unknown.
      return { checked: true, deliverable: false, dpv: "", standardized: "", error: "no_match" };
    }
    const c = data[0];
    const dpv = c.analysis?.dpv_match_code || "";
    const deliverable = ["Y", "S", "D"].includes(dpv);
    const standardized = [c.delivery_line_1, c.last_line].filter(Boolean).join(", ");
    return { checked: true, deliverable, dpv, standardized, error: deliverable ? "" : "dpv_" + (dpv || "none") };
  } catch (e) {
    return { checked: false, deliverable: false, dpv: "", standardized: "", error: "smarty_exception" };
  }
}

// ============================================================================
// GOOGLE SHEETS  (VA queue)
// ============================================================================
async function appendBookingRow(env, row) {
  if (!env.SHEETS_ID) throw new Error("sheets_not_configured");
  const token = await getGoogleToken(env);
  const range = `${BUSINESS.sheetTab}!A1`;
  const resp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEETS_ID}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [row] })
    }
  );
  if (!resp.ok) {
    throw new Error("sheets_append_failed_" + resp.status + ": " + (await resp.text()).slice(0, 120));
  }
}

async function sheetsGetAll(env, token) {
  return sheetsGetRange(env, token, `${BUSINESS.sheetTab}!A2:X`);
}

async function sheetsGetRange(env, token, a1) {
  const resp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEETS_ID}/values/${encodeURIComponent(a1)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!resp.ok) {
    throw new Error("sheets_read_failed_" + resp.status);
  }
  const data = await resp.json();
  return data.values || [];
}

// Update status/reply columns (M..R) for a given data row index (0-based within data).
async function sheetsPutRange(env, token, a1, values) {
  const resp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEETS_ID}/values/${encodeURIComponent(a1)}?valueInputOption=RAW`,
    { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values }) }
  );
  if (!resp.ok) throw new Error("sheets_update_failed_" + resp.status + " @" + a1);
}

async function sheetsUpdateStatus(env, token, dataRowIndex, { status, flagReasons, smsReplyAt, smsReplyText }) {
  const sheetRow = dataRowIndex + 2; // header is row 1
  // Columns: M=status N=flagged O=flagReasons P=smsSentAt Q=smsReplyAt R=smsReplyText
  // Written as separate ranges so we never clobber flagged/smsSentAt.
  const tab = BUSINESS.sheetTab;
  await sheetsPutRange(env, token, `${tab}!M${sheetRow}`, [[status]]);
  if (flagReasons !== undefined) {
    await sheetsPutRange(env, token, `${tab}!O${sheetRow}`, [[flagReasons]]);
  }
  if (smsReplyAt !== undefined || smsReplyText !== undefined) {
    await sheetsPutRange(env, token, `${tab}!Q${sheetRow}:R${sheetRow}`, [[smsReplyAt || "", smsReplyText || ""]]);
  }
}

// ============================================================================
// INBOUND SMS REPLY HANDLER  (Twilio webhook -> /sms-reply)
// Columns (0-based within A2:S): 4=phone, 12=status, 14=flagReasons, 15=smsSentAt
// ============================================================================
async function handleSmsReply(request, env, ctx) {
  const params = await formToObject(request);
  if (!(await verifyTwilioSignature(request, env, params))) {
    return new Response("Forbidden", { status: 403 });
  }
  const from = normalizePhone(params.From || "");
  const text = (params.Body || "").trim();
  if (from && text) {
    ctx.waitUntil(processSmsReply(env, from, text));
  }
  // Twilio expects valid TwiML (empty response = no auto-reply).
  return new Response("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response></Response>", {
    headers: { "Content-Type": "text/xml" }
  });
}

// Twilio delivery-status callback. Full deliveryStatus logic lands in Phase C.
async function handleSmsStatus(request, env, ctx) {
  const params = await formToObject(request);
  if (!(await verifyTwilioSignature(request, env, params))) {
    return new Response("Forbidden", { status: 403 });
  }
  ctx.waitUntil(processDeliveryStatus(env, params.MessageSid || "", params.MessageStatus || ""));
  return new Response("", { status: 204 });
}

// Twilio delivery callback: record status; flag immediately on broken channel.
async function processDeliveryStatus(env, sid, status) {
  if (!env.SHEETS_ID || !sid) return;
  const token = await getGoogleToken(env);
  const rows = await sheetsGetAll(env, token);
  const idx = rows.findIndex(r => r[COL.smsSid] === sid);
  if (idx === -1) return;
  const rr = idx + 2;
  await sheetsPutRange(env, token, `${BUSINESS.sheetTab}!U${rr}`, [[status]]); // deliveryStatus

  const cur = (rows[idx][COL.status] || "").toLowerCase();
  if ((status === "undelivered" || status === "failed") && cur === "pending") {
    const existing = rows[idx][COL.flagReasons] || "";
    await sheetsUpdateStatus(env, token, idx, {
      status: "flagged",
      flagReasons: (existing ? existing + "; " : "") + `sms_${status}`
    });
    await sheetsPutRange(env, token, `${BUSINESS.sheetTab}!V${rr}`, [["4"]]); // priority
    await sendSms(
      BUSINESS.ownerPhone,
      `⚠ UNDELIVERABLE (P4) - ${BUSINESS.name}\n${rows[idx][COL.name] || ""} | ${rows[idx][COL.service] || ""}\n` +
      `${rows[idx][COL.phone] || ""} can't receive texts — call them. Nothing booked.`,
      env
    );
  }
}

// Inbound reply. First transition wins: only act while the row is still pending.
async function processSmsReply(env, from, text) {
  if (!env.SHEETS_ID) return;
  const token = await getGoogleToken(env);
  const rows = await sheetsGetAll(env, token);

  let idx = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (normalizePhone(rows[i][COL.phone] || "") !== from) continue;
    if ((rows[i][COL.status] || "").toLowerCase() === "pending") { idx = i; break; }
  }
  if (idx === -1) return; // nothing pending for this number

  const nowIso = new Date().toISOString();
  const existing = rows[idx][COL.flagReasons] || "";
  const isYes = /^\s*(y|yes|yep|yeah|yup|confirm(ed)?|ok(ay)?|correct|sounds good)\b/i.test(text);

  if (isYes) {
    await sheetsUpdateStatus(env, token, idx, { status: "hard-confirmed", smsReplyAt: nowIso, smsReplyText: text });
    try {
      await commitToCalendar(env, token, idx, rows[idx], "hard-confirmed");
      // Same-thread ack to the customer (touch stays within confirm + reminder cap).
      if (rows[idx][COL.phone]) {
        try {
          await sendSms(rows[idx][COL.phone],
            `Thanks for confirming — see you ${rows[idx][COL.requestedDateTime] || "then"}!`, env);
        } catch {}
      }
      await sendSms(
        BUSINESS.ownerPhone,
        `✅ New booking — confirmed by customer\n${rows[idx][COL.service] || ""} — ${rows[idx][COL.name] || ""}\n` +
        `${rows[idx][COL.stdAddress] || rows[idx][COL.rawAddress] || ""}\n${rows[idx][COL.requestedDateTime] || ""}`,
        env
      );
    } catch (e) {
      await sheetsUpdateStatus(env, token, idx, {
        status: "flagged",
        flagReasons: (existing ? existing + "; " : "") + "calendar_error_on_confirm"
      });
      await sendSms(BUSINESS.ownerPhone,
        `⚠ CONFIRMED BUT CALENDAR FAILED - ${BUSINESS.name}\n${rows[idx][COL.name] || ""} ${rows[idx][COL.requestedDateTime] || ""}\n${e.message}\nBook manually.`, env);
    }
  } else {
    await sheetsUpdateStatus(env, token, idx, {
      status: "flagged",
      flagReasons: (existing ? existing + "; " : "") + `customer_replied(${text.slice(0, 80)})`,
      smsReplyAt: nowIso, smsReplyText: text
    });
    await sheetsPutRange(env, token, `${BUSINESS.sheetTab}!V${idx + 2}`, [["3"]]);
    await sendSms(
      BUSINESS.ownerPhone,
      `⚠️ Needs review — customer replied, call them back.\n${BUSINESS.name}\nFrom: ${from}\nThey said: "${text}"\nNothing booked yet.`,
      env
    );
  }
}

// ============================================================================
// DEADLINE SWEEPER  (Cloudflare Cron, every 5 min)
// pending past deadline -> soft-confirm (delivered) or flag (not delivered);
// soft/hard-confirmed nearing the appt -> reminder SMS (the second touch).
// ============================================================================
async function sweepUnconfirmedBookings(env) {
  if (!env.SHEETS_ID) return;
  const token = await getGoogleToken(env);
  const rows = await sheetsGetAll(env, token);
  const now = Date.now();

  for (let i = 0; i < rows.length; i++) {
    const status = (rows[i][COL.status] || "").toLowerCase();
    const rr = i + 2;

    // 1) Pending past its deadline. (Pending rows are already address-clean.)
    if (status === "pending") {
      const deadline = Date.parse(rows[i][COL.confirmDeadline] || "");
      if (!deadline || deadline > now) continue;
      const delivery = (rows[i][COL.deliveryStatus] || "").toLowerCase();
      const existing = rows[i][COL.flagReasons] || "";
      // An uncertain row (ask-twice mismatch etc.) must NOT auto-confirm on
      // silence — it needs an explicit YES. Route it to the callback path.
      const uncertain = /model_uncertain|address_capture_mismatch|address_autocorrected/.test(existing);

      if (delivery === "delivered" && !uncertain) {
        await sheetsUpdateStatus(env, token, i, { status: "soft-confirmed" });
        try {
          await commitToCalendar(env, token, i, rows[i], "soft-confirmed");
        } catch (e) {
          await sheetsUpdateStatus(env, token, i, {
            status: "flagged",
            flagReasons: (existing ? existing + "; " : "") + "calendar_error_on_softconfirm"
          });
        }
      } else {
        await sheetsUpdateStatus(env, token, i, {
          status: "flagged",
          flagReasons: (existing ? existing + "; " : "") + `unconfirmed_after_${BUSINESS.noReplyTimeoutMin}min(delivery=${delivery || "unknown"})`
        });
        await sheetsPutRange(env, token, `${BUSINESS.sheetTab}!V${rr}`, [["4"]]);
        await sendSms(
          BUSINESS.ownerPhone,
          `⚠️ Needs review — no confirmation, call this customer.\n${BUSINESS.name}\n` +
          `${rows[i][COL.name] || ""} — ${rows[i][COL.service] || ""}\n${rows[i][COL.requestedDateTime] || ""}\n` +
          `(text ${delivery || "status unknown"})`,
          env
        );
      }
      continue;
    }

    // 2) Confirmed & appointment approaching -> reminder SMS (touch 2).
    if ((status === "soft-confirmed" || status === "hard-confirmed") && !rows[i][COL.reminderSentAt]) {
      const startMs = Date.parse(rows[i][COL.startIso] || "");
      if (!startMs) continue;
      const leadMs = BUSINESS.reminderLeadHours * 3600000;
      if (startMs > now && startMs - now <= leadMs && rows[i][COL.phone]) {
        try {
          await sendSms(
            rows[i][COL.phone],
            `Reminder from ${BUSINESS.shortName}: ${rows[i][COL.service] || "your appointment"} ${rows[i][COL.requestedDateTime] || ""}` +
            `${(rows[i][COL.stdAddress] || rows[i][COL.rawAddress]) ? ` at ${rows[i][COL.stdAddress] || rows[i][COL.rawAddress]}` : ""}. Reply here if anything's changed.`,
            env
          );
          await sheetsPutRange(env, token, `${BUSINESS.sheetTab}!X${rr}`, [[new Date().toISOString()]]);
        } catch {}
      }
    }
  }
}

// ============================================================================
// EMERGENCY / CANCEL / MESSAGE  (synchronous; already low-latency)
// ============================================================================
async function handleQualifyEmergency(params, env, callFromNumber = null) {
  const { severity = "critical", address = "", phone: rawPhone = "", description = "" } = params;
  const phone = normalizePhone(rawPhone, callFromNumber) || rawPhone;
  // Alert the owner, log an emergency-flagged queue row, reassure the customer.
  // An emergency is NEVER written to the calendar as a normal appointment.
  await logEmergency(env, { name: "", phone, address, service: description || "Emergency", description, severity });
  // Softened, truthful promise (SMS-only alert today; no auto voice-call yet).
  return {
    success: true,
    message: "I'm sending your info to our emergency line right now — someone will call you back as fast as possible."
  };
}

// Shared emergency handler: owner alert + emergency-flagged queue row + customer
// reassurance. Never touches the calendar. Called by qualifyEmergency AND by the
// bookAppointment guardrail (a misrouted emergency).
async function logEmergency(env, { name = "", phone = "", address = "", service = "", description = "", severity = "critical" }) {
  const priority = severity === "urgent" ? 2 : 1;   // 1 = most urgent
  const nowIso = new Date().toISOString();
  // Owner alert — plain, human-readable lead line.
  await sendSms(
    BUSINESS.ownerPhone,
    `🚨 EMERGENCY — call ${name || "caller"} now: ${phone || "(no number)"}\n${BUSINESS.name}\n` +
    `Issue: ${description || service || "(unspecified)"}\nAddress: ${address || "(none)"}`,
    env
  );
  // Emergency-flagged queue row (no calendar event, ever).
  try {
    await appendBookingRow(env, [
      nowIso, crypto.randomUUID(), "", name || "", phone || "", service || description || "Emergency",
      address || "", "", "",
      "", "", "",                                          // requestedDateTime, startIso, L eventId
      "emergency-flagged", "true", `emergency(${severity})`,
      "", "", "", description || "",                       // smsSentAt/Reply/Text, notes
      "", "", String(priority), "", ""                     // T-X (priority in V)
    ]);
  } catch {}
  // Customer reassurance — NOT a booking confirmation.
  if (phone) {
    try {
      await sendSms(
        phone,
        `${BUSINESS.name}: we've got your emergency and someone will call you back as fast as possible. If it's life-threatening, call 911.`,
        env
      );
    } catch {}
  }
}

// True when Smarty's standardized street introduces no street-name token the
// caller didn't say. ZIP fixes and suffix abbreviations (Drive->Dr) are fine;
// a changed street NAME (Run->Runn) is not — that must go to a human.
function addressPreserved(spoken, standardizedLine1) {
  if (!spoken || !standardizedLine1) return false;
  const SUFFIX = new Set(["dr","drive","st","street","ave","avenue","rd","road","ln","lane",
    "ct","court","blvd","boulevard","way","cir","circle","pl","place","ter","terrace",
    "hwy","highway","pkwy","parkway","n","s","e","w","ne","nw","se","sw","apt","unit","ste","suite"]);
  const toks = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  const spokenSet = new Set(toks(spoken));
  const streetTokens = toks(standardizedLine1).filter(t => !/^\d+$/.test(t) && !SUFFIX.has(t));
  return streetTokens.length > 0 && streetTokens.every(t => spokenSet.has(t));
}

// The transcriber often renders a spoken house number as WORDS ("two thirteen",
// "two one three") instead of digits ("213"), which Smarty can't parse -> no_match.
// Convert a leading run of number-words at the start of an address into digits.
const NUMWORD = {
  zero: 0, oh: 0, o: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  hundred: 100, thousand: 1000
};
function spokenToDigits(words) {
  const w = words.filter(x => x !== "and");
  if (!w.length) return "";
  // "two hundred thirteen" -> arithmetic cardinal (213).
  if (w.some(x => x === "hundred" || x === "thousand")) {
    let total = 0, cur = 0;
    for (const t of w) {
      const v = NUMWORD[t];
      if (v === 100) cur = (cur || 1) * 100;
      else if (v === 1000) { total += (cur || 1) * 1000; cur = 0; }
      else cur += v;
    }
    return String(total + cur);
  }
  // Otherwise concatenate spoken chunks: "two thirteen"->213, "two one three"->213.
  let out = "", pendingTens = null;
  for (const t of w) {
    const v = NUMWORD[t];
    if (v >= 20 && v <= 90) { if (pendingTens !== null) out += pendingTens; pendingTens = v; }
    else if (v >= 10) { if (pendingTens !== null) { out += pendingTens; pendingTens = null; } out += v; }
    else { if (pendingTens !== null) { out += (pendingTens + v); pendingTens = null; } else out += v; }
  }
  if (pendingTens !== null) out += pendingTens;
  return out;
}
function digitizeLeadingNumber(address) {
  const parts = (address || "").trim().split(/\s+/);
  const nums = [];
  let i = 0;
  for (; i < parts.length; i++) {
    const w = parts[i].toLowerCase().replace(/[^a-z]/g, "");
    if (w in NUMWORD || w === "and") nums.push(w); else break;
  }
  while (nums.length && nums[nums.length - 1] === "and") { nums.pop(); i--; }
  if (!nums.length) return address;
  const digits = spokenToDigits(nums);
  if (!digits) return address;
  const rest = parts.slice(i).join(" ");
  return (digits + (rest ? " " + rest : "")).trim();
}

// True when two spoken address captures mean the same thing once trivial
// differences are normalized (spelled numbers->digits, case, punctuation,
// Drive/Dr, Street/St, etc.). Used to decide address uncertainty from the
// ask-twice protocol server-side — asking twice is a capture step, not a signal.
const ADDR_ABBR = {
  drive: "dr", street: "st", avenue: "ave", road: "rd", lane: "ln", court: "ct",
  boulevard: "blvd", circle: "cir", place: "pl", terrace: "ter", highway: "hwy",
  parkway: "pkwy", "1st": "first", north: "n", south: "s", east: "e", west: "w",
  apartment: "apt", suite: "ste", unit: "unit"
};
function normalizeAddr(s) {
  return digitizeLeadingNumber(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/)
    .filter(Boolean).map(t => ADDR_ABBR[t] || t).join(" ").trim();
}
function addressesMatch(a, b) {
  const na = normalizeAddr(a), nb = normalizeAddr(b);
  return na.length > 0 && na === nb;
}

// True when an address carries a locality (city/town/ZIP) Smarty can resolve
// against — not just a bare street. A ZIP, a "street, city" comma, or a known
// service-area city all count.
function addressHasLocality(address) {
  const a = (address || "").toLowerCase();
  if (/\b\d{5}\b/.test(a)) return true;         // has a ZIP code
  if (/,\s*\S/.test(address)) return true;       // "street, city" form
  return BUSINESS.serviceCities.some(c => a.includes(c));
}

// Smarty needs city+state (or ZIP) to resolve. This business serves one state,
// so append it when the caller gave only "street, city" — callers shouldn't have
// to recite the state. No-op if a ZIP or the state is already present.
function withDefaultState(address) {
  const a = (address || "").toLowerCase();
  const st = (BUSINESS.defaultState || "").toLowerCase();
  if (!st || /\b\d{5}\b/.test(a) || new RegExp(`\\b${st}\\b`).test(a) ||
      /\b(virginia)\b/.test(a)) return address;
  return address.trim().replace(/,\s*$/, "") + ", " + BUSINESS.defaultState;
}

// Actually removes the calendar event. Never claims success unless the event is gone.
async function handleCancelAppointment(params, env) {
  const { customerName = "", appointmentDate = "", reason = "no reason given" } = params;
  if (!customerName || !appointmentDate) {
    return { success: false, message: "I need the name and the date to find that appointment." };
  }

  const token = await getGoogleToken(env);
  const ds = easternDateStr(parseTextDateTime(appointmentDate));
  const dayStart = easternToUTC(ds, "00:00");
  const dayEnd = easternToUTC(ds, "23:59");

  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(BUSINESS.calendarId)}/events?` +
    new URLSearchParams({ timeMin: dayStart.toISOString(), timeMax: dayEnd.toISOString(), singleEvents: "true", orderBy: "startTime" });
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error("calendar_list_failed_" + resp.status);
  const data = await resp.json();

  const needle = customerName.trim().toLowerCase();
  const matches = (data.items || []).filter(e =>
    `${e.summary || ""} ${e.description || ""}`.toLowerCase().includes(needle)
  );

  // Not on the calendar? It may still be a PENDING booking (pending-hold) that
  // hasn't been committed yet. Cancel it from the queue instead.
  if (matches.length === 0) {
    const pendingCancelled = await cancelPendingInSheet(env, token, needle, ds);
    if (pendingCancelled) {
      return { success: true, cancelled: true,
        message: `That's cancelled — I removed the ${ds} appointment for ${customerName}.` };
    }
    return { success: false, notFound: true,
      message: `I couldn't find an appointment for ${customerName} on ${ds}. Can you double-check the name or the date?` };
  }

  // Two events under the same name — do not guess which to delete.
  if (matches.length > 1) {
    await sendSms(BUSINESS.ownerPhone,
      `AMBIGUOUS CANCELLATION - ${BUSINESS.name}\n\nCustomer: ${customerName}\nDate: ${ds}\n${matches.length} matching events — caller wants to cancel. Handle manually.`, env);
    return { success: false, ambiguous: true,
      message: "I'm seeing more than one appointment under that name — I'll have the office confirm and call you right back." };
  }

  const evt = matches[0];
  await deleteCalendarEvent(evt.id, token);

  // Mirror the cancellation into the VA queue (best-effort; the calendar is truth).
  try {
    const rows = await sheetsGetAll(env, token);
    const idx = rows.findIndex(r => (r[11] || "") === evt.id);
    if (idx !== -1) await sheetsUpdateStatus(env, token, idx, { status: "cancelled" });
  } catch {}

  await sendSms(
    BUSINESS.ownerPhone,
    `CANCELLED - ${BUSINESS.name}\n\nCustomer: ${customerName}\nWas: ${evt.summary || "(untitled)"} on ${ds}\nReason: ${reason}\n\nCalendar event removed.`,
    env
  );

  return { success: true, cancelled: true,
    message: `That's cancelled — I removed the ${ds} appointment for ${customerName}.` };
}

async function handleTakeMessage(params, env, callFromNumber = null) {
  const { name = "Caller", phone: rawPhone = "", message = "", callbackTime = "", priority = "normal" } = params;
  const phone = normalizePhone(rawPhone, callFromNumber) || rawPhone || "(not provided)";
  const urgentTag = priority === "urgent" ? " [URGENT]" : "";
  await sendSms(
    BUSINESS.ownerPhone,
    `MESSAGE${urgentTag} - ${BUSINESS.name}\n\nFrom: ${name}\nCallback: ${phone}\nMessage: ${message}${callbackTime ? `\nBest time: ${callbackTime}` : ""}`,
    env
  );
  return { success: true, message: "Message received and forwarded to the team. Someone will call you back shortly." };
}

// Returns the Twilio message SID. Pass statusCallback to receive delivery updates.
async function sendSms(to, body, env, statusCallback) {
  const auth = btoa(`${env.TWILIO_SID}:${env.TWILIO_AUTH_TOKEN}`);
  const form = { From: BUSINESS.twilioFrom, To: to, Body: body };
  if (statusCallback) form.StatusCallback = statusCallback;
  const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_SID}/Messages.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form)
  });
  if (!resp.ok) {
    throw new Error("sms_failed_" + resp.status + ": " + (await resp.text()).slice(0, 120));
  }
  const data = await resp.json();
  return data.sid || "";
}
