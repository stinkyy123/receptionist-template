// Test the new schedule + timezone logic against a RENDERED worker.
// Strips the ES `export default {...}` block so the pure helpers can be eval'd in CJS.
const fs = require('fs');

function loadWorker(file) {
  let src = fs.readFileSync(file, 'utf8');
  const es = src.indexOf('export default {');
  const ee = src.indexOf('\n};', es) + 3;
  src = src.slice(0, es) + src.slice(ee);
  return eval(src + '\n;({BUSINESS, dowOf, hoursForDate, fmtHour, easternOffset, easternToUTC, easternDateStr})');
}

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  -> ' + extra : '')); }
};

// ---------------- BLUETAP (America/New_York; Mon–Sat 7–19; Sun closed) ----------------
console.log('\nBLUETAP (America/New_York)');
const B = loadWorker(process.argv[2]);
ok('timezone is Eastern', B.BUSINESS.timezone === 'America/New_York');
ok('schedule present in BUSINESS', !!B.BUSINESS.schedule);

// 2026-07-19 is a Sunday; 2026-07-20 a Monday.
ok('dowOf(2026-07-19) = sun', B.dowOf('2026-07-19') === 'sun', B.dowOf('2026-07-19'));
ok('dowOf(2026-07-20) = mon', B.dowOf('2026-07-20') === 'mon', B.dowOf('2026-07-20'));

const sun = B.hoursForDate('2026-07-19');
const mon = B.hoursForDate('2026-07-20');
ok('SUNDAY is CLOSED (was bookable before!)', sun.closed === true);
ok('Monday open 7 -> 19', mon.closed === false && mon.open === 7 && mon.close === 19,
   JSON.stringify(mon));
ok('same-day cutoff = 4 PM', B.BUSINESS.schedule.sameDayCutoffH === 16);
ok('latest same-day slot = 5 PM', B.BUSINESS.schedule.latestSameDaySlotH === 17);
ok('fmtHour(7)="7 AM", fmtHour(19)="7 PM"', B.fmtHour(7) === '7 AM' && B.fmtHour(19) === '7 PM');

// Eastern offset: July = EDT = -4
const july = new Date(Date.UTC(2026, 6, 20, 12, 0, 0));
ok('EDT offset = -4 (unchanged behavior)', B.easternOffset(july) === -4, String(B.easternOffset(july)));
// 2 PM Eastern in July -> 18:00 UTC
ok('2 PM Eastern -> 18:00 UTC', B.easternToUTC('2026-07-20', '14:00').toISOString() === '2026-07-20T18:00:00.000Z',
   B.easternToUTC('2026-07-20', '14:00').toISOString());

// ---------------- PHOENIX (the bug that would have broken Summit) ----------------
console.log('\nSUMMIT (America/Phoenix — the timezone bug)');
const P = loadWorker(process.argv[3]);
ok('timezone is Phoenix', P.BUSINESS.timezone === 'America/Phoenix');
ok('Phoenix offset = -7 year-round (no DST)', P.easternOffset(july) === -7, String(P.easternOffset(july)));
// 2 PM Phoenix -> 21:00 UTC. The OLD code (hardcoded Eastern) gave 18:00Z = 11 AM Phoenix: 3h early.
const got = P.easternToUTC('2026-07-20', '14:00').toISOString();
ok('2 PM Phoenix -> 21:00 UTC (was 18:00Z = 3h early)', got === '2026-07-20T21:00:00.000Z', got);
const psun = P.hoursForDate('2026-07-19');
ok('Summit Sunday CLOSED', psun.closed === true);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
