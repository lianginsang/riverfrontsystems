// Row shapes for the booking tables in supabase/schema.sql (Migration 2).

export interface Service {
  id: string;
  name: string;
  duration_minutes: number;
  active: boolean;
}

export interface AvailabilityRow {
  weekday: number; // 0 = Sunday ... 6 = Saturday
  open_time: string; // 'HH:MM:SS', local to `timezone`
  close_time: string;
  timezone: string;
}

export interface TimeRange {
  starts_at: string; // ISO timestamp
  ends_at: string;
}

export interface Booking extends TimeRange {
  id: string;
  service_id: string;
  customer_name: string;
  customer_phone: string;
  status: 'booked' | 'cancelled';
  source: 'ai' | 'staff';
  call_sid: string | null;
  notes: string | null;
}

export type NewBooking = Omit<Booking, 'id' | 'status'>;

// A write either lands, or loses to the no-overlap constraint (someone else
// holds an overlapping 'booked' row), or fails for some other reason.
export type WriteResult =
  | { ok: true; booking: Booking }
  | { ok: false; reason: 'conflict' | 'not_found' | 'error'; message: string };
