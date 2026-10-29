import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface JournalEntry {
  ts: string;
  step: string;
  mode: 'dry-run' | 'execute';
  request: { method: string; summary: string };
  responseIds?: Record<string, string>;
  responseSummary?: string;
  error?: {
    message: string;
    code?: number;
    error_subcode?: number;
    error_user_msg?: string;
    fbtrace_id?: string;
    httpStatus?: number;
  };
  note?: string;
}

export async function appendJournal(journalPath: string, entry: JournalEntry): Promise<void> {
  await mkdir(dirname(journalPath), { recursive: true });
  await appendFile(journalPath, `${JSON.stringify(entry)}\n`, 'utf8');
}

export async function readJournal(journalPath: string): Promise<JournalEntry[]> {
  const raw = await readFile(journalPath, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JournalEntry);
}

export function nowIso(): string {
  return new Date().toISOString();
}
