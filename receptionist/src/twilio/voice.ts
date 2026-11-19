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
  // Attribute names follow Twilio's ConversationRelay docs exactly. The SDK writes keys
  // through verbatim, and a few (ignoreBackchannel, eotThreshold) are missing or
  // differently cased in its types, hence the cast.
  connect.conversationRelay({
    url: config.wsUrl,
    welcomeGreeting: WELCOME_GREETING,
    ttsProvider: 'ElevenLabs',
    ...(config.elevenLabsVoiceId ? { voice: config.elevenLabsVoiceId } : {}),

    // Deepgram Flux: speech-to-text with its own end-of-turn model, so the caller's
    // turn ends when they're done talking rather than after a fixed silence.
    transcriptionProvider: 'Deepgram',
    speechModel: 'flux',
    // How sure Flux must be that the caller is finished (0.5-0.9, Twilio default 0.8).
    // Lower = faster replies but more cut-offs. Tune with real calls.
    eotThreshold: config.eotThreshold,
    hints: 'Riverfront Systems, AI receptionist, April',

    // Interruptions: the default sensitivity (high) lets speakerphone and road noise
    // cut April off; "yeah" / "okay" while she talks shouldn't stop her either.
    interruptible: 'any',
    interruptSensitivity: config.interruptSensitivity,
    ignoreBackchannel: 'true',

    // Playback events, logged per call so latency can be measured to the moment the
    // caller actually hears April, not just to Claude's first token.
    events: 'speaker-events tokens-played',
  } as Parameters<typeof connect.conversationRelay>[0]);
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
