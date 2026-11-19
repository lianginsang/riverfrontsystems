# Riverfront AI Receptionist

Answers inbound calls on a Twilio number with an AI receptionist. Twilio ConversationRelay handles speech-to-text and ElevenLabs text-to-speech; Claude (`claude-haiku-5-5`) writes the replies, streamed token by token. Each call is logged, and a summary is texted to the owner when it ends.

```
Caller ── Twilio number ── POST /voice ──> TwiML <Connect><ConversationRelay>
                              │
                              └── wss /ws <──> this server <──> Claude (streaming + tools)
                                                   │
          session ends (transfer / hang up / caller hangs up)
                              └── POST /connect-action ──> <Dial owner> or <Hangup>
                                  WebSocket close ──> summary SMS to owner
```

## Files

| Path | What it is |
|---|---|
| `prompts/system-prompt.md` | **The receptionist's personality, business info, FAQs and goals. Edit this.** Restart the server after editing. |
| `src/twilio/voice.ts` | `/voice` webhook (TwiML, welcome greeting) and `/connect-action` (transfer or hang up) |
| `src/relay/session.ts` | One call: history, streaming, interruptions, tool calls, error recovery |
| `src/llm/claude.ts` | Claude streaming request, prompt caching, mock mode |
| `src/llm/tools.ts` | Tool definitions and input validation: leads, bookings, transfer, hang up |
| `src/bookings/` | Booking module: open-slot math (`slots.ts`, `time.ts`), Supabase + in-memory storage (`repo.ts`), the operations April's tools call (`service.ts`) |
| `src/leads/store.ts` | `LeadStore` interface + JSON file implementation (`data/leads.json`) |
| `src/calls/summary.ts` | End-of-call summary SMS |
| `scripts/simulate-call.ts` | Fake ConversationRelay calls for testing, including booking checks, no phone needed |
| `logs/` | One `<date>_<CallSid>.jsonl` transcript per call, including per-turn latency |

## Run locally

Requires Node 20+ and [ngrok](https://ngrok.com/download).

```bash
cd receptionist
npm install
cp .env.example .env        # fill in the values
ngrok http 8080             # in a second terminal; copy the https URL
```

Set `PUBLIC_BASE_URL` in `.env` to the ngrok https URL (no trailing slash), then:

```bash
npm run dev
```

Point your Twilio number at `https://<your-ngrok>.ngrok-free.app/voice` (see **Twilio console settings** below) and call it.

`PUBLIC_BASE_URL` must exactly match the URL Twilio calls, because Twilio signs every request and the server rejects anything whose signature doesn't match. A free ngrok URL changes every time ngrok restarts, so update `.env` and the Twilio webhook when it does.

## Test without a phone call

```bash
npm run simulate -- --mock              # fake LLM, needs no keys; runs the booking checks
npm run simulate                        # real Claude, needs ANTHROPIC_API_KEY in .env
npm run simulate -- --mock --supabase   # booking checks against your real Supabase tables
npm run simulate -- --sms               # also really sends texts
```

The simulator starts the server, fetches the `/voice` TwiML, plays a scripted caller over the WebSocket (including one interruption and a request for a person), then calls `/connect-action`. It prints each reply as it streams, with time to first token.

With `--mock` it then runs booking checks and exits non-zero if any fail: booking a slot, a second caller asking for that taken slot, a time outside opening hours, one caller trying to cancel another's booking, rescheduling, cancelling, and two callers booking the same slot at the same moment. Bookings use an in-memory copy of the tables unless you add `--supabase`, which writes real rows (call SIDs starting `CAsim`) and deletes them at the end.

## Appointment booking

April books, reschedules and cancels appointments in Supabase, the same tables the staff calendar uses. The tables are defined in `supabase/schema.sql` under "Migration 2".

**Setup**

1. Supabase dashboard → **SQL Editor** → **New query**: paste the Migration 2 section of `supabase/schema.sql` and run it. It creates the tables, row-level security and the Realtime publication for `bookings`, so there's no separate Realtime toggle to flip.
2. Make yourself staff, and add at least one service and your weekly hours (the snippets are at the bottom of Migration 2).
3. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (Project Settings → API → `service_role`) in `.env` and on Render. The service role key bypasses row-level security, so it only ever lives on the server.

**How it works**

- When a call connects, the server loads the next three days of open start times and adds them to April's first message (with caller ID and the current time). She answers "anything Thursday afternoon?" from that without a tool call. The system prompt stays byte-identical so it keeps hitting the prompt cache.
- Open times are calculated in `src/bookings/slots.ts`, never by the model: weekly hours, blocked times, existing bookings, service length, the business time zone, and a 30-minute minimum notice.
- Double-booking is prevented by the database itself: the `bookings_no_overlap` exclusion constraint rejects a booking that overlaps another `booked` one. When that happens (someone took the slot a moment earlier), the tool tells April "That time was just taken" with fresh options.
- Callers can only find, move or cancel bookings whose phone number matches their caller ID.
- After a booking, reschedule or cancellation, the caller gets a confirmation text (skipped when `DISABLE_SMS=1`).
- Without the Supabase variables the server still runs; the booking tools tell April to take a message instead.

## Latency and caching

Every turn logs the time from receiving the caller's finished utterance to the first token sent back to Twilio:

```
[CA123...] turn 3: first token in 612ms (cache read 1840 tokens)
```

The same number is in the call's `logs/*.jsonl` as `{"kind":"latency",...}`. `cache read` should be above zero from the second turn on; if it stays at 0, something is changing the system prompt between requests.

Latency choices made in the code: thinking is turned off and effort is `low` (`src/llm/claude.ts`), retries are capped at one with a 15s timeout, and the per-call caller ID and time go in the first user message rather than the system prompt, so the cached system prompt is identical across calls.

## Turn-taking and interruptions

Set in `src/twilio/voice.ts`:

- **Speech-to-text is Deepgram Flux** (`speechModel="flux"`). Flux has its own end-of-turn model, so April replies when the caller is done talking instead of after a fixed silence.
- **`EOT_THRESHOLD`** (default `0.7`, range 0.5-0.9) is how sure Flux must be that the caller finished. If April cuts people off mid-sentence (especially while they read out a number), raise it. If she feels slow to answer, lower it.
- **`INTERRUPT_SENSITIVITY`** (default `medium`): if noise or speakerphone echo stops April mid-sentence, set `low`. If callers have to talk over her for a while before she stops, set `high`.
- **`ignoreBackchannel`** is on, so "yeah", "uh-huh" and "okay" while April talks don't stop her.

Both variables can be changed in `.env` (or the Render dashboard) without touching code.

The TwiML also subscribes to `speaker-events` and `tokens-played`. Every such message is written to the call's `logs/*.jsonl` as `{"kind":"relay_event",...}` with `msSincePrompt`: milliseconds since the caller's final transcript arrived. The first playback event after a prompt shows how long the caller actually waited to hear April, which is a truer number than time to first token.

## How calls end

- **Transfer:** Claude calls `transfer_to_human`. The server waits for "let me connect you" to finish playing, sends ConversationRelay `end` with `{"action":"transfer"}`, and `/connect-action` returns `<Dial>` to `OWNER_CELL_NUMBER`. The caller ID you see is the original caller.
- **Hang up:** Claude calls `end_call` after saying goodbye. `/connect-action` returns `<Hangup/>`.
- **Errors:** if a Claude request fails, the receptionist apologizes and offers a transfer. A second failure in a row transfers automatically. If the WebSocket itself fails, `/connect-action` gets `SessionStatus=failed` and dials the owner.
- In every case the summary text goes out when the WebSocket closes. On a transfer it usually arrives while your phone is ringing.

## Deploy (Render)

Must be a long-running server, not serverless, because each call holds a WebSocket open.

1. Render dashboard → **New → Web Service** → connect this repo.
2. **Root Directory:** `receptionist`
3. **Runtime:** Node. **Build Command:** `npm ci && npm run build`. **Start Command:** `npm start`
4. **Environment:** add every variable from `.env.example`. Set `PUBLIC_BASE_URL` to the service URL, e.g. `https://riverfront-receptionist.onrender.com` (you can edit it after the first deploy shows you the URL). Don't set `PORT`; Render provides it.
5. Use a paid instance. Free instances sleep when idle, and the first call after a sleep will time out while it wakes up.
6. Point the Twilio webhook at `https://<service>.onrender.com/voice`.

Render's disk is wiped on every deploy, so `data/leads.json` and `logs/` don't survive redeploys. The summary SMS still reaches you. To keep leads, add a Render persistent disk mounted at `receptionist/data`, or implement `LeadStore` against a database (the site already uses Supabase).

## Twilio console settings

1. **Phone Numbers → Manage → Active numbers →** your number → **Voice Configuration**
   - **Configure with:** Webhook, TwiML Bin, Function, Studio Flow, Proxy Service
   - **A call comes in:** Webhook, `https://<PUBLIC_BASE_URL>/voice`, **HTTP POST**
   - Save.
2. **Voice → Settings → General:** ConversationRelay requires accepting the **Predictive and Generative AI/ML Features Addendum**. Turn it on if it isn't already.
3. **Messaging (for the summary text):** a US number texting a US cell needs A2P 10DLC registration (**Messaging → Regulatory Compliance**), or texts may be blocked. A trial account can only text verified numbers, so verify `OWNER_CELL_NUMBER` under **Phone Numbers → Verified Caller IDs**.
