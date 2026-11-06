import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hoursFrom, parseClock, slotProblem, slotsForDay, wallToUtc, zoned } from '../dist/booking/slots.js';

const tz = 'America/New_York';
const NOW = Date.parse('2026-11-02T12:00:00Z'); // Mon 7:00 AM Eastern (EST)

test('clock parsing', () => {
  assert.equal(parseClock('9:30 AM'), 570);
  assert.equal(parseClock('12:00 PM'), 720);
  assert.equal(parseClock('12:30 AM'), 30);
  assert.equal(parseClock('17:15'), 1035);
  assert.equal(parseClock('nonsense'), null);
});

test('hours fall back field by field', () => {
  const h = hoursFrom({ days: ['Monday', 'Wednesday'], start: '8:00 AM', end: null, length: null });
  assert.deepEqual(h, { days: [1, 3], start: 480, end: 1020, length: 30 });
  assert.deepEqual(hoursFrom({}).days, [1, 2, 3, 4, 5]);
});

test('wall clock <-> UTC across DST', () => {
  // Summer (EDT, UTC-4) and winter (EST, UTC-5).
  assert.equal(new Date(wallToUtc('2026-07-01', 9 * 60, tz)).toISOString(), '2026-07-01T13:00:00.000Z');
  assert.equal(new Date(wallToUtc('2026-12-01', 9 * 60, tz)).toISOString(), '2026-12-01T14:00:00.000Z');
  // The day clocks go back (2026-11-01): 9 AM is EST.
  assert.equal(new Date(wallToUtc('2026-11-01', 9 * 60, tz)).toISOString(), '2026-11-01T14:00:00.000Z');
  // Spring forward (2027-03-14): 9 AM is EDT.
  assert.equal(new Date(wallToUtc('2027-03-14', 9 * 60, tz)).toISOString(), '2027-03-14T13:00:00.000Z');
  const z = zoned(Date.parse('2026-11-05T22:00:00Z'), tz);
  assert.deepEqual(z, { ymd: '2026-11-05', minutes: 17 * 60, weekday: 4 });
});

test('slots respect hours, length and lead time', () => {
  const h = { days: [1, 2, 3, 4, 5], start: 8 * 60, end: 10 * 60, length: 30 };
  // Monday the 2nd: now is 7:00 AM, lead is 2h, so 8:00 and 8:30 are too soon.
  const today = slotsForDay('2026-11-02', h, [], [], tz, NOW).map((t) => zoned(t, tz).minutes);
  assert.deepEqual(today, [9 * 60, 9 * 60 + 30]);
  const tomorrow = slotsForDay('2026-11-03', h, [], [], tz, NOW);
  assert.equal(tomorrow.length, 4);
  // Saturday: day off.
  assert.equal(slotsForDay('2026-11-07', h, [], [], tz, NOW).length, 0);
  // 45-minute appointments must finish by end of day.
  const long = slotsForDay('2026-11-03', { ...h, length: 45 }, [], [], tz, NOW).map((t) => zoned(t, tz).minutes);
  assert.deepEqual(long, [480, 510, 540]);
});

test('busy time and the patient’s own appointments block slots', () => {
  const h = { days: [2], start: 8 * 60, end: 10 * 60, length: 30 };
  const at = (m: number) => wallToUtc('2026-11-03', m, tz);
  const busy: Array<[number, number]> = [[at(8 * 60 + 15), at(8 * 60 + 45)]]; // overlaps 8:00 and 8:30
  const mine: Array<[number, number]> = [[at(9 * 60 + 30), at(10 * 60)]];
  const open = slotsForDay('2026-11-03', h, busy, mine, tz, NOW).map((t) => zoned(t, tz).minutes);
  assert.deepEqual(open, [9 * 60]);
  assert.equal(slotProblem(at(8 * 60), h, busy, mine, tz, NOW), 'doctor-busy');
  assert.equal(slotProblem(at(9 * 60 + 30), h, busy, mine, tz, NOW), 'you-are-busy');
  assert.equal(slotProblem(at(9 * 60 + 10), h, busy, mine, tz, NOW), 'off-grid');
  assert.equal(slotProblem(at(7 * 60), h, busy, mine, tz, NOW), 'outside-hours');
});
