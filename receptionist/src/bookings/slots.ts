import { addDays, formatDay, formatTime, localDateOf, weekdayOf, zonedToUtc } from './time.js';
import type { AvailabilityRow, TimeRange } from './types.js';

// Earliest a caller can book from now, so April never offers a time that's
// already starting.
export const MIN_NOTICE_MINUTES = 30;

export interface Slot {
  start: Date;
  end: Date;
  tz: string;
}

// Start times move in 30-minute steps (15 for services that aren't a multiple of 30).
export function slotStepMinutes(durationMinutes: number): number {
  return durationMinutes % 30 === 0 ? 30 : 15;
}

function overlaps(aStart: number, aEnd: number, b: TimeRange): boolean {
  return aStart < new Date(b.ends_at).getTime() && new Date(b.starts_at).getTime() < aEnd;
}

// Every open start time between two local dates (inclusive), respecting weekly
// hours, blocked times, existing bookings, the service's length and the minimum
// notice. Pure: all data is passed in.
export function computeSlots(input: {
  availability: AvailabilityRow[];
  blocked: TimeRange[];
  bookings: TimeRange[];
  durationMinutes: number;
  fromDate: string;
  toDate: string;
  now: Date;
}): Slot[] {
  const durationMs = input.durationMinutes * 60_000;
  const stepMs = slotStepMinutes(input.durationMinutes) * 60_000;
  const earliest = input.now.getTime() + MIN_NOTICE_MINUTES * 60_000;
  const busy = [...input.blocked, ...input.bookings];
  const byStart = new Map<number, Slot>();

  for (let date = input.fromDate; date <= input.toDate; date = addDays(date, 1)) {
    const weekday = weekdayOf(date);
    for (const row of input.availability) {
      if (row.weekday !== weekday) continue;
      const open = zonedToUtc(date, row.open_time, row.timezone).getTime();
      const close = zonedToUtc(date, row.close_time, row.timezone).getTime();
      for (let start = open; start + durationMs <= close; start += stepMs) {
        const end = start + durationMs;
        if (start < earliest || busy.some((b) => overlaps(start, end, b))) continue;
        byStart.set(start, { start: new Date(start), end: new Date(end), tz: row.timezone });
      }
    }
  }
  return [...byStart.values()].sort((a, b) => a.start.getTime() - b.start.getTime());
}

// Up to `max` slots spread across the list, so a busy afternoon offers 1, 2 and
// 3 PM rather than 1:00, 1:30 and 2:00.
export function spread(slots: Slot[], max: number): Slot[] {
  if (slots.length <= max) return slots;
  const picked: Slot[] = [];
  for (let i = 0; i < max; i++) picked.push(slots[Math.round((i * (slots.length - 1)) / (max - 1))]);
  return picked;
}

// One line per day with runs of back-to-back start times collapsed into ranges:
// "Thursday, November 20 (2026-11-20): 9:00 AM to 11:30 AM, 2:00 PM to 4:30 PM"
export function summarizeByDay(slots: Slot[], stepMinutes: number): string[] {
  const days = new Map<string, Slot[]>();
  for (const slot of slots) {
    const day = localDateOf(slot.start, slot.tz);
    days.set(day, [...(days.get(day) ?? []), slot]);
  }
  const stepMs = stepMinutes * 60_000;
  return [...days.entries()].map(([day, daySlots]) => {
    const runs: Slot[][] = [];
    for (const slot of daySlots) {
      const run = runs[runs.length - 1];
      if (run && slot.start.getTime() - run[run.length - 1].start.getTime() === stepMs) run.push(slot);
      else runs.push([slot]);
    }
    const ranges = runs.map((run) => {
      const first = formatTime(run[0].start, run[0].tz);
      return run.length === 1 ? first : `${first} to ${formatTime(run[run.length - 1].start, run[0].tz)}`;
    });
    return `${formatDay(day)} (${day}): ${ranges.join(', ')}`;
  });
}
