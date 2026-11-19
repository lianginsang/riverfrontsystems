import twilio from 'twilio';
import { config } from '../config.js';

const twilioClient = twilio(config.twilioAccountSid, config.twilioAuthToken);

// All outgoing texts go through here so DISABLE_SMS (set by the simulator) covers them.
export async function sendSms(to: string, body: string, logPrefix: string): Promise<void> {
  if (config.disableSms) {
    console.log(`${logPrefix} SMS disabled, would have texted ${to}:\n${body}`);
    return;
  }
  await twilioClient.messages.create({ from: config.twilioPhoneNumber, to, body });
  console.log(`${logPrefix} texted ${to}`);
}
