// ConversationRelay WebSocket messages, per
// https://www.twilio.com/docs/voice/conversationrelay/websocket-messages

export interface SetupMessage {
  type: 'setup';
  sessionId: string;
  accountSid: string;
  callSid: string;
  from: string;
  to: string;
  forwardedFrom?: string;
  callerName?: string;
  direction?: string;
  callStatus?: string;
  customParameters?: Record<string, string>;
}

export interface PromptMessage {
  type: 'prompt';
  voicePrompt: string;
  lang?: string;
  last?: boolean;
}

export interface InterruptMessage {
  type: 'interrupt';
  utteranceUntilInterrupt: string;
  durationUntilInterruptMs: number;
}

export interface DtmfMessage {
  type: 'dtmf';
  digit: string;
}

export interface ErrorMessage {
  type: 'error';
  description: string;
}

export type IncomingMessage =
  | SetupMessage
  | PromptMessage
  | InterruptMessage
  | DtmfMessage
  | ErrorMessage
  | { type: 'info'; name: string; value: unknown };

export type OutgoingMessage =
  | { type: 'text'; token: string; last: boolean; interruptible?: boolean; preemptible?: boolean }
  | { type: 'end'; handoffData?: string };

// Carried in the `end` message's handoffData and read back by /connect-action.
export type Handoff =
  | { action: 'transfer'; reason: string }
  | { action: 'hangup' };
