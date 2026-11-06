/**
 * Appointment slot arithmetic. Pure functions, no platform imports: the
 * server uses them to validate a booking, and the browser uses the same code
 * to offer times, so the two can never disagree about what is bookable.
 *
 * All wall-clock times are in the PRACTICE's time zone (the Knack app's), and
 * every instant is epoch milliseconds.
 */

export interface DoctorHours {
  /** 0 = Sunday … 6 = Saturday. */
  days: number[];
  /** Minutes after midnight. */
  start: number;
  end: number;
  /** Appointment length in minutes. */
  length: number;
}

/** Busy time, [start, end) in epoch ms. */
export type Interval = [number, number];

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const DEFAULT_HOURS: DoctorHours = { days: [1, 2, 3, 4, 5], start: 9 * 60, end: 17 * 60, length: 30 };

/** Earliest bookable start, relative to now. */
export const LEAD_MS = 2 * 60 * 60_000;
/** How far ahead patients may book. */
export const HORIZON_DAYS = 90;
/** The grid patients pick times on. */
export const STEP_MINUTES = 30;

/** "9:30 AM" -> 570. Null if unreadable. */
export const parseClock = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const m = /^\s*(\d{1,2}):(\d{2})\s*([AaPp][Mm])?\s*$/.exec(value);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (m[3]) {
    const pm = m[3].toLowerCase() === 'pm';
    if (h === 12) h = pm ? 12 : 0;
    else if (pm) h += 12;
  }
  return h >= 0 && h < 24 && min >= 0 && min < 60 ? h * 60 + min : null;
};

/** Build hours from Knack field values, falling back to defaults field by field. */
export const hoursFrom = (v: { days?: unknown; start?: unknown; end?: unknown; length?: unknown }): DoctorHours => {
  const days = Array.isArray(v.days)
    ? v.days.map((d) => WEEKDAYS.indexOf(String(d))).filter((d) => d >= 0)
    : typeof v.days === 'string' && v.days
      ? [WEEKDAYS.indexOf(v.days)].filter((d) => d >= 0)
      : [];
  const start = parseClock(v.start) ?? DEFAULT_HOURS.start;
  const end = parseClock(v.end) ?? DEFAULT_HOURS.end;
  const length = typeof v.length === 'number' && v.length >= 5 && v.length <= 480 ? v.length : DEFAULT_HOURS.length;
  return { days: days.length ? days : DEFAULT_HOURS.days, start, end: end > start ? end : DEFAULT_HOURS.end, length };
};

// ── Time zones without a library ──────────────────────────────────────────

const partsCache = new Map<string, Intl.DateTimeFormat>();
const fmt = (tz: string) => {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsCache.set(tz, f);
  }
  return f;
};

/** Wall-clock parts of an instant in `tz`. */
export const zoned = (ms: number, tz: string): { ymd: string; minutes: number; weekday: number } => {
  const p = Object.fromEntries(fmt(tz).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const ymd = `${p.year}-${p.month}-${p.day}`;
  return { ymd, minutes: Number(p.hour) * 60 + Number(p.minute), weekday: weekdayOf(ymd) };
};

export const weekdayOf = (ymd: string): number => new Date(`${ymd}T12:00:00Z`).getUTCDay();

/** Offset of `tz` from UTC at instant `ms`, in ms. */
const offsetAt = (ms: number, tz: string): number => {
  const p = Object.fromEntries(fmt(tz).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return asUtc - Math.floor(ms / 1000) * 1000;
};

/** Wall clock (date + minutes after midnight) in `tz` -> instant. DST-safe. */
export const wallToUtc = (ymd: string, minutes: number, tz: string): number => {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  let utc = guess - offsetAt(guess, tz);
  // Second pass settles the hour either side of a DST change.
  utc = guess - offsetAt(utc, tz);
  return utc;
};

export const addDaysYmd = (ymd: string, days: number): string => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

// ── Availability ──────────────────────────────────────────────────────────

const overlaps = (a: Interval, list: Interval[]) => list.some(([s, e]) => a[0] < e && s < a[1]);

export type SlotProblem = 'past' | 'too-soon' | 'too-far' | 'day-off' | 'outside-hours' | 'off-grid' | 'doctor-busy' | 'you-are-busy';

export const SLOT_PROBLEM_TEXT: Record<SlotProblem, string> = {
  past: 'That time has already passed.',
  'too-soon': 'Appointments need to be booked at least 2 hours ahead. Call the office for anything sooner.',
  'too-far': `Appointments can be booked up to ${HORIZON_DAYS} days ahead.`,
  'day-off': 'The doctor doesn’t see patients that day.',
  'outside-hours': 'That time is outside the doctor’s hours.',
  'off-grid': 'Appointments start on the hour or half hour.',
  'doctor-busy': 'That time was just taken. Please pick another.',
  'you-are-busy': 'You already have an appointment at that time.',
};

/** Why `start` can't be booked with this doctor, or null if it can. */
export const slotProblem = (
  start: number,
  hours: DoctorHours,
  doctorBusy: Interval[],
  mine: Interval[],
  tz: string,
  now = Date.now(),
): SlotProblem | null => {
  if (start < now) return 'past';
  if (start < now + LEAD_MS) return 'too-soon';
  if (start > now + HORIZON_DAYS * 864e5) return 'too-far';
  const { ymd, minutes, weekday } = zoned(start, tz);
  if (!hours.days.includes(weekday)) return 'day-off';
  if (minutes % STEP_MINUTES !== 0) return 'off-grid';
  if (minutes < hours.start || minutes + hours.length > hours.end) return 'outside-hours';
  const slot: Interval = [start, start + hours.length * 60_000];
  // Guard against DST weirdness: the slot must end on the same wall-clock day.
  if (zoned(slot[1] - 1, tz).ymd !== ymd) return 'outside-hours';
  if (overlaps(slot, doctorBusy)) return 'doctor-busy';
  if (overlaps(slot, mine)) return 'you-are-busy';
  return null;
};

/** Every bookable start for one doctor on one day. */
export const slotsForDay = (
  ymd: string,
  hours: DoctorHours,
  doctorBusy: Interval[],
  mine: Interval[],
  tz: string,
  now = Date.now(),
): number[] => {
  if (!hours.days.includes(weekdayOf(ymd))) return [];
  const out: number[] = [];
  for (let m = Math.ceil(hours.start / STEP_MINUTES) * STEP_MINUTES; m + hours.length <= hours.end; m += STEP_MINUTES) {
    const start = wallToUtc(ymd, m, tz);
    if (!slotProblem(start, hours, doctorBusy, mine, tz, now)) out.push(start);
  }
  return out;
};
