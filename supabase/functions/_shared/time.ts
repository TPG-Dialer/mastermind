// Time helpers. Everything the groups see is Central time; the database stores UTC.
// No date library: Intl gives us the zone offset for any instant.

export const TZ = "America/Chicago";
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September",
  "October", "November", "December"];

export interface LocalParts { y: number; m: number; d: number; hh: number; mm: number; weekday: number }

/** Calendar fields of an instant in a zone. weekday is ISO (1 = Monday .. 7 = Sunday). */
export function localParts(at: Date, tz = TZ): LocalParts {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
  });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(at)) p[x.type] = x.value;
  const wd = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday) + 1;
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour % 24, mm: +p.minute, weekday: wd };
}

/** Minutes the zone is ahead of UTC at this instant (Central: -360 or -300). */
export function offsetMinutes(at: Date, tz = TZ): number {
  const l = localParts(at, tz);
  const asUtc = Date.UTC(l.y, l.m - 1, l.d, l.hh, l.mm);
  return Math.round((asUtc - Math.floor(at.getTime() / 60000) * 60000) / 60000);
}

/** The instant when the wall clock in `tz` reads y-m-d hh:mm. */
export function zonedTime(y: number, m: number, d: number, hh: number, mm: number, tz = TZ): Date {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let t = guess - offsetMinutes(new Date(guess), tz) * 60000;
  // Second pass settles DST edges.
  t = guess - offsetMinutes(new Date(t), tz) * 60000;
  return new Date(t);
}

/** Day of month of the nth ISO weekday (nth = -1 for last). Null if it doesn't exist. */
export function nthWeekday(y: number, m: number, isoWeekday: number, nth: number): number | null {
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const jsTarget = isoWeekday % 7; // ISO 7 (Sun) -> JS 0
  if (nth > 0) {
    const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    const day = 1 + ((jsTarget - first + 7) % 7) + (nth - 1) * 7;
    return day <= daysInMonth ? day : null;
  }
  const last = new Date(Date.UTC(y, m - 1, daysInMonth)).getUTCDay();
  return daysInMonth - ((last - jsTarget + 7) % 7);
}

export function addMonths(y: number, m: number, n: number): { y: number; m: number } {
  const i = y * 12 + (m - 1) + n;
  return { y: Math.floor(i / 12), m: (i % 12) + 1 };
}

export const ym = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;
export const monthName = (m: number) => MONTHS[m - 1];

/** "Fri Nov 20, 7:00 AM" in Central. */
export function fmtWhen(at: Date | string, tz = TZ): string {
  const d = typeof at === "string" ? new Date(at) : at;
  const date = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" }).format(d);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(d);
  return `${date}, ${time}`;
}

/** 10:00 AM Central, `days` calendar days after the local date of `at`. */
export function localMorningAfter(at: Date, days: number, hh = 10, tz = TZ): Date {
  const l = localParts(at, tz);
  const base = new Date(Date.UTC(l.y, l.m - 1, l.d + days));
  return zonedTime(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), hh, 0, tz);
}
