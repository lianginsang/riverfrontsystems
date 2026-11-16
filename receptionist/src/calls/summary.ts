import twilio from 'twilio';
import { config } from '../config.js';
import { leadStore } from '../leads/store.js';
import { summarizeCall } from '../llm/claude.js';
import type { Transcript } from '../logging/transcript.js';

const twilioClient = twilio(config.twilioAccountSid, config.twilioAuthToken);

export async function sendCallSummary(opts: {
  callSid: string;
  from: string;
  startedAt: number;
  transcript: Transcript;
  outcome: string;
}): Promise<void> {
  const minutes = Math.max(1, Math.round((Date.now() - opts.startedAt) / 60_000));
  const said = opts.transcript.entries.some((e) => e.kind === 'caller');

  let summary: string;
  if (!said) {
    summary = 'Caller hung up without saying anything.';
  } else {
    try {
      summary = await summarizeCall(opts.transcript.toText());
    } catch (err) {
      console.error(`[${opts.callSid}] summary failed:`, err);
      summary = 'Summary unavailable; see the call log.';
    }
  }

  const lead = await leadStore.getByCall(opts.callSid).catch(() => undefined);
  const leadLine = lead ? `\nLead: ${lead.name}, ${lead.phone}, ${lead.reason}` : '';
  const body = `Call from ${opts.from} (~${minutes} min, ${opts.outcome}):\n${summary}${leadLine}`.slice(0, 1500);

  if (config.disableSms) {
    console.log(`[${opts.callSid}] SMS disabled, would have sent:\n${body}`);
    return;
  }
  await twilioClient.messages.create({ from: config.twilioPhoneNumber, to: config.ownerCellNumber, body });
  console.log(`[${opts.callSid}] summary texted to owner`);
}
