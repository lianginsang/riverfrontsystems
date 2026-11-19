import type Anthropic from '@anthropic-ai/sdk';
import type { WebSocket } from 'ws';
import { sendCallSummary } from '../calls/summary.js';
import { streamReply, type ReplyStream } from '../llm/claude.js';
import { runTool } from '../llm/tools.js';
import { Transcript } from '../logging/transcript.js';
import type { Handoff, IncomingMessage, OutgoingMessage, SetupMessage } from './types.js';

const MAX_TOOL_ROUNDS = 4;

export const sessions = new Map<string, CallSession>();

export class CallSession {
  readonly callSid: string;
  readonly from: string;
  private readonly startedAt = Date.now();
  private readonly transcript: Transcript;

  private history: Anthropic.MessageParam[] = [];
  // Index in history where the latest assistant turn begins (right after its user message).
  private turnStart = 0;
  // Bumped whenever a turn is cancelled, so stale stream callbacks ignore themselves.
  private turnId = 0;
  private turnCount = 0;
  private current?: ReplyStream;
  private consecutiveFailures = 0;
  // When the latest final caller prompt arrived; relay events are timed against it.
  private lastPromptAt?: number;
  private outcome = 'caller hung up';
  private ending = false;
  private finished = false;

  constructor(private readonly ws: WebSocket, setup: SetupMessage) {
    this.callSid = setup.callSid;
    this.from = setup.from;
    this.transcript = new Transcript(setup.callSid);
    this.transcript.log({ kind: 'call_start', from: setup.from, to: setup.to });
  }

  handle(msg: IncomingMessage): void {
    switch (msg.type) {
      case 'prompt':
        if (msg.last === false) return; // partial prompt; wait for the final one
        this.lastPromptAt = Date.now();
        this.onPrompt(msg.voicePrompt);
        break;
      case 'interrupt':
        this.transcript.log({ kind: 'interrupted', spoken: msg.utteranceUntilInterrupt });
        this.cancelTurn(msg.utteranceUntilInterrupt);
        break;
      case 'dtmf':
        this.onPrompt(`(caller pressed ${msg.digit} on the keypad)`);
        break;
      case 'error':
        this.transcript.log({ kind: 'error', message: `ConversationRelay: ${msg.description}` });
        break;
      default:
        // info, speaker events, tokens-played, and anything new. msSincePrompt on the
        // first playback event after a prompt is the delay the caller actually hears
        // (minus Flux's end-of-turn wait, which happens before the prompt arrives).
        this.transcript.log({
          kind: 'relay_event',
          type: (msg as { type: string }).type,
          msSincePrompt: this.lastPromptAt === undefined ? undefined : Date.now() - this.lastPromptAt,
          data: msg,
        });
    }
  }

  private send(msg: OutgoingMessage): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private onPrompt(text: string): void {
    if (this.ending || !text.trim()) return;
    // The caller spoke while a reply was still generating: drop the unfinished reply.
    if (this.current) this.cancelTurn();

    this.transcript.log({ kind: 'caller', text });
    // Per-call context goes in the first user message, not the system prompt, so the
    // system prompt stays identical across calls and keeps hitting the cache.
    const content =
      this.history.length === 0
        ? `[Call info: caller ID ${this.from}. Current time ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} Eastern.]\n${text}`
        : text;
    this.appendUser(content);
    this.turnStart = this.history.length;
    void this.runTurn(++this.turnId);
  }

  // Consecutive user messages (e.g. after an interrupt with nothing spoken) are merged.
  private appendUser(text: string): void {
    const last = this.history[this.history.length - 1];
    if (last?.role === 'user') {
      last.content =
        typeof last.content === 'string'
          ? `${last.content}\n${text}`
          : [...last.content, { type: 'text', text }];
    } else {
      this.history.push({ role: 'user', content: text });
    }
  }

  private async runTurn(id: number): Promise<void> {
    const turn = ++this.turnCount;
    const startedAt = Date.now();
    let firstTokenMs: number | undefined;
    let cacheReadTokens: number | undefined;
    let spoken = '';

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const stream = streamReply(this.history, (delta) => {
          if (id !== this.turnId) return;
          firstTokenMs ??= Date.now() - startedAt;
          spoken += delta;
          this.send({ type: 'text', token: delta, last: false });
        });
        this.current = stream;
        const reply = await stream.done;
        if (id !== this.turnId) return;
        if (round === 0) cacheReadTokens = reply.cacheReadTokens;

        this.history.push({ role: 'assistant', content: reply.content });
        if (reply.stopReason !== 'tool_use') break;

        let handoff: Handoff | undefined;
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const block of reply.content) {
          if (block.type !== 'tool_use') continue;
          const outcome = await runTool(block.name, block.input, { callSid: this.callSid, callerId: this.from });
          this.transcript.log({ kind: 'tool', name: block.name, input: block.input, result: outcome.result });
          results.push({ type: 'tool_result', tool_use_id: block.id, content: outcome.result, is_error: outcome.isError });
          handoff ??= outcome.handoff;
        }
        if (id !== this.turnId) return;
        this.history.push({ role: 'user', content: results });

        if (handoff) {
          this.finishSpeaking(spoken);
          this.logLatency(turn, firstTokenMs, cacheReadTokens);
          await this.endSession(handoff, spoken);
          return;
        }
      }

      this.finishSpeaking(spoken);
      this.logLatency(turn, firstTokenMs, cacheReadTokens);
      this.consecutiveFailures = 0;
    } catch (err) {
      if (id !== this.turnId) return; // cancelled by an interrupt; not an error
      this.transcript.log({ kind: 'error', message: `LLM turn failed: ${(err as Error).message}` });
      this.history.splice(this.turnStart);

      if (++this.consecutiveFailures >= 2) {
        const line = "Sorry, I'm having trouble on my end. Let me connect you with someone.";
        this.send({ type: 'text', token: (spoken ? ' ' : '') + line, last: true });
        this.transcript.log({ kind: 'assistant', text: line });
        await this.endSession({ action: 'transfer', reason: 'Assistant error' }, spoken + line);
      } else {
        const line = "Sorry, I'm having a little trouble on my end. Could you say that again, or would you like me to connect you with someone?";
        this.send({ type: 'text', token: (spoken ? ' ' : '') + line, last: true });
        this.transcript.log({ kind: 'assistant', text: line });
        this.history.push({ role: 'assistant', content: line });
      }
    } finally {
      if (id === this.turnId) this.current = undefined;
    }
  }

  private finishSpeaking(spoken: string): void {
    this.send({ type: 'text', token: '', last: true });
    if (spoken.trim()) this.transcript.log({ kind: 'assistant', text: spoken.trim() });
  }

  private logLatency(turn: number, firstTokenMs: number | undefined, cacheReadTokens: number | undefined): void {
    if (firstTokenMs !== undefined) this.transcript.log({ kind: 'latency', turn, firstTokenMs, cacheReadTokens });
  }

  // Stops the in-flight reply and rewrites the latest assistant turn in history to only
  // what the caller actually heard. Covers both a reply still streaming and one that
  // finished streaming but was still being played when the caller cut in.
  private cancelTurn(spoken?: string): void {
    this.turnId++;
    this.current?.abort();
    this.current = undefined;
    if (this.history.length === 0) return;
    this.history.splice(this.turnStart);
    if (spoken?.trim()) this.history.push({ role: 'assistant', content: spoken.trim() });
  }

  private async endSession(handoff: Handoff, spoken: string): Promise<void> {
    this.ending = true;
    this.outcome = handoff.action === 'transfer' ? `transferred: ${handoff.reason}` : 'ended by assistant';
    // `end` hands the call back to Twilio immediately, so give the goodbye or
    // "let me connect you" line time to play first (~15 characters per second).
    const delayMs = Math.min(10_000, 1_200 + spoken.length * 65);
    await new Promise((r) => setTimeout(r, delayMs));
    this.send({ type: 'end', handoffData: JSON.stringify(handoff) });
  }

  // Called once when the WebSocket closes: the caller hung up, or the session ended.
  async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.turnId++;
    this.current?.abort();
    this.transcript.log({ kind: 'call_end', reason: this.outcome });
    try {
      await sendCallSummary({
        callSid: this.callSid,
        from: this.from,
        startedAt: this.startedAt,
        transcript: this.transcript,
        outcome: this.outcome,
      });
    } catch (err) {
      console.error(`[${this.callSid}] failed to send summary:`, err);
    } finally {
      this.transcript.close();
      sessions.delete(this.callSid);
    }
  }
}
