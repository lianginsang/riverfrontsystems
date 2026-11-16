import { Router } from 'express';
import twilio from 'twilio';
import { config } from '../config.js';
import type { Handoff } from '../relay/types.js';
import { requireTwilioSignature } from './signature.js';

const WELCOME_GREETING = "Hi, thanks for calling Riverfront Systems, this is April. How can I help?";

export const voiceRouter = Router();

// Twilio's "A call comes in" webhook.
voiceRouter.post('/voice', requireTwilioSignature, (_req, res) => {
  const response = new twilio.twiml.VoiceResponse();
  const connect = response.connect({ action: `${config.publicBaseUrl}/connect-action` });
  connect.conversationRelay({
    url: config.wsUrl,
    welcomeGreeting: WELCOME_GREETING,
    ttsProvider: 'ElevenLabs',
    ...(config.elevenLabsVoiceId ? { voice: config.elevenLabsVoiceId } : {}),
    interruptible: 'any',
  });
  res.type('text/xml').send(response.toString());
});

// Twilio calls this when the ConversationRelay session ends: the app sent `end`
// (transfer or hang up), the caller hung up, or the session failed.
voiceRouter.post('/connect-action', requireTwilioSignature, (req, res) => {
  const { CallSid, SessionStatus, HandoffData, ErrorCode, ErrorMessage } = req.body as Record<string, string | undefined>;
  const response = new twilio.twiml.VoiceResponse();

  let handoff: Handoff | undefined;
  try {
    handoff = HandoffData ? (JSON.parse(HandoffData) as Handoff) : undefined;
  } catch {
    console.warn(`[${CallSid}] unreadable HandoffData: ${HandoffData}`);
  }

  if (handoff?.action === 'transfer') {
    console.log(`[${CallSid}] transferring to owner: ${handoff.reason}`);
    response.dial(config.ownerCellNumber);
  } else if (SessionStatus === 'failed') {
    // The WebSocket or AI failed mid-call: don't drop the caller, send them to a person.
    console.error(`[${CallSid}] session failed (${ErrorCode}: ${ErrorMessage}); transferring to owner`);
    response.say("Sorry, we're having technical trouble. Connecting you now.");
    response.dial(config.ownerCellNumber);
  } else {
    response.hangup();
  }
  res.type('text/xml').send(response.toString());
});
