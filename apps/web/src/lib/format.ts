/**
 * Formatting. Every date and time shows in the PRACTICE's time zone (the
 * Knack app's setting), not the viewer's: a patient travelling across the
 * country must still see their 2:30 PM appointment as 2:30 PM.
 */

let zone = 'UTC';
export const setTimezone = (tz: string) => {
  zone = tz || 'UTC';
};
export const timezone = () => zone;

const isYmd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** A date-only value is a calendar day, not an instant: format it in UTC so it never shifts. */
const toDate = (value: string): { date: Date; tz: string } | null => {
  if (!value) return null;
  if (isYmd(value)) return { date: new Date(`${value}T12:00:00Z`), tz: 'UTC' };
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : { date: d, tz: zone };
};

const fmt = (value: unknown, options: Intl.DateTimeFormatOptions): string => {
  if (typeof value !== 'string') return '';
  const parsed = toDate(value);
  if (!parsed) return '';
  return new Intl.DateTimeFormat(undefined, { ...options, timeZone: parsed.tz }).format(parsed.date);
};

export const formatDate = (value: unknown) => fmt(value, { month: 'short', day: 'numeric', year: 'numeric' });
export const formatDateLong = (value: unknown) => fmt(value, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
export const formatDateShort = (value: unknown) => fmt(value, { month: 'short', day: 'numeric' });
export const formatWeekday = (value: unknown) => fmt(value, { weekday: 'short' });
export const formatDayNum = (value: unknown) => fmt(value, { day: 'numeric' });
export const formatMonthShort = (value: unknown) => fmt(value, { month: 'short' });
export const formatMonthYear = (value: unknown) => fmt(value, { month: 'long', year: 'numeric' });
export const formatTime = (value: unknown) =>
  typeof value === 'string' && isYmd(value) ? '' : fmt(value, { hour: 'numeric', minute: '2-digit' });
export const formatDateTime = (value: unknown) => {
  if (typeof value === 'string' && isYmd(value)) return formatDate(value);
  return fmt(value, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
};

/** YYYY-MM-DD of an instant, in the practice's zone. */
export const dayKey = (value: unknown): string => {
  if (typeof value !== 'string' || !value) return '';
  if (isYmd(value)) return value;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return parts;
};

export const todayKey = () => dayKey(new Date().toISOString());

export const addDays = (ymd: string, days: number): string => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export const isPast = (value: unknown): boolean => {
  if (typeof value !== 'string' || !value) return false;
  if (isYmd(value)) return value < todayKey();
  return new Date(value).getTime() < Date.now();
};

/** "Today at 2:30 PM", "Tomorrow at 9:00 AM", "Thu, Nov 12 at 10:00 AM", "in 3 weeks". */
export const whenLabel = (value: unknown): string => {
  if (typeof value !== 'string' || !value) return '';
  const day = dayKey(value);
  const today = todayKey();
  const time = formatTime(value);
  const at = time ? ` at ${time}` : '';
  if (day === today) return `Today${at}`;
  if (day === addDays(today, 1)) return `Tomorrow${at}`;
  if (day === addDays(today, -1)) return `Yesterday${at}`;
  return `${fmt(value, { weekday: 'short', month: 'short', day: 'numeric' })}${at}`;
};

const rtf = typeof Intl !== 'undefined' ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }) : null;

/** "in 3 days", "2 hours ago". */
export const relative = (value: unknown): string => {
  if (typeof value !== 'string' || !value || !rtf) return '';
  const parsed = toDate(value);
  if (!parsed) return '';
  const diff = parsed.date.getTime() - Date.now();
  const abs = Math.abs(diff);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 365 * 864e5],
    ['month', 30 * 864e5],
    ['week', 7 * 864e5],
    ['day', 864e5],
    ['hour', 36e5],
    ['minute', 6e4],
  ];
  for (const [unit, ms] of units) {
    if (abs >= ms || unit === 'minute') return rtf.format(Math.round(diff / ms), unit);
  }
  return '';
};

/** ISO instant -> "YYYY-MM-DDTHH:mm" wall clock in the practice's zone, for a datetime-local input. */
export const toWallClock = (value: unknown): string => {
  if (typeof value !== 'string' || !value) return '';
  if (isYmd(value)) return `${value}T09:00`;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
};

export const age = (dob: unknown): number | null => {
  if (typeof dob !== 'string' || !isYmd(dob)) return null;
  const [y, m, d] = dob.split('-').map(Number) as [number, number, number];
  const now = new Date();
  let a = now.getFullYear() - y;
  if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d)) a -= 1;
  return a >= 0 && a < 150 ? a : null;
};

export const greeting = (): string => {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
};

export const initials = (name: string): string =>
  name
    .replace(/^(dr|mr|mrs|ms|mx)\.?\s+/i, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');

export const firstName = (name: string): string => {
  const clean = name.replace(/^(dr|mr|mrs|ms|mx)\.?\s+/i, '').trim();
  return clean.split(/\s+/)[0] ?? clean;
};

export const fileSize = (bytes: number | null | undefined): string => {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
