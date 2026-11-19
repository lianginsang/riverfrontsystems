import type Anthropic from '@anthropic-ai/sdk';
import {
  bookAppointmentTool,
  cancelBookingTool,
  findBookingsForCallerTool,
  findOpenSlotsTool,
  rescheduleBookingTool,
  type PartOfDay,
} from '../bookings/service.js';
import { leadStore } from '../leads/store.js';
import type { Handoff } from '../relay/types.js';

export const tools: Anthropic.Tool[] = [
  {
    name: 'save_lead',
    description:
      "Save or update the caller's details for the team to follow up. Call once you know their name and what they need; call again to update.",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: "Caller's name" },
        phone: { type: 'string', description: 'Best callback number, digits only with country code if known' },
        reason: { type: 'string', description: 'What they need, in a short phrase' },
        notes: { type: 'string', description: 'Anything else useful: business type, timing, details' },
      },
      required: ['name', 'phone', 'reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'transfer_to_human',
    description:
      'Transfer the call to a person on the team. Use when the caller asks for a person, is upset, or you are stuck. Say you are connecting them first.',
    input_schema: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'Why the call is being transferred' } },
      required: ['reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'find_open_slots',
    description:
      'Look up open appointment start times. Use for dates beyond the three days in the call info, or to narrow a day down. Returns spoken-friendly times with start_time values to book with.',
    input_schema: {
      type: 'object',
      properties: {
        from_date: { type: 'string', description: 'First local date to search, YYYY-MM-DD' },
        to_date: { type: 'string', description: 'Last local date to search, YYYY-MM-DD (defaults to from_date; at most 14 days after it)' },
        part_of_day: { type: 'string', enum: ['morning', 'afternoon', 'evening'], description: 'Only times in this part of the day' },
        service: { type: 'string', description: 'Service name; omit if there is only one' },
      },
      required: ['from_date'],
      additionalProperties: false,
    },
  },
  {
    name: 'book_appointment',
    description:
      'Book an appointment. Only after the caller has confirmed their name, the service, and the exact day and time.',
    input_schema: {
      type: 'object',
      properties: {
        start_time: { type: 'string', description: 'A start_time from find_open_slots, or a local date and time from the call info like 2026-11-20T14:30' },
        customer_name: { type: 'string', description: "Caller's name" },
        customer_phone: { type: 'string', description: 'Number to text the confirmation to; omit to use the caller ID' },
        service: { type: 'string', description: 'Service name; omit if there is only one' },
        notes: { type: 'string', description: 'Anything the team should know' },
      },
      required: ['start_time', 'customer_name'],
      additionalProperties: false,
    },
  },
  {
    name: 'find_bookings_for_caller',
    description:
      "List the caller's upcoming bookings (matched by their caller ID). Use before rescheduling or cancelling to get the booking_id.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'reschedule_booking',
    description: "Move one of the caller's bookings to a new open time, after they confirm the new day and time.",
    input_schema: {
      type: 'object',
      properties: {
        booking_id: { type: 'string', description: 'booking_id from find_bookings_for_caller' },
        new_start_time: { type: 'string', description: 'A start_time from find_open_slots, or a local date and time like 2026-11-20T14:30' },
      },
      required: ['booking_id', 'new_start_time'],
      additionalProperties: false,
    },
  },
  {
    name: 'cancel_booking',
    description: "Cancel one of the caller's bookings, after they confirm which one.",
    input_schema: {
      type: 'object',
      properties: { booking_id: { type: 'string', description: 'booking_id from find_bookings_for_caller' } },
      required: ['booking_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'end_call',
    description: 'Hang up. Use only when the conversation is clearly over, after saying a short goodbye.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

export interface ToolOutcome {
  result: string;
  isError?: boolean;
  // Set when the tool ends the ConversationRelay session.
  handoff?: Handoff;
}

function str(input: Record<string, unknown>, key: string, optional = false): string | undefined {
  const value = input[key];
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (optional && (value === undefined || value === null)) return undefined;
  throw new Error(`"${key}" must be a non-empty string`);
}

export async function runTool(
  name: string,
  rawInput: unknown,
  ctx: { callSid: string; callerId: string },
): Promise<ToolOutcome> {
  const input = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<string, unknown>;
  try {
    switch (name) {
      case 'save_lead': {
        await leadStore.upsert(ctx.callSid, ctx.callerId, {
          name: str(input, 'name')!,
          phone: str(input, 'phone')!,
          reason: str(input, 'reason')!,
          notes: str(input, 'notes', true),
        });
        return { result: 'Saved.' };
      }
      case 'transfer_to_human':
        return { result: 'Transferring.', handoff: { action: 'transfer', reason: str(input, 'reason')! } };
      case 'find_open_slots': {
        const part = str(input, 'part_of_day', true);
        if (part && !['morning', 'afternoon', 'evening'].includes(part)) throw new Error('"part_of_day" must be morning, afternoon or evening');
        return {
          result: await findOpenSlotsTool({
            from_date: str(input, 'from_date')!,
            to_date: str(input, 'to_date', true),
            part_of_day: part as PartOfDay | undefined,
            service: str(input, 'service', true),
          }),
        };
      }
      case 'book_appointment':
        return {
          result: await bookAppointmentTool(
            {
              start_time: str(input, 'start_time')!,
              customer_name: str(input, 'customer_name')!,
              customer_phone: str(input, 'customer_phone', true),
              service: str(input, 'service', true),
              notes: str(input, 'notes', true),
            },
            ctx,
          ),
        };
      case 'find_bookings_for_caller':
        return { result: await findBookingsForCallerTool(ctx) };
      case 'reschedule_booking':
        return {
          result: await rescheduleBookingTool(
            { booking_id: str(input, 'booking_id')!, new_start_time: str(input, 'new_start_time')! },
            ctx,
          ),
        };
      case 'cancel_booking':
        return { result: await cancelBookingTool({ booking_id: str(input, 'booking_id')! }, ctx) };
      case 'end_call':
        return { result: 'Ending call.', handoff: { action: 'hangup' } };
      default:
        return { result: `Unknown tool ${name}`, isError: true };
    }
  } catch (err) {
    return { result: `Invalid input: ${(err as Error).message}`, isError: true };
  }
}
