import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { tools } from './tools.js';

const client = new Anthropic({
  apiKey: config.anthropicApiKey || 'mock',
  // A caller is waiting on the line: fail fast rather than retrying for minutes.
  maxRetries: 1,
  timeout: 15_000,
});

// Read once at startup and never modified, so the cached prefix stays byte-identical.
const systemPrompt = fs.readFileSync(path.join(config.rootDir, 'prompts', 'system-prompt.md'), 'utf8');

export interface Reply {
  content: Anthropic.ContentBlock[];
  stopReason: Anthropic.StopReason | null;
  cacheReadTokens?: number;
}

export interface ReplyStream {
  done: Promise<Reply>;
  abort(): void;
}

export function streamReply(messages: Anthropic.MessageParam[], onText: (delta: string) => void): ReplyStream {
  if (config.mockLlm) return mockReply(messages, onText);

  const stream = client.messages.stream({
    model: config.model,
    max_tokens: 1024,
    // Thinking adds a pause before every spoken reply; a receptionist doesn't need it.
    thinking: { type: 'disabled' },
    output_config: { effort: 'low' },
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    tools,
    messages,
  });
  stream.on('text', (delta) => onText(delta));

  return {
    abort: () => stream.abort(),
    done: stream.finalMessage().then((msg) => ({
      content: msg.content,
      stopReason: msg.stop_reason,
      cacheReadTokens: msg.usage.cache_read_input_tokens ?? undefined,
    })),
  };
}

export async function summarizeCall(transcript: string): Promise<string> {
  if (config.mockLlm) return `(mock summary) ${transcript.slice(0, 200)}`;

  const msg = await client.messages.create({
    model: config.model,
    max_tokens: 400,
    thinking: { type: 'disabled' },
    output_config: { effort: 'low' },
    system:
      'Summarize this phone call for the business owner in under 300 characters of plain text: who called, what they want, and any follow-up needed. No markdown.',
    messages: [{ role: 'user', content: transcript }],
  });
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

// Deterministic stand-in for Claude, used by `npm run simulate -- --mock`.
// A caller line containing [[tool_name {"json": "input"}]] makes it call that tool;
// after any tool it speaks the tool result verbatim, so the simulator can check it.
function mockReply(messages: Anthropic.MessageParam[], onText: (delta: string) => void): ReplyStream {
  let aborted = false;
  const last = messages[messages.length - 1];
  const lastText = (typeof last.content === 'string' ? last.content : '').replace(/^\[Call info:[\s\S]*?\]\n/, '');
  const toolResult = Array.isArray(last.content)
    ? (last.content.find((b) => b.type === 'tool_result') as Anthropic.ToolResultBlockParam | undefined)
    : undefined;
  const directive = /\[\[(\w+)\s*(\{[\s\S]*?\})?\]\]/.exec(lastText);
  const wantsPerson = /person|human|someone/i.test(lastText);
  const wantsBye = /bye|that's all|thats all/i.test(lastText);

  const mockToolUse = (name: string, input: unknown) =>
    ({ type: 'tool_use', id: `toolu_mock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, name, input, caller: { type: 'direct' } }) as unknown as Anthropic.ToolUseBlock;

  let text: string;
  let toolUse: Anthropic.ToolUseBlock | null = null;
  if (toolResult) {
    const result = typeof toolResult.content === 'string' ? toolResult.content : JSON.stringify(toolResult.content);
    text = `Tool result: ${result.replace(/\n/g, ' | ')}`;
  } else if (directive) {
    text = 'One sec, let me check. ';
    toolUse = mockToolUse(directive[1], directive[2] ? JSON.parse(directive[2]) : {});
  } else if (wantsPerson) {
    text = 'Sure, let me connect you.';
    toolUse = mockToolUse('transfer_to_human', { reason: 'Caller asked for a person' });
  } else if (wantsBye) {
    text = 'Thanks for calling, have a great day!';
    toolUse = mockToolUse('end_call', {});
  } else {
    text = `Gotcha, you said ${lastText.slice(0, 60)}. How can I help with that?`;
  }

  const done = (async (): Promise<Reply> => {
    for (const word of text.split(/(?<= )/)) {
      await new Promise((r) => setTimeout(r, toolResult ? 2 : 40));
      if (aborted) throw new Error('aborted');
      onText(word);
    }
    const content = [{ type: 'text', text, citations: null } as unknown as Anthropic.TextBlock, ...(toolUse ? [toolUse] : [])];
    return { content, stopReason: toolUse ? 'tool_use' : 'end_turn' };
  })();
  return { done, abort: () => { aborted = true; } };
}
