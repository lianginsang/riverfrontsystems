import type { IncomingMessage } from 'node:http';
import type { NextFunction, Request, Response } from 'express';
import twilio from 'twilio';
import { config } from '../config.js';

// URLs are rebuilt from PUBLIC_BASE_URL rather than the request's Host header, since
// ngrok and Render sit behind proxies that change the host and protocol Twilio signed.

export function requireTwilioSignature(req: Request, res: Response, next: NextFunction): void {
  const signature = req.header('x-twilio-signature') ?? '';
  const url = config.publicBaseUrl + req.originalUrl;
  if (twilio.validateRequest(config.twilioAuthToken, signature, url, req.body ?? {})) {
    next();
    return;
  }
  console.warn(`Rejected ${req.method} ${req.originalUrl}: invalid Twilio signature (signed URL should be ${url})`);
  res.status(403).send('Invalid Twilio signature');
}

export function isValidWebSocketUpgrade(req: IncomingMessage): boolean {
  const signature = req.headers['x-twilio-signature'];
  if (typeof signature !== 'string') return false;
  return twilio.validateRequest(config.twilioAuthToken, signature, config.wsUrl, {});
}
