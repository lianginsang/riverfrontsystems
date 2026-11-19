// Timezone math with Intl only (no date library). Local dates are 'YYYY-MM-DD'
// strings, local times are 'HH:MM' or 'HH:MM:SS'; instants are Dates.

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function localParts(date: Date, tz: string) {
  let fmt = partsFormatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsFormatters.set(tz, fmt);
  }
  const get = (type: string) => Number(fmt!.formatToParts(date).find((p) => p.type === type)!.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

// Milliseconds the zone is ahead of UTC at that instant (e.g. -5h for New York in winter).
function offsetMs(date: Date, tz: string): number {
  const p = localParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

// Wall-clock time in a zone -> instant. Rechecks the offset so DST changes land right.
export function zonedToUtc(localDate: string, localTime: string, tz: string): Date {
  const [y, m, d] = localDate.split('-').map(Number);
  const [hh, mm, ss = 0] = localTime.split(':').map(Number);
  const naive = Date.UTC(y, m - 1, d, hh, mm, ss);
  const first = offsetMs(new Date(naive), tz);
  const second = offsetMs(new Date(naive - first), tz);
  return new Date(naive - second);
}

export function localDateOf(date: Date, tz: string): string {
  const p = localParts(date, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function localHourOf(date: Date, tz: string): number {
  return localParts(date, tz).hour;
}

// 0 = Sunday ... 6 = Saturday, matching the availability.weekday column.
export function weekdayOf(localDate: string): number {
  return new Date(`${localDate}T00:00:00Z`).getUTCDay();
}

export function addDays(localDate: string, days: number): string {
  const d = new Date(`${localDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function isLocalDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime());
}

// e.g. 2026-11-20T14:30:00-05:00: the form tools hand to Claude and accept back.
export function toLocalIso(date: Date, tz: string): string {
  const off = offsetMs(date, tz);
  const local = new Date(date.getTime() + off).toISOString().slice(0, 19);
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off) / 60_000;
  return `${local}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

// Accepts an ISO time with an offset, or a bare local "YYYY-MM-DDTHH:MM" in the business zone.
export function parseStartTime(value: string, tz: string): Date | undefined {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(trimmed)) {
    const d = new Date(trimmed);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  const bare = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?$/.exec(trimmed);
  if (bare && isLocalDate(bare[1])) return zonedToUtc(bare[1], bare[2], tz);
  return undefined;
}

// "Thursday, November 20 at 2:30 PM"
export function formatSpoken(date: Date, tz: string): string {
  const day = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' }).format(date);
  return `${day} at ${formatTime(date, tz)}`;
}

// "2:30 PM"
export function formatTime(date: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(date);
}

// "Thursday, November 20"
export function formatDay(localDate: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(
    new Date(`${localDate}T12:00:00Z`),
  );
}
