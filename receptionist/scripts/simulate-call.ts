// Simulates Twilio ConversationRelay calls against a local server, no phone needed.
//
//   npm run simulate              real Claude (needs ANTHROPIC_API_KEY in .env)
//   npm run simulate -- --mock    fake LLM, no API keys needed; also runs the
//                                 booking checks and exits non-zero if any fail
//   add --supabase                use the real Supabase bookings tables instead of
//                                 an in-memory copy (test rows are deleted after)
//   add --sms                     actually send texts (summary to OWNER_CELL_NUMBER,
//                                 confirmations to the fake caller numbers)
//
// It starts the server in-process, signs requests the way Twilio does, fetches the
// /voice TwiML, plays a scripted caller over the WebSocket (including an
// interruption), and finishes with the /connect-action handoff.
import 'dotenv/config';
import net from 'node:net';
import twilio from 'twilio';
import WebSocket from 'ws';

const args = new Set(process.argv.slice(2));
const mock = args.has('--mock');
const useSupabase = args.has('--supabase');

const port = await new Promise<number>((resolve) => {
  const probe = net.createServer().listen(0, () => {
    const { port } = probe.address() as net.AddressInfo;
    probe.close(() => resolve(port));
  });
});

process.env.PUBLIC_BASE_URL = `http://localhost:${port}`;
if (!args.has('--sms')) process.env.DISABLE_SMS = '1';
if (!useSupabase) process.env.BOOKINGS_BACKEND = 'memory';
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

let simCount = 0;

// One simulated phone call over the ConversationRelay WebSocket.
class SimCall {
  readonly callSid = `CAsim${Date.now()}${++simCount}`;
  handoffData?: string;
  private readonly ws: WebSocket;
  private onToken?: (token: string, last: boolean) => void;
  private readonly opened: Promise<void>;
  private readonly closed: Promise<void>;

  constructor(readonly label: string, readonly caller: string, private readonly stream = false) {
    this.ws = new WebSocket(config.wsUrl, { headers: { 'X-Twilio-Signature': sign(config.wsUrl, {}) } });
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'text') this.onToken?.(msg.token, msg.last);
      else if (msg.type === 'end') {
        this.handoffData = msg.handoffData;
        console.log(`\n[${this.label}] end, handoffData=${this.handoffData}`);
        this.ws.close();
      }
    });
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
    this.closed = new Promise((resolve) => this.ws.on('close', () => resolve()));
  }

  get open(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<this> {
    await this.opened;
    this.ws.send(JSON.stringify({
      type: 'setup', sessionId: 'VXsim', accountSid: config.twilioAccountSid, callSid: this.callSid,
      from: this.caller, to: config.twilioPhoneNumber, direction: 'inbound', callStatus: 'IN-PROGRESS', customParameters: {},
    }));
    return this;
  }

  say(text: string, interruptAfterTokens?: number): Promise<string> {
    if (this.stream) {
      console.log(`\nCaller: ${text}`);
      process.stdout.write('April:  ');
    }
    const sentAt = Date.now();
    return new Promise((resolve) => {
      let reply = '';
      let tokens = 0;
      let firstTokenMs: number | undefined;
      this.onToken = (token, last) => {
        firstTokenMs ??= Date.now() - sentAt;
        reply += token;
        if (this.stream) process.stdout.write(token);
        if (interruptAfterTokens && ++tokens === interruptAfterTokens) {
          this.onToken = undefined;
          console.log(' <<caller interrupts>>');
          this.ws.send(JSON.stringify({ type: 'interrupt', utteranceUntilInterrupt: reply, durationUntilInterruptMs: 900 }));
          resolve(reply);
          return;
        }
        if (last) {
          this.onToken = undefined;
          if (this.stream) console.log(`   (first token ${firstTokenMs}ms)`);
          else console.log(`\n[${this.label}] Caller: ${text}\n[${this.label}] April:  ${reply}`);
          resolve(reply);
        }
      };
      this.ws.send(JSON.stringify({ type: 'prompt', voicePrompt: text, lang: 'en-US', last: true }));
    });
  }

  // Waits for the server to end the session (transfer / goodbye), else hangs up.
  async hangUp(waitForServerMs = 0): Promise<void> {
    if (waitForServerMs) await Promise.race([this.closed, new Promise((r) => setTimeout(r, waitForServerMs))]);
    if (this.open) this.ws.close();
    await this.closed;
  }
}

// --- 1. The original conversation: greeting TwiML, interruption, transfer ---------

const mainCaller = '+19045550123';
const main = new SimCall('main', mainCaller, true);
console.log('\n--- POST /voice ---');
console.log(await postTwilio('/voice', { CallSid: main.callSid, From: mainCaller, To: config.twilioPhoneNumber }));
await main.connect();

for (const step of [
  "Hi, I run a dental office and I heard you guys do an AI receptionist thing?",
  { say: 'So how does it actually work for a business like mine?', interruptAfterTokens: 4 },
  'Sorry, cutting you off. How long does it take to set up?',
  "Cool. I'm Sam, by the way. The number I'm calling from is fine.",
  'Can I talk to a real person about pricing?',
]) {
  if (!main.open) break;
  if (typeof step === 'string') await main.say(step);
  else await main.say(step.say, step.interruptAfterTokens);
}
// The server sends `end` only after the last line has had time to play.
await main.hangUp(12_000);
await new Promise((r) => setTimeout(r, mock ? 500 : 5000)); // let the summary go out
console.log('\n--- POST /connect-action ---');
console.log(
  await postTwilio('/connect-action', {
    CallSid: main.callSid,
    SessionStatus: main.handoffData ? 'ended' : 'completed',
    ...(main.handoffData ? { HandoffData: main.handoffData } : {}),
  }),
);

// --- 2. Bookings -------------------------------------------------------------------

const { bookingRepo } = await import('../src/bookings/repo.js');
const { findOpenSlots } = await import('../src/bookings/service.js');
const { addDays, formatSpoken, localDateOf, toLocalIso } = await import('../src/bookings/time.js');

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got: ${detail}`}`);
}

if (!bookingRepo) {
  console.log('\nBookings are not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY); skipping booking checks.');
} else if (!mock) {
  // Real Claude: an unscripted booking conversation to eyeball, no assertions.
  console.log('\n--- Booking conversation (real Claude) ---');
  const call = await new SimCall('booking', '+19045550144', true).connect();
  for (const line of [
    'Hi, can I book a consultation call for tomorrow afternoon?',
    'The first one works. My name is Sam Tester.',
    "Yes, that's right.",
  ]) {
    if (call.open) await call.say(line);
  }
  await call.hangUp();
} else {
  console.log('\n--- Booking checks (mock LLM) ---');
  const [service] = await bookingRepo.activeServices();
  const tz = (await bookingRepo.availability())[0]?.timezone ?? config.businessTimezone;
  const today = localDateOf(new Date(), tz);
  const slots = service ? await findOpenSlots(today, addDays(today, 6), service, bookingRepo) : [];
  if (!service || slots.length < 8) {
    check('enough open slots to run the booking checks', false, `${slots.length} slots for ${service?.name ?? 'no service'}`);
  } else {
    const [s1, s2, s3] = [slots[2], slots[5], slots[7]];
    const iso = (slot: (typeof slots)[number]) => toLocalIso(slot.start, slot.tz);
    const directive = (tool: string, input: object = {}) => `[[${tool} ${JSON.stringify(input)}]]`;

    const alice = await new SimCall('alice', '+19045550161').connect();
    const bob = await new SimCall('bob', '+19045550162').connect();

    let reply = await alice.say(`Anything open on ${localDateOf(s1.start, tz)}? ${directive('find_open_slots', { from_date: localDateOf(s1.start, tz) })}`);
    check('find_open_slots lists times', reply.includes('Open times for') && reply.includes('start_time'), reply);

    reply = await alice.say(`Book it. ${directive('book_appointment', { start_time: iso(s1), customer_name: 'Alice Test' })}`);
    check('alice books a slot', reply.includes('Booked:'), reply);

    reply = await bob.say(`I want that same time. ${directive('book_appointment', { start_time: iso(s1), customer_name: 'Bob Test' })}`);
    check('bob is told the slot was just taken, with new options', reply.includes('just taken') && reply.includes('start_time'), reply);

    const threeAm = `${localDateOf(s1.start, tz)}T03:00`;
    reply = await bob.say(`How about 3 AM? ${directive('book_appointment', { start_time: threeAm, customer_name: 'Bob Test' })}`);
    check('a time outside opening hours is refused', reply.includes("isn't an available time"), reply);

    reply = await alice.say(`What do I have booked? ${directive('find_bookings_for_caller')}`);
    const bookingId = /booking_id ([0-9a-f-]{36})/.exec(reply)?.[1];
    check('alice finds her booking by caller ID', Boolean(bookingId), reply);

    if (bookingId) {
      reply = await bob.say(`Cancel this one. ${directive('cancel_booking', { booking_id: bookingId })}`);
      check("bob can't cancel alice's booking", reply.includes("can't be found"), reply);

      reply = await alice.say(`Move it. ${directive('reschedule_booking', { booking_id: bookingId, new_start_time: iso(s2) })}`);
      check('alice reschedules', reply.includes('Rescheduled:') && reply.includes(formatSpoken(s2.start, tz)), reply);

      reply = await bob.say(`Is the old time free now? ${directive('book_appointment', { start_time: iso(s1), customer_name: 'Bob Test' })}`);
      check('the old slot opens up after rescheduling', reply.includes('Booked:'), reply);

      reply = await alice.say(`Cancel it. ${directive('cancel_booking', { booking_id: bookingId })}`);
      check('alice cancels', reply.includes('Cancelled:'), reply);

      reply = await alice.say(`Anything left? ${directive('find_bookings_for_caller')}`);
      check('alice has no upcoming bookings after cancelling', reply.includes('No upcoming bookings'), reply);
    }

    // Two callers book the same slot at the same moment: exactly one may win.
    const carol = await new SimCall('carol', '+19045550163').connect();
    const dave = await new SimCall('dave', '+19045550164').connect();
    const race = await Promise.all([
      carol.say(`Book it. ${directive('book_appointment', { start_time: iso(s3), customer_name: 'Carol Test' })}`),
      dave.say(`Book it. ${directive('book_appointment', { start_time: iso(s3), customer_name: 'Dave Test' })}`),
    ]);
    const winners = race.filter((r) => r.includes('Booked:')).length;
    const losers = race.filter((r) => r.includes('just taken')).length;
    check('racing callers: one booked, one told it was just taken', winners === 1 && losers === 1, race.join('  ||  '));

    await Promise.all([alice, bob, carol, dave].map((c) => c.hangUp()));
  }

  if (useSupabase) {
    // Remove the rows this run created in the real bookings table.
    const { createClient } = await import('@supabase/supabase-js');
    const db = createClient(config.supabaseUrl!, config.supabaseServiceRoleKey!, { auth: { persistSession: false } });
    const { error, count } = await db.from('bookings').delete({ count: 'exact' }).like('call_sid', 'CAsim%');
    console.log(error ? `Cleanup failed: ${error.message}` : `Deleted ${count} test bookings from Supabase.`);
  }
}

await new Promise((r) => setTimeout(r, 500)); // let call summaries finish
console.log(`\nTranscripts: logs/*_CAsim*.jsonl`);
if (mock && bookingRepo) console.log(failures ? `\n${failures} booking check(s) FAILED` : '\nAll booking checks passed');
server.close();
process.exit(failures ? 1 : 0);
