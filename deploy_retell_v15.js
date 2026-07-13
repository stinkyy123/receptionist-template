// Deploy the v15 prompt + tool schema to the Retell LLM.
// Tools stay pointed at the Cloudflare Worker (the canonical backend).
// Usage: node deploy_retell_v15.js
const https = require('https');
const fs = require('fs');

// Credentials come from env, not source. Run with:
//   $env:RETELL_API_KEY='...'; $env:TOOL_SECRET='...'; node deploy_retell_v15.js
const RETELL_KEY = process.env.RETELL_API_KEY;
const LLM_ID = 'llm_b87d28588b771499db90d726e1f7';
// Agent id for voice-config tuning (env override, falls back to the live agent).
const AGENT_ID = process.env.RETELL_AGENT_ID || 'agent_a0816d675497be6750760cf772';
const TOOL_SECRET = process.env.TOOL_SECRET;
if (!RETELL_KEY || !TOOL_SECRET) {
  console.error('Set RETELL_API_KEY and TOOL_SECRET environment variables first.');
  process.exit(1);
}
// Tool calls hit the authenticated secret path, not the bare worker root.
const WORKER_URL = 'https://bluetap-receptionist.hbrks56.workers.dev/t/' + TOOL_SECRET;

const prompt = fs.readFileSync('C:\\Users\\hbrks\\OneDrive\\Desktop\\Receptionist\\vapi_live_prompt_v15.txt', 'utf8')
  .replace(/\{\{customer\.number\}\}/g, '{{from_number}}');

function retellRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const r = https.request({
      hostname: 'api.retellai.com', path, method,
      headers: { 'Authorization': 'Bearer ' + RETELL_KEY, 'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) }
    }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() })); });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function customTool(name, description, props, required, speakDuring = false, speakAfter = true) {
  return { type: 'custom', name, description,
    parameters: { type: 'object', properties: props, required },
    url: WORKER_URL, speak_during_execution: speakDuring, speak_after_execution: speakAfter };
}

const tools = [
  customTool('getDate',
    'Get current date/time. Call ONLY when customer mentions relative dates like tomorrow or next week. Do NOT call at call start.',
    {}, []),
  customTool('checkAvailability',
    'Check if a time slot is available for booking. Call once BOTH date AND time are known.',
    { requestedDate: { type: 'string', description: 'Date in YYYY-MM-DD format' },
      requestedTime: { type: 'string', description: 'Time in HH:MM 24-hour format' },
      serviceType: { type: 'string', description: 'Type of service' },
      estimatedDuration: { type: 'number', description: 'Duration in minutes, default 90' } },
    ['requestedDate', 'requestedTime']),
  customTool('bookAppointment',
    'Book an appointment. Call ONCE per call when you have day, time, name, phone, address. Returns instantly; the customer gets a text to confirm the details.',
    { requestedText: { type: 'string', description: "Human-readable datetime e.g. 'Monday May 13 at 9 AM'" },
      requestedDate: { type: 'string', description: 'Date in YYYY-MM-DD format (preferred, pass if available)' },
      requestedTime: { type: 'string', description: 'Time in HH:MM 24-hour format (preferred, pass if available)' },
      name: { type: 'string', description: 'Customer full name (first + last)' },
      phone: { type: 'string', description: 'Customer callback phone in E.164. Use actual digits, never a placeholder.' },
      service: { type: 'string', description: 'Service description' },
      address: { type: 'string', description: 'Full service address INCLUDING city/town (required), e.g. "213 Fox Run Drive, Lynchburg". Street alone is not enough.' },
      addressConfirm: { type: 'string', description: 'What you heard the SECOND time you asked for the address, verbatim. The system auto-detects mishearings by comparing the two; you do NOT judge address uncertainty yourself.' },
      notes: { type: 'string', description: 'Special instructions or routing tags' },
      uncertainFields: { type: 'array', items: { type: 'string' },
        description: "High-stakes fields you had to guess or that were unclear: any of 'address','phone','date','time','service'. Pass [] if confident on all." } },
    ['requestedText', 'name', 'phone', 'service', 'address']),
  customTool('qualifyEmergency',
    'Log and escalate an emergency: burst pipe, active flooding, sewage backup, gas smell, no water, or ceiling collapse.',
    { severity: { type: 'string', description: 'critical or urgent' },
      address: { type: 'string', description: 'Service address' },
      phone: { type: 'string', description: 'Callback phone number' },
      description: { type: 'string', description: 'Brief emergency description' } },
    ['severity']),
  customTool('cancelAppointment',
    'Cancel an existing appointment. Collect customer name and date first.',
    { customerName: { type: 'string', description: 'Name the appointment is under' },
      appointmentDate: { type: 'string', description: 'Date of the appointment' },
      reason: { type: 'string', description: 'Reason for cancellation' } },
    ['customerName', 'appointmentDate']),
  customTool('takeMessage',
    'Take a message and forward to the owner via SMS. Use for callbacks, confused callers, out-of-area, and any off-path routing.',
    { name: { type: 'string', description: 'Caller name' },
      phone: { type: 'string', description: 'Callback phone number' },
      message: { type: 'string', description: 'Message content' },
      callbackTime: { type: 'string', description: 'Preferred callback time (optional)' },
      priority: { type: 'string', description: 'normal or urgent' } },
    ['name', 'phone', 'message']),
  { type: 'end_call', name: 'endCall' }
];

(async () => {
  console.log('Pushing v15 prompt + tools to Retell LLM (tools -> Worker)...');
  const r = await retellRequest('PATCH', '/update-retell-llm/' + LLM_ID, { general_prompt: prompt, general_tools: tools });
  console.log('Status:', r.status);
  if (r.status === 200) {
    const result = JSON.parse(r.body);
    console.log('Success! LLM version:', result.version);
  } else {
    console.log('Error:', r.body.substring(0, 600));
    return;
  }

  // Turn-taking: restore the v54 last-known-good values. (An earlier attempt set
  // interruption_sensitivity 0.3 / responsiveness 0.7 — that HURT: 0.3 made the
  // agent harder to interrupt, worsening talk-over, and 0.7 added latency.)
  // NOTE: this script OVERWRITES only general_prompt + general_tools (on the LLM)
  // and interruption_sensitivity + responsiveness (on the agent). It does NOT
  // touch voice_id, voice_model, transcriber/stt_mode, model, ambient_sound,
  // volume, or backchannel — dashboard edits to those survive a run of this script.
  console.log('Patching agent turn-taking settings...');
  const a = await retellRequest('PATCH', '/update-agent/' + AGENT_ID, {
    interruption_sensitivity: 0.75,  // v54 value; agent yields when the caller talks
    responsiveness: 1,               // v54 default; snappy responses
    ambient_sound: null              // no background track — cleaner transcription, less to echo
  });
  console.log('Agent PATCH status:', a.status);
  if (a.status !== 200) console.log('Agent error:', a.body.substring(0, 600));

  console.log('NOTE: publish the agent in the Retell dashboard if the new version is not auto-published.');
})();
