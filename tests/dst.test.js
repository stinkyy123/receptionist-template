// DST proof: is the offset derived PER BOOKING DATE (not today), and correct across a
// DST transition? Phoenix (fixed offset) can't prove this — Chicago/Eastern can.
const fs = require('fs');

function loadWorker(file, tzOverride) {
  let src = fs.readFileSync(file, 'utf8');
  const es = src.indexOf('export default {');
  const ee = src.indexOf('\n};', es) + 3;
  src = src.slice(0, es) + src.slice(ee);
  const m = eval(src + '\n;({BUSINESS, easternOffset, easternToUTC})');
  if (tzOverride) m.BUSINESS.timezone = tzOverride;   // reuse the same code under another tz
  return m;
}

let pass = 0, fail = 0;
const ok = (n, c, got) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + '  -> got ' + got); } };

const W = loadWorker(process.argv[2]);

// ---------- EASTERN across DST (EST -5 winter / EDT -4 summer) ----------
console.log('\nAmerica/New_York — offset must change with the BOOKING date');
W.BUSINESS.timezone = 'America/New_York';
const janOff = W.easternOffset(new Date(Date.UTC(2026, 0, 15, 12)));   // Jan -> EST
const julOff = W.easternOffset(new Date(Date.UTC(2026, 6, 20, 12)));   // Jul -> EDT
ok('Jan offset = -5 (EST)', janOff === -5, janOff);
ok('Jul offset = -4 (EDT)', julOff === -4, julOff);
ok('offset DIFFERS by booking date (not a static/today lookup)', janOff !== julOff);
ok('2 PM on Jan 15 -> 19:00Z (EST)', W.easternToUTC('2026-01-15','14:00').toISOString() === '2026-01-15T19:00:00.000Z', W.easternToUTC('2026-01-15','14:00').toISOString());
ok('2 PM on Jul 20 -> 18:00Z (EDT)', W.easternToUTC('2026-07-20','14:00').toISOString() === '2026-07-20T18:00:00.000Z', W.easternToUTC('2026-07-20','14:00').toISOString());

// ---------- CHICAGO across the Nov 1 2026 fall-back (the case you named) ----------
console.log('\nAmerica/Chicago — straddling the Nov 1, 2026 fall-back');
W.BUSINESS.timezone = 'America/Chicago';
const beforeFB = W.easternOffset(new Date(Date.UTC(2026, 9, 30, 12)));  // Oct 30 -> CDT (-5)
const afterFB  = W.easternOffset(new Date(Date.UTC(2026, 10, 5, 12)));  // Nov 5  -> CST (-6)
ok('Oct 30 offset = -5 (CDT)', beforeFB === -5, beforeFB);
ok('Nov 5 offset = -6 (CST)', afterFB === -6, afterFB);
ok('fall-back detected (offset shifts by 1h)', afterFB === beforeFB - 1);
ok('2 PM Oct 30 -> 19:00Z (CDT)', W.easternToUTC('2026-10-30','14:00').toISOString() === '2026-10-30T19:00:00.000Z', W.easternToUTC('2026-10-30','14:00').toISOString());
ok('2 PM Nov 5  -> 20:00Z (CST)', W.easternToUTC('2026-11-05','14:00').toISOString() === '2026-11-05T20:00:00.000Z', W.easternToUTC('2026-11-05','14:00').toISOString());
// The silent-1h-off failure mode: if the offset were static, BOTH would map to the same UTC hour.
const a = W.easternToUTC('2026-10-30','14:00').getUTCHours();
const b = W.easternToUTC('2026-11-05','14:00').getUTCHours();
ok('SAME wall-clock 2 PM maps to DIFFERENT UTC across the boundary (no silent 1h drift)', a !== b, `${a} vs ${b}`);

// ---------- the transition day itself (business hours only) ----------
console.log('\nTransition day itself (Nov 1 2026, business hours)');
const onDay = W.easternToUTC('2026-11-01','09:00').toISOString();      // 9 AM, after the 2 AM switch
ok('9 AM on fall-back day -> 15:00Z (CST, post-switch)', onDay === '2026-11-01T15:00:00.000Z', onDay);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
