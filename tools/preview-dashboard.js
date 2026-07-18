#!/usr/bin/env node
// preview-dashboard.js — render the dashboard on seed data to a static HTML file.
//   node tools/preview-dashboard.js [client] [--now=YYYY-MM-DD]
//
// Imports the SAME computeDashboardStats + renderDashboardHtml from the rendered
// worker (no drift between preview and production), maps the relative-dated
// demo fixture into positional Sheet rows, and writes:
//   clients/<client>/dist/dashboard-preview.html
// This file is the approval artifact AND the sales screen-share asset.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
  const args = process.argv.slice(2);
  const client = args.find((a) => !a.startsWith('--')) || 'bluetap';
  const nowArg = (args.find((a) => a.startsWith('--now=')) || '').slice(6);
  const now = nowArg ? Date.parse(nowArg + 'T12:00:00Z') : Date.now();

  const root = path.resolve(__dirname, '..');
  const dist = path.join(root, 'clients', client, 'dist');
  const distIndex = path.join(dist, 'worker', 'src', 'index.js');
  if (!fs.existsSync(distIndex)) { console.error(`run \`node render.js ${client}\` first`); process.exit(1); }

  // Import the rendered worker as an ES module (copy to .mjs so Node treats it as one).
  const tmp = path.join(dist, `_preview_${Date.now()}.mjs`);
  fs.copyFileSync(distIndex, tmp);
  let mod;
  try { mod = await import(pathToFileURL(tmp).href); }
  finally { fs.rmSync(tmp, { force: true }); }
  const { computeDashboardStats, renderDashboardHtml, COL } = mod;

  const biz = JSON.parse(fs.readFileSync(path.join(root, 'clients', client, 'config.json'), 'utf8'));
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'clients', client, 'demo-bookings.json'), 'utf8'));
  const tz = biz.timezone;

  // local (y,m,d,h) in tz -> the UTC instant that reads as that wall-clock time
  const localToUTC = (y, m, d, h) => {
    const noon = new Date(Date.UTC(y, m - 1, d, 12));
    const lh = +new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(noon).find((p) => p.type === 'hour').value;
    return new Date(Date.UTC(y, m - 1, d, h - (lh - 12)));
  };
  // now's local calendar day
  const np = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(now));
  const g = (t) => +np.find((p) => p.type === t).value;
  const baseDay = Date.UTC(g('year'), g('month') - 1, g('day'));
  const dayParts = (offsetDays) => {
    const d = new Date(baseDay + offsetDays * 86400000);
    return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
  };

  // demo hygiene: keep appointments off closed days so the fake data never contradicts
  // the client's own hours ("Sun emergencies only"). Preview-only; production is real data.
  const keyOf = (y, m, d) => ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const rollToOpenDay = (y, m, d) => {
    if (!biz.schedule || !biz.schedule.days) return [y, m, d];
    let g = 0;
    while (!biz.schedule.days[keyOf(y, m, d)] && g++ < 7) {
      const nd = new Date(Date.UTC(y, m - 1, d) + 86400000);
      [y, m, d] = [nd.getUTCFullYear(), nd.getUTCMonth() + 1, nd.getUTCDate()];
    }
    return [y, m, d];
  };

  const rows = fixture.rows.map((r) => {
    const arr = new Array(24).fill('');
    const [by, bm, bd] = dayParts(-r.daysAgo);
    arr[COL.timestamp] = localToUTC(by, bm, bd, r.hour).toISOString();
    const [ay, am, ad] = r.status === 'emergency-flagged'
      ? dayParts(r.apptDays)                          // emergencies aren't calendar bookings; leave as-is
      : rollToOpenDay(...dayParts(r.apptDays));
    arr[COL.startIso] = localToUTC(ay, am, ad, r.apptHour).toISOString();
    arr[COL.name] = r.name;
    arr[COL.service] = r.service;
    arr[COL.status] = r.status;
    return arr;
  });

  const stats = computeDashboardStats(rows, biz, biz.avgTicket, now);
  const html = renderDashboardHtml(stats, biz);
  const out = path.join(dist, 'dashboard-preview.html');
  fs.writeFileSync(out, html);

  console.log(`wrote ${path.relative(root, out)}  (now=${new Date(now).toISOString().slice(0, 10)})`);
  console.log('  revenue this month :', '$' + stats.revenueMonth.toLocaleString('en-US'),
    `(${stats.revenueCount} jobs × $${biz.avgTicket})`);
  console.log('  after-hours saves  :', stats.afterHoursSaves, '| emergencies:', stats.emergencies);
  console.log('  calls  week/month  :', stats.callsWeek + '/' + stats.callsMonth, '(prev wk', stats.callsLastWeek + ')');
  console.log('  jobs   week/month  :', stats.jobsWeek + '/' + stats.jobsMonth, '(prev wk', stats.jobsLastWeek + ')');
  console.log('  recent rows        :', stats.recent.length);
})().catch((e) => { console.error(e); process.exit(1); });
