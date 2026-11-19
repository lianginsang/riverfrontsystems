import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config.js';
import type { AvailabilityRow, Booking, NewBooking, Service, TimeRange, WriteResult } from './types.js';

// Everything the booking logic needs from storage. Supabase in production; an
// in-memory copy for the simulator. Overlap protection lives in the store (the
// database's exclusion constraint), not in the caller.
export interface BookingRepo {
  activeServices(): Promise<Service[]>;
  availability(): Promise<AvailabilityRow[]>;
  blockedBetween(from: Date, to: Date): Promise<TimeRange[]>;
  bookedBetween(from: Date, to: Date): Promise<Booking[]>;
  getBooking(id: string): Promise<Booking | undefined>;
  upcomingForPhone(phone: string, now: Date): Promise<Booking[]>;
  insert(booking: NewBooking): Promise<WriteResult>;
  reschedule(id: string, startsAt: Date, endsAt: Date): Promise<WriteResult>;
  cancel(id: string): Promise<WriteResult>;
}

const EXCLUSION_VIOLATION = '23P01';
const BOOKING_COLUMNS = 'id, service_id, starts_at, ends_at, customer_name, customer_phone, status, source, call_sid, notes';

class SupabaseRepo implements BookingRepo {
  constructor(private readonly db: SupabaseClient) {}

  private static fail(error: { code?: string; message: string }): WriteResult {
    if (error.code === EXCLUSION_VIOLATION) return { ok: false, reason: 'conflict', message: 'overlaps an existing booking' };
    return { ok: false, reason: 'error', message: error.message };
  }

  async activeServices(): Promise<Service[]> {
    const { data, error } = await this.db.from('services').select('id, name, duration_minutes, active').eq('active', true).order('name');
    if (error) throw new Error(`services: ${error.message}`);
    return data;
  }

  async availability(): Promise<AvailabilityRow[]> {
    const { data, error } = await this.db.from('availability').select('weekday, open_time, close_time, timezone');
    if (error) throw new Error(`availability: ${error.message}`);
    return data;
  }

  async blockedBetween(from: Date, to: Date): Promise<TimeRange[]> {
    const { data, error } = await this.db
      .from('blocked_times')
      .select('starts_at, ends_at')
      .lt('starts_at', to.toISOString())
      .gt('ends_at', from.toISOString());
    if (error) throw new Error(`blocked_times: ${error.message}`);
    return data;
  }

  async bookedBetween(from: Date, to: Date): Promise<Booking[]> {
    const { data, error } = await this.db
      .from('bookings')
      .select(BOOKING_COLUMNS)
      .eq('status', 'booked')
      .lt('starts_at', to.toISOString())
      .gt('ends_at', from.toISOString());
    if (error) throw new Error(`bookings: ${error.message}`);
    return data as Booking[];
  }

  async getBooking(id: string): Promise<Booking | undefined> {
    const { data, error } = await this.db.from('bookings').select(BOOKING_COLUMNS).eq('id', id).maybeSingle();
    if (error) throw new Error(`bookings: ${error.message}`);
    return (data as Booking | null) ?? undefined;
  }

  async upcomingForPhone(phone: string, now: Date): Promise<Booking[]> {
    const { data, error } = await this.db
      .from('bookings')
      .select(BOOKING_COLUMNS)
      .eq('customer_phone', phone)
      .eq('status', 'booked')
      .gt('ends_at', now.toISOString())
      .order('starts_at')
      .limit(10);
    if (error) throw new Error(`bookings: ${error.message}`);
    return data as Booking[];
  }

  async insert(booking: NewBooking): Promise<WriteResult> {
    const { data, error } = await this.db.from('bookings').insert(booking).select(BOOKING_COLUMNS).single();
    return error ? SupabaseRepo.fail(error) : { ok: true, booking: data as Booking };
  }

  async reschedule(id: string, startsAt: Date, endsAt: Date): Promise<WriteResult> {
    const { data, error } = await this.db
      .from('bookings')
      .update({ starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString() })
      .eq('id', id)
      .eq('status', 'booked')
      .select(BOOKING_COLUMNS)
      .maybeSingle();
    if (error) return SupabaseRepo.fail(error);
    return data ? { ok: true, booking: data as Booking } : { ok: false, reason: 'not_found', message: 'no booked appointment with that id' };
  }

  async cancel(id: string): Promise<WriteResult> {
    const { data, error } = await this.db
      .from('bookings')
      .update({ status: 'cancelled' })
      .eq('id', id)
      .eq('status', 'booked')
      .select(BOOKING_COLUMNS)
      .maybeSingle();
    if (error) return SupabaseRepo.fail(error);
    return data ? { ok: true, booking: data as Booking } : { ok: false, reason: 'not_found', message: 'no booked appointment with that id' };
  }
}

// In-process stand-in used by `npm run simulate`. Seeded with one service and
// 9-to-5 hours every day so the simulator finds slots whatever day it runs.
export class MemoryRepo implements BookingRepo {
  readonly services: Service[] = [
    { id: '11111111-1111-4111-8111-111111111111', name: 'Consultation call', duration_minutes: 30, active: true },
  ];
  readonly hours: AvailabilityRow[] = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
    weekday,
    open_time: '09:00:00',
    close_time: '17:00:00',
    timezone: 'America/New_York',
  }));
  readonly blocked: TimeRange[] = [];
  readonly bookings: Booking[] = [];

  private static overlapping(a: TimeRange, from: Date, to: Date): boolean {
    return new Date(a.starts_at) < to && new Date(a.ends_at) > from;
  }

  // Mirrors the bookings_no_overlap exclusion constraint. Runs synchronously,
  // so concurrent writes in the simulator race exactly like they would in Postgres.
  private clashes(startsAt: Date, endsAt: Date, ignoreId?: string): boolean {
    return this.bookings.some((b) => b.status === 'booked' && b.id !== ignoreId && MemoryRepo.overlapping(b, startsAt, endsAt));
  }

  async activeServices() { return this.services.filter((s) => s.active); }
  async availability() { return this.hours; }
  async blockedBetween(from: Date, to: Date) { return this.blocked.filter((b) => MemoryRepo.overlapping(b, from, to)); }
  async bookedBetween(from: Date, to: Date) {
    return this.bookings.filter((b) => b.status === 'booked' && MemoryRepo.overlapping(b, from, to));
  }
  async getBooking(id: string) { return this.bookings.find((b) => b.id === id); }
  async upcomingForPhone(phone: string, now: Date) {
    return this.bookings
      .filter((b) => b.customer_phone === phone && b.status === 'booked' && new Date(b.ends_at) > now)
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  }

  async insert(booking: NewBooking): Promise<WriteResult> {
    if (this.clashes(new Date(booking.starts_at), new Date(booking.ends_at))) {
      return { ok: false, reason: 'conflict', message: 'overlaps an existing booking' };
    }
    const row: Booking = { ...booking, id: randomUUID(), status: 'booked' };
    this.bookings.push(row);
    return { ok: true, booking: row };
  }

  async reschedule(id: string, startsAt: Date, endsAt: Date): Promise<WriteResult> {
    const row = this.bookings.find((b) => b.id === id && b.status === 'booked');
    if (!row) return { ok: false, reason: 'not_found', message: 'no booked appointment with that id' };
    if (this.clashes(startsAt, endsAt, id)) return { ok: false, reason: 'conflict', message: 'overlaps an existing booking' };
    row.starts_at = startsAt.toISOString();
    row.ends_at = endsAt.toISOString();
    return { ok: true, booking: row };
  }

  async cancel(id: string): Promise<WriteResult> {
    const row = this.bookings.find((b) => b.id === id && b.status === 'booked');
    if (!row) return { ok: false, reason: 'not_found', message: 'no booked appointment with that id' };
    row.status = 'cancelled';
    return { ok: true, booking: row };
  }
}

// Service-role client: bypasses row-level security. Server-side only. Also used to
// check staff sign-ins for the calendar's transcript requests.
export const supabaseAdmin: SupabaseClient | undefined =
  config.supabaseUrl && config.supabaseServiceRoleKey
    ? createClient(config.supabaseUrl, config.supabaseServiceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
    : undefined;

function createRepo(): BookingRepo | undefined {
  if (config.bookingsBackend === 'memory') return new MemoryRepo();
  if (!supabaseAdmin) {
    console.warn('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set: booking tools are disabled.');
    return undefined;
  }
  return new SupabaseRepo(supabaseAdmin);
}

// undefined when bookings aren't configured; the booking service reports that to April.
export const bookingRepo: BookingRepo | undefined = createRepo();
