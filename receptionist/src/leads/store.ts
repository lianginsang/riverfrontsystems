import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

export interface Lead {
  callSid: string;
  callerId: string;
  name: string;
  phone: string;
  reason: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export type LeadInput = Pick<Lead, 'name' | 'phone' | 'reason' | 'notes'>;

// Swap this out for a real database or CRM by implementing the same interface.
export interface LeadStore {
  // One lead per call: saving again on the same call updates it.
  upsert(callSid: string, callerId: string, input: LeadInput): Promise<Lead>;
  getByCall(callSid: string): Promise<Lead | undefined>;
}

export class JsonFileLeadStore implements LeadStore {
  // Serializes writes so concurrent calls can't clobber the file.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  private async readAll(): Promise<Lead[]> {
    try {
      return JSON.parse(await fs.readFile(this.filePath, 'utf8')) as Lead[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  upsert(callSid: string, callerId: string, input: LeadInput): Promise<Lead> {
    const run = async () => {
      const leads = await this.readAll();
      const now = new Date().toISOString();
      const existing = leads.find((l) => l.callSid === callSid);
      const lead: Lead = existing
        ? { ...existing, ...input, updatedAt: now }
        : { callSid, callerId, ...input, createdAt: now, updatedAt: now };
      const next = existing ? leads.map((l) => (l.callSid === callSid ? lead : l)) : [...leads, lead];
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(next, null, 2));
      await fs.rename(tmp, this.filePath);
      return lead;
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  async getByCall(callSid: string): Promise<Lead | undefined> {
    await this.queue;
    return (await this.readAll()).find((l) => l.callSid === callSid);
  }
}

export const leadStore: LeadStore = new JsonFileLeadStore(path.join(config.rootDir, 'data', 'leads.json'));
