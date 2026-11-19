import { config } from '../config.js';
import { sendSms } from '../twilio/sms.js';
import { bookingRepo, type BookingRepo } from './repo.js';
import { computeSlots, slotStepMinutes, spread, summarizeByDay, type Slot } from './slots.js';
import { addDays, formatSpoken, isLocalDate, localDateOf, localHourOf, parseStartTime, toLocalIso } from './time.js';
import type { AvailabilityRow, Booking, Service } from './types.js';

// Every function here returns text for a tool_result and never throws: a failure
// becomes a sentence April can act on (apologize, take a message, transfer).

const MAX_RANGE_DAYS = 14;
const MAX_OPTIONS = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNAVAILABLE = 'Booking is not available right now. Offer to take a message so the team can schedule them.';

export interface CallerContext {
  callSid: string;
  callerId: string;
}

export type PartOfDay = 'morning' | 'afternoon' | 'evening';

// US-centric: 10 digits get +1. Returns undefined for anything that isn't a phone number.
export function toE164(raw: string): string | undefined {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+')) return /^[1-9]\d{6,14}$/.test(digits) ? `+${digits}` : undefined;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return undefined;
}

// +19048672415 -> (904) 867-2415, for texts people read. Non-US numbers pass through.
function displayPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

function timezoneOf(availability: AvailabilityRow[]): string {
  return availability[0]?.timezone ?? config.businessTimezone;
}

function slotLine(slot: Slot): string {
  return `${formatSpoken(slot.start, slot.tz)} [start_time ${toLocalIso(slot.start, slot.tz)}]`;
}

function bookingLine(booking: Booking, services: Service[], tz: string): string {
  const service = services.find((s) => s.id === booking.service_id)?.name ?? 'Appointment';
  return `${service} on ${formatSpoken(new Date(booking.starts_at), tz)} for ${booking.customer_name} [booking_id ${booking.id}]`;
}

async function guarded(fn: (repo: BookingRepo) => Promise<string>): Promise<string> {
  if (!bookingRepo) return UNAVAILABLE;
  try {
    return await fn(bookingRepo);
  } catch (err) {
    console.error('Booking error:', err);
    return `The booking system had an error (${(err as Error).message}). Apologize and offer to take a message instead.`;
  }
}

async function resolveService(repo: BookingRepo, name?: string): Promise<Service | string> {
  const services = await repo.activeServices();
  if (services.length === 0) return 'No services are set up for booking yet. Offer to take a message.';
  if (!name?.trim()) {
    return services.length === 1
      ? services[0]
      : `Ask which service they want: ${services.map((s) => s.name).join(', ')}.`;
  }
  const wanted = name.trim().toLowerCase();
  const match =
    services.find((s) => s.name.toLowerCase() === wanted) ??
    services.find((s) => s.name.toLowerCase().includes(wanted) || wanted.includes(s.name.toLowerCase()));
  return match ?? `There's no service called "${name}". Available services: ${services.map((s) => s.name).join(', ')}.`;
}

// Concrete open start times between two local dates (inclusive) for a service.
// The single place availability is calculated; the model never does this math.
export async function findOpenSlots(
  fromDate: string,
  toDate: string,
  service: Service,
  repo: BookingRepo,
  opts: { now?: Date; ignoreBookings?: boolean } = {},
): Promise<Slot[]> {
  const now = opts.now ?? new Date();
  const availability = await repo.availability();
  const tz = timezoneOf(availability);
  // Pad the query window a day each side; computeSlots does the exact local-day cut.
  const from = new Date(`${addDays(fromDate, -1)}T00:00:00Z`);
  const to = new Date(`${addDays(toDate, 2)}T00:00:00Z`);
  const [blocked, bookings] = await Promise.all([
    repo.blockedBetween(from, to),
    opts.ignoreBookings ? Promise.resolve([]) : repo.bookedBetween(from, to),
  ]);
  const today = localDateOf(now, tz);
  return computeSlots({
    availability,
    blocked,
    bookings,
    durationMinutes: service.duration_minutes,
    fromDate: fromDate < today ? today : fromDate,
    toDate,
    now,
  });
}

// Is `start` a real start time (open hours, not blocked, enough notice, on the
// slot grid)? Ignores existing bookings on purpose: overlap is the database's job,
// so two callers racing for one slot both get this far and the constraint decides.
async function isBookableTime(start: Date, service: Service, repo: BookingRepo, tz: string): Promise<boolean> {
  const day = localDateOf(start, tz);
  const slots = await findOpenSlots(day, day, service, repo, { ignoreBookings: true });
  return slots.some((s) => s.start.getTime() === start.getTime());
}

// Up to three open times near the requested one, or the next openings after it.
async function alternativesNear(start: Date, service: Service, repo: BookingRepo, tz: string): Promise<string> {
  const day = localDateOf(start, tz);
  const sameDay = await findOpenSlots(day, day, service, repo);
  let options = sameDay
    .sort((a, b) => Math.abs(a.start.getTime() - start.getTime()) - Math.abs(b.start.getTime() - start.getTime()))
    .slice(0, 3)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  if (options.length === 0) {
    options = (await findOpenSlots(addDays(day, 1), addDays(day, MAX_RANGE_DAYS), service, repo)).slice(0, 3);
  }
  return options.length ? `Open times close to it:\n${options.map((s) => `- ${slotLine(s)}`).join('\n')}` : 'No open times in the next two weeks.';
}

function confirm(booking: Booking, text: string, ctx: CallerContext): void {
  void sendSms(booking.customer_phone, text, `[${ctx.callSid}] booking confirmation:`).catch((err) =>
    console.error(`[${ctx.callSid}] confirmation text failed:`, err),
  );
}

export function findOpenSlotsTool(input: {
  from_date: string;
  to_date?: string;
  part_of_day?: PartOfDay;
  service?: string;
}): Promise<string> {
  return guarded(async (repo) => {
    if (!isLocalDate(input.from_date)) return 'from_date must be a date like 2026-11-20.';
    const toDate = input.to_date ?? input.from_date;
    if (!isLocalDate(toDate) || toDate < input.from_date) return 'to_date must be a date like 2026-11-21, on or after from_date.';
    if (toDate > addDays(input.from_date, MAX_RANGE_DAYS)) return `Search at most ${MAX_RANGE_DAYS} days at a time.`;

    const service = await resolveService(repo, input.service);
    if (typeof service === 'string') return service;

    let slots = await findOpenSlots(input.from_date, toDate, service, repo);
    if (input.part_of_day) {
      slots = slots.filter((s) => {
        const hour = localHourOf(s.start, s.tz);
        return input.part_of_day === 'morning' ? hour < 12 : input.part_of_day === 'afternoon' ? hour >= 12 && hour < 17 : hour >= 17;
      });
    }
    if (slots.length === 0) {
      const next = (await findOpenSlots(addDays(toDate, 1), addDays(toDate, MAX_RANGE_DAYS), service, repo)).slice(0, 3);
      return next.length
        ? `Nothing open then for ${service.name}. The next open times are:\n${next.map((s) => `- ${slotLine(s)}`).join('\n')}`
        : `Nothing open for ${service.name} in the next two weeks. Offer to take a message.`;
    }
    return `Open times for ${service.name} (${service.duration_minutes} minutes). Offer two or three:\n${spread(slots, MAX_OPTIONS)
      .map((s) => `- ${slotLine(s)}`)
      .join('\n')}`;
  });
}

export function bookAppointmentTool(
  input: { start_time: string; customer_name: string; customer_phone?: string; service?: string; notes?: string },
  ctx: CallerContext,
): Promise<string> {
  return guarded(async (repo) => {
    const tz = timezoneOf(await repo.availability());
    const start = parseStartTime(input.start_time, tz);
    if (!start) return 'start_time must be one of the start_time values from find_open_slots or the call info.';
    const name = input.customer_name.trim();
    if (!name) return "Ask for the caller's name before booking.";
    const phone = toE164(input.customer_phone?.trim() || ctx.callerId);
    if (!phone) return `"${input.customer_phone ?? ctx.callerId}" isn't a valid phone number. Ask for a good callback number.`;

    const service = await resolveService(repo, input.service);
    if (typeof service === 'string') return service;
    if (!(await isBookableTime(start, service, repo, tz))) {
      return `${formatSpoken(start, tz)} isn't an available time. ${await alternativesNear(start, service, repo, tz)}`;
    }

    const end = new Date(start.getTime() + service.duration_minutes * 60_000);
    const result = await repo.insert({
      service_id: service.id,
      starts_at: start.toISOString(),
      ends_at: end.toISOString(),
      customer_name: name,
      customer_phone: phone,
      source: 'ai',
      call_sid: ctx.callSid,
      notes: input.notes?.trim() || null,
    });
    if (!result.ok) {
      if (result.reason === 'conflict') return `That time was just taken. ${await alternativesNear(start, service, repo, tz)}`;
      return `Booking failed (${result.message}). Apologize and offer to take a message.`;
    }

    const when = formatSpoken(start, tz);
    confirm(result.booking, `You're booked: ${service.name} with ${config.businessName} on ${when}. To change it, call ${displayPhone(config.twilioPhoneNumber)}.`, ctx);
    return `Booked: ${bookingLine(result.booking, [service], tz)}. A confirmation text is going to ${phone}. Read the day and time back to the caller.`;
  });
}

export function findBookingsForCallerTool(ctx: CallerContext): Promise<string> {
  return guarded(async (repo) => {
    const phone = toE164(ctx.callerId);
    if (!phone) return "The caller's number is hidden, so their bookings can't be looked up. Offer to take a message for the team.";
    const [bookings, services, availability] = await Promise.all([
      repo.upcomingForPhone(phone, new Date()),
      repo.activeServices(),
      repo.availability(),
    ]);
    if (bookings.length === 0) {
      return `No upcoming bookings for ${phone}. If they booked with a different number, offer to take a message for the team.`;
    }
    const tz = timezoneOf(availability);
    return `Upcoming bookings for ${phone}:\n${bookings.map((b) => `- ${bookingLine(b, services, tz)}`).join('\n')}`;
  });
}

// Loads a booking and checks it belongs to this caller. Returns the booking or the refusal text.
async function ownBooking(repo: BookingRepo, bookingId: string, ctx: CallerContext): Promise<Booking | string> {
  if (!UUID.test(bookingId.trim())) return 'booking_id must be one of the booking_id values from find_bookings_for_caller.';
  const phone = toE164(ctx.callerId);
  const booking = await repo.getBooking(bookingId.trim());
  // Same answer whether the booking doesn't exist or belongs to someone else, so
  // a caller can't probe for other people's appointments.
  if (!phone || !booking || booking.customer_phone !== phone || booking.status !== 'booked') {
    return "That booking can't be found for this caller's number. Callers can only change bookings made with the number they're calling from. Call find_bookings_for_caller, or offer to take a message.";
  }
  return booking;
}

export function rescheduleBookingTool(input: { booking_id: string; new_start_time: string }, ctx: CallerContext): Promise<string> {
  return guarded(async (repo) => {
    const booking = await ownBooking(repo, input.booking_id, ctx);
    if (typeof booking === 'string') return booking;
    const [services, availability] = await Promise.all([repo.activeServices(), repo.availability()]);
    const tz = timezoneOf(availability);
    const service = services.find((s) => s.id === booking.service_id);
    if (!service) return 'That service is no longer offered. Offer to take a message for the team.';

    const start = parseStartTime(input.new_start_time, tz);
    if (!start) return 'new_start_time must be one of the start_time values from find_open_slots.';
    if (!(await isBookableTime(start, service, repo, tz))) {
      return `${formatSpoken(start, tz)} isn't an available time. ${await alternativesNear(start, service, repo, tz)}`;
    }
    const end = new Date(start.getTime() + service.duration_minutes * 60_000);
    const result = await repo.reschedule(booking.id, start, end);
    if (!result.ok) {
      if (result.reason === 'conflict') return `That time was just taken. ${await alternativesNear(start, service, repo, tz)}`;
      if (result.reason === 'not_found') return 'That booking was already cancelled or changed. Call find_bookings_for_caller.';
      return `Rescheduling failed (${result.message}). Apologize and offer to take a message.`;
    }
    const when = formatSpoken(start, tz);
    confirm(result.booking, `Your ${service.name} with ${config.businessName} is moved to ${when}. To change it, call ${displayPhone(config.twilioPhoneNumber)}.`, ctx);
    return `Rescheduled: ${bookingLine(result.booking, services, tz)}. A confirmation text is on its way. Read the new day and time back.`;
  });
}

export function cancelBookingTool(input: { booking_id: string }, ctx: CallerContext): Promise<string> {
  return guarded(async (repo) => {
    const booking = await ownBooking(repo, input.booking_id, ctx);
    if (typeof booking === 'string') return booking;
    const result = await repo.cancel(booking.id);
    if (!result.ok) {
      if (result.reason === 'not_found') return 'That booking was already cancelled.';
      return `Cancelling failed (${result.message}). Apologize and offer to take a message.`;
    }
    const [services, availability] = await Promise.all([repo.activeServices(), repo.availability()]);
    const tz = timezoneOf(availability);
    const service = services.find((s) => s.id === booking.service_id)?.name ?? 'appointment';
    const when = formatSpoken(new Date(booking.starts_at), tz);
    confirm(result.booking, `Your ${service} with ${config.businessName} on ${when} is cancelled. To book again, call ${displayPhone(config.twilioPhoneNumber)}.`, ctx);
    return `Cancelled: ${service} on ${when}. A confirmation text is on its way.`;
  });
}

// The next three days of open times, for the first user message of each call, so
// April can answer "anything Thursday afternoon?" without a tool call.
export async function upcomingAvailabilityContext(now = new Date()): Promise<string> {
  if (!bookingRepo) return 'Booking is not set up. If asked to book, offer to take a message.';
  try {
    const repo = bookingRepo;
    const [services, availability] = await Promise.all([repo.activeServices(), repo.availability()]);
    if (services.length === 0) return 'No services are set up for booking. If asked to book, offer to take a message.';
    const tz = timezoneOf(availability);
    const today = localDateOf(now, tz);
    const sections = await Promise.all(
      services.slice(0, 3).map(async (service) => {
        const slots = await findOpenSlots(today, addDays(today, 2), service, repo, { now });
        const lines = summarizeByDay(slots, slotStepMinutes(service.duration_minutes));
        return `${service.name} (${service.duration_minutes} minutes), open start times every ${slotStepMinutes(service.duration_minutes)} minutes:\n${
          lines.length ? lines.join('\n') : 'Nothing open in the next three days.'
        }`;
      }),
    );
    return `Open appointment times for the next three days (${tz}). Answer quick questions from these without a tool. To book one, pass start_time to book_appointment as the local date and time, e.g. 2026-11-20T14:30:\n${sections.join('\n\n')}`;
  } catch (err) {
    console.error('Could not load availability for call context:', err);
    return 'Availability could not be loaded. Use find_open_slots if the caller wants to book.';
  }
}
