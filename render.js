#!/usr/bin/env node
// render.js — merge a client config into the deployable prompt + worker + wrangler.
//   node render.js <client>
// Reads clients/<client>/config.json; writes clients/<client>/dist/{prompt.txt,
// worker/src/index.js, worker/wrangler.toml}. Pure value substitution over the
// *.template files — no logic is generated here.
const fs = require('fs');
const path = require('path');

const client = process.argv[2];
if (!client) { console.error('usage: node render.js <client>'); process.exit(1); }
const root = __dirname;
const cfgPath = path.join(root, 'clients', client, 'config.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

const ARRAY_KEYS = ['highTicketKeywords', 'emergencyKeywords', 'serviceCities'];

// Format an array the way the source hand-wrote scalars: ["a", "b"] (comma + space).
function arr(a) { return '[' + a.map(x => JSON.stringify(x)).join(', ') + ']'; }

function fill(text, eol) {
  // block sections (prompt only)
  if (cfg.prompt) {
    text = text.split('@@FACTS@@').join(cfg.prompt.factsLines.join(eol));
    text = text.split('@@PRICING@@').join(cfg.prompt.pricingLine);
  }
  // arrays (worker only)
  for (const k of ARRAY_KEYS) if (cfg[k]) text = text.split('@@' + k + '@@').join(arr(cfg[k]));
  // scalars — every remaining @@key@@
  for (const k of Object.keys(cfg)) {
    if (k === 'prompt' || ARRAY_KEYS.includes(k)) continue;
    text = text.split('@@' + k + '@@').join(String(cfg[k]));
  }
  return text;
}

function detectEol(s) { return s.includes('\r\n') ? '\r\n' : '\n'; }

const outDir = path.join(root, 'clients', client, 'dist');
fs.mkdirSync(path.join(outDir, 'worker', 'src'), { recursive: true });

// prompt
const ptpl = fs.readFileSync(path.join(root, 'prompt.template.txt'), 'utf8');
fs.writeFileSync(path.join(outDir, 'prompt.txt'), fill(ptpl, detectEol(ptpl)));
// worker
const wtpl = fs.readFileSync(path.join(root, 'worker', 'src', 'index.template.js'), 'utf8');
fs.writeFileSync(path.join(outDir, 'worker', 'src', 'index.js'), fill(wtpl, detectEol(wtpl)));
// wrangler
const gtpl = fs.readFileSync(path.join(root, 'worker', 'wrangler.template.toml'), 'utf8');
fs.writeFileSync(path.join(outDir, 'worker', 'wrangler.toml'), fill(gtpl, detectEol(gtpl)));

// unfilled-token guard
const leftovers = [];
for (const f of ['prompt.txt', 'worker/src/index.js', 'worker/wrangler.toml']) {
  const m = fs.readFileSync(path.join(outDir, f), 'utf8').match(/@@[a-zA-Z]+@@/g);
  if (m) leftovers.push(f + ': ' + [...new Set(m)].join(','));
}
if (leftovers.length) { console.error('UNFILLED TOKENS:\n' + leftovers.join('\n')); process.exit(2); }

// Placeholder guard: an un-provisioned (TODO) config must never flow into a deploy.
// Files are still written so the prompt/worker can be REVIEWED at the config gate,
// but the non-zero exit halts any `render && deploy` chain.
const todos = Object.entries(cfg)
  .filter(([, v]) => typeof v === 'string' && /TODO/i.test(v))
  .map(([k]) => k);
if (todos.length) {
  console.error('\n⚠️  REVIEW ONLY — NOT DEPLOYABLE. Un-provisioned placeholders in config:');
  console.error('    ' + todos.join(', '));
  console.error('    Written to ' + path.relative(root, outDir) + ' for review.');
  console.error('    Fill these in (provisioning gate) before deploying.\n');
  process.exit(3);
}
console.log('rendered ' + client + ' -> ' + path.relative(root, outDir));
