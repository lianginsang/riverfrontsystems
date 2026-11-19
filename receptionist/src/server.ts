import http from 'node:http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { CallSession, sessions } from './relay/session.js';
import type { IncomingMessage } from './relay/types.js';
import { transcriptsRouter } from './http/transcripts.js';
import { isValidWebSocketUpgrade } from './twilio/signature.js';
import { voiceRouter } from './twilio/voice.js';

const app = express();
app.use(express.urlencoded({ extended: false }));
app.get('/', (_req, res) => {
  res.send('ok');
});
app.use(voiceRouter);
app.use(transcriptsRouter);

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/ws' || !isValidWebSocketUpgrade(req)) {
    console.warn(`Rejected WebSocket upgrade to ${req.url}: wrong path or invalid Twilio signature (signed URL should be ${config.wsUrl})`);
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  let session: CallSession | undefined;

  ws.on('message', (data) => {
    let msg: IncomingMessage;
    try {
      msg = JSON.parse(data.toString()) as IncomingMessage;
    } catch {
      console.warn('Ignoring non-JSON WebSocket message');
      return;
    }
    if (msg.type === 'setup') {
      session = new CallSession(ws, msg);
      sessions.set(msg.callSid, session);
      console.log(`[${msg.callSid}] call started from ${msg.from}`);
      return;
    }
    session?.handle(msg);
  });

  ws.on('close', () => {
    void session?.finish();
  });
  ws.on('error', (err) => console.error('WebSocket error:', err));
});

export function start(port = config.port): Promise<http.Server> {
  return new Promise((resolve) => {
    server.listen(port, () => {
      console.log(`Receptionist listening on :${port}. Twilio webhook: ${config.publicBaseUrl}/voice`);
      resolve(server);
    });
  });
}
