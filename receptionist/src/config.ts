import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  return value;
}

const mockLlm = process.env.MOCK_LLM === '1';
const publicBaseUrl = required('PUBLIC_BASE_URL').replace(/\/+$/, '');

export const config = {
  port: Number(process.env.PORT ?? 8080),
  mockLlm,
  // Set by the simulator so test runs never text the owner.
  disableSms: process.env.DISABLE_SMS === '1',

  anthropicApiKey: mockLlm ? process.env.ANTHROPIC_API_KEY ?? '' : required('ANTHROPIC_API_KEY'),
  model: 'claude-haiku-5-5',

  twilioAccountSid: required('TWILIO_ACCOUNT_SID'),
  twilioAuthToken: required('TWILIO_AUTH_TOKEN'),
  twilioPhoneNumber: required('TWILIO_PHONE_NUMBER'),
  ownerCellNumber: required('OWNER_CELL_NUMBER'),
  elevenLabsVoiceId: process.env.ELEVENLABS_VOICE_ID?.trim() || undefined,

  // Turn-taking tuning (see src/twilio/voice.ts). Override in .env without a code change.
  eotThreshold: process.env.EOT_THRESHOLD?.trim() || '0.7',
  interruptSensitivity: process.env.INTERRUPT_SENSITIVITY?.trim() || 'medium',

  publicBaseUrl,
  // The exact URL placed in the TwiML; Twilio signs the WebSocket handshake against it.
  wsUrl: publicBaseUrl.replace(/^http/, 'ws') + '/ws',

  rootDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
};
