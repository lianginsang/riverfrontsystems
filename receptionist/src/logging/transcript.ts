import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const logsDir = path.join(config.rootDir, 'logs');

export type TranscriptEntry =
  | { kind: 'call_start'; from: string; to: string }
  | { kind: 'caller'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'interrupted'; spoken: string }
  | { kind: 'tool'; name: string; input: unknown; result: string }
  | { kind: 'latency'; turn: number; firstTokenMs: number; cacheReadTokens?: number }
  | { kind: 'error'; message: string }
  | { kind: 'call_end'; reason: string };

// Appends one JSON line per event to logs/<date>_<callSid>.jsonl.
export class Transcript {
  private readonly stream: fs.WriteStream;
  readonly entries: TranscriptEntry[] = [];

  constructor(readonly callSid: string) {
    fs.mkdirSync(logsDir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    this.stream = fs.createWriteStream(path.join(logsDir, `${date}_${callSid}.jsonl`), { flags: 'a' });
  }

  log(entry: TranscriptEntry): void {
    this.entries.push(entry);
    this.stream.write(JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
    if (entry.kind === 'latency') {
      console.log(`[${this.callSid}] turn ${entry.turn}: first token in ${entry.firstTokenMs}ms (cache read ${entry.cacheReadTokens ?? 0} tokens)`);
    } else if (entry.kind === 'error') {
      console.error(`[${this.callSid}] error: ${entry.message}`);
    }
  }

  // Plain-text conversation, used for the end-of-call summary.
  toText(): string {
    return this.entries
      .map((e) => {
        if (e.kind === 'caller') return `Caller: ${e.text}`;
        if (e.kind === 'assistant') return `Receptionist: ${e.text}`;
        if (e.kind === 'interrupted') return `Receptionist (cut off): ${e.spoken}`;
        if (e.kind === 'tool') return `[${e.name}: ${JSON.stringify(e.input)}]`;
        return null;
      })
      .filter(Boolean)
      .join('\n');
  }

  close(): void {
    this.stream.end();
  }
}
