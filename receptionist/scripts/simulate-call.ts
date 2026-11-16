// Simulates a Twilio ConversationRelay call against a local server, no phone needed.
//
//   npm run simulate             real Claude (needs ANTHROPIC_API_KEY in .env)
//   npm run simulate -- --mock   fake LLM, no API keys needed at all
//   add --sms                    actually text the summary to OWNER_CELL_NUMBER
//
// It starts the server in-process, signs requests the way Twilio does, fetches the
// /voice TwiML, then plays a scripted caller over the WebSocket (including an
// interruption) and finishes with the /connect-action handoff.
import 'dotenv/config';
import net from 'node:net';
import twilio from 'twilio';
import WebSocket from 'ws';

const args = new Set(process.argv.slice(2));
const mock = args.has('--mock');

const port = await new Promise<number>((resolve) => {
  const probe = net.createServer().listen(0, () => {
    const { port } = probe.address() as net.AddressInfo;
    probe.close(() => resolve(port));
  });
});

process.env.PUBLIC_BASE_URL = `http://localhost:${port}`;
if (!args.has('--sms')) process.env.DISABLE_SMS = '1';
if (mock) {
  process.env.MOCK_LLM = '1';
  process.env.TWILIO_ACCOUNT_SID ||= 'ACsimulated00000000000000000000000';
  process.env.TWILIO_AUTH_TOKEN ||= 'simulated-auth-token';
  process.env.TWILIO_PHONE_NUMBER ||= '+15550000000';
  process.env.OWNER_CELL_NUMBER ||= '+15550000001';
}

const { start } = await import('../src/server.js');
const { config } = await import('../src/config.js');
const server = await start(port);

const callSid = `CAsim${Date.now()}`;
const caller = '+19045550123';
const sign = (url: string, params: Record<string, string>) =>
  twilio.getExpectedTwilioSignature(config.twilioAuthToken, url, params);

async function postTwilio(path: string, params: Record<string, string>): Promise<string> {
  const url = config.publicBaseUrl + path;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sign(url, params) },
    body: new URLSearchParams(params),
  });
  return `${res.status} ${await res.text()}`;
}

console.log('\n--- POST /voice ---');
console.log(await postTwilio('/voice', { CallSid: callSid, From: caller, To: config.twilioPhoneNumber }));

const script = [
  "Hi, I run a dental office and I heard you guys do an AI receptionist thing?",
  { say: 'So how does it actually work for a business like mine?', interruptAfterTokens: 4 },
  'Sorry, cutting you off. How long does it take to set up?',
  "Cool. I'm Sam, by the way. The number I'm calling from is fine.",
  'Can I talk to a real person about pricing?',
];

const ws = new WebSocket(config.wsUrl, { headers: { 'X-Twilio-Signature': sign(config.wsUrl, {}) } });
let handoffData: string | undefined;

ws.on('open', () => {
  ws.send(JSON.stringify({
    type: 'setup', sessionId: 'VXsim', accountSid: config.twilioAccountSid, callSid,
    from: caller, to: config.twilioPhoneNumber, direction: 'inbound', callStatus: 'IN-PROGRESS', customParameters: {},
  }));
  void runScript();
});

type Reply = { text: string; firstTokenMs?: number };
let onToken: ((token: string, last: boolean) => void) | undefined;

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'text') onToken?.(msg.token, msg.last);
  else if (msg.type === 'end') {
    handoffData = msg.handoffData;
    console.log(`\n[end] handoffData=${handoffData}`);
    ws.close();
  }
});

function say(text: string, interruptAfterTokens?: number): Promise<Reply> {
  console.log(`\nCaller: ${text}`);
  process.stdout.write('April:  ');
  const sentAt = Date.now();
  return new Promise((resolve) => {
    const reply: Reply = { text: '' };
    let tokens = 0;
    onToken = (token, last) => {
      reply.firstTokenMs ??= Date.now() - sentAt;
      reply.text += token;
      process.stdout.write(token);
      if (interruptAfterTokens && ++tokens === interruptAfterTokens) {
        onToken = undefined;
        console.log(' <<caller interrupts>>');
        ws.send(JSON.stringify({ type: 'interrupt', utteranceUntilInterrupt: reply.text, durationUntilInterruptMs: 900 }));
        resolve(reply);
        return;
      }
      if (last) {
        onToken = undefined;
        console.log(`   (first token ${reply.firstTokenMs}ms)`);
        resolve(reply);
      }
    };
    ws.send(JSON.stringify({ type: 'prompt', voicePrompt: text, lang: 'en-US', last: true }));
  });
}

async function runScript(): Promise<void> {
  for (const step of script) {
    if (ws.readyState !== WebSocket.OPEN) break;
    if (typeof step === 'string') {
      await say(step);
    } else {
      await say(step.say, step.interruptAfterTokens);
    }
  }
  // The server sends `end` only after the last line has had time to play, so wait for
  // it; if the receptionist never ends the session, hang up like a caller would.
  setTimeout(() => ws.readyState === WebSocket.OPEN && ws.close(), 12_000);
}

ws.on('close', async () => {
  // Give the server a moment to write the summary.
  await new Promise((r) => setTimeout(r, mock ? 500 : 5000));
  console.log('\n--- POST /connect-action ---');
  console.log(
    await postTwilio('/connect-action', {
      CallSid: callSid,
      SessionStatus: handoffData ? 'ended' : 'completed',
      ...(handoffData ? { HandoffData: handoffData } : {}),
    }),
  );
  console.log(`\nTranscript: logs/*_${callSid}.jsonl`);
  server.close();
  process.exit(0);
});
