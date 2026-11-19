import fs from 'node:fs/promises';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import { supabaseAdmin } from '../bookings/repo.js';
import { config } from '../config.js';
import { logsDir } from '../logging/transcript.js';

// GET /api/transcripts/:callSid for the staff calendar's "View call transcript".
// The browser sends the staff member's Supabase access token; this checks it's a
// real sign-in that's listed in `staff` before reading anything off disk.
export const transcriptsRouter = Router();

const CALL_SID = /^CA[A-Za-z0-9]{10,40}$/;
const SHOWN = new Set(['call_start', 'caller', 'assistant', 'interrupted', 'tool', 'call_end']);

function cors(req: Request, res: Response): void {
  const origin = req.header('origin');
  if (origin && config.calendarOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  }
}

transcriptsRouter.options('/api/transcripts/:callSid', (req, res) => {
  cors(req, res);
  res.sendStatus(204);
});

transcriptsRouter.get('/api/transcripts/:callSid', async (req, res) => {
  cors(req, res);
  const { callSid } = req.params;
  if (!CALL_SID.test(callSid)) {
    res.status(400).json({ error: 'Invalid call SID' });
    return;
  }
  if (!supabaseAdmin) {
    res.status(503).json({ error: 'Bookings are not configured on the receptionist server' });
    return;
  }

  const token = req.header('authorization')?.replace(/^Bearer\s+/i, '');
  const { data: auth, error: authError } = token ? await supabaseAdmin.auth.getUser(token) : { data: null, error: true };
  if (authError || !auth?.user) {
    res.status(401).json({ error: 'Sign in again' });
    return;
  }
  const { data: staff, error: staffError } = await supabaseAdmin.from('staff').select('user_id').eq('user_id', auth.user.id).limit(1);
  if (staffError || !staff?.length) {
    res.status(403).json({ error: 'Not a staff account' });
    return;
  }

  try {
    const file = (await fs.readdir(logsDir).catch(() => [] as string[])).find((f) => f.endsWith(`_${callSid}.jsonl`));
    if (!file) {
      res.status(404).json({ error: 'Transcript not found. Transcripts are cleared when the receptionist redeploys.' });
      return;
    }
    const lines = (await fs.readFile(path.join(logsDir, file), 'utf8')).split('\n').filter(Boolean);
    const entries = lines
      .map((line) => {
        try {
          return JSON.parse(line) as { kind: string };
        } catch {
          return undefined;
        }
      })
      .filter((e) => e && SHOWN.has(e.kind));
    res.json({ callSid, entries });
  } catch (err) {
    console.error(`Transcript read failed for ${callSid}:`, err);
    res.status(500).json({ error: 'Could not read the transcript' });
  }
});
