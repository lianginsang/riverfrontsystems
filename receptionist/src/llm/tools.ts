import type Anthropic from '@anthropic-ai/sdk';
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
      case 'end_call':
        return { result: 'Ending call.', handoff: { action: 'hangup' } };
      default:
        return { result: `Unknown tool ${name}`, isError: true };
    }
  } catch (err) {
    return { result: `Invalid input: ${(err as Error).message}`, isError: true };
  }
}
