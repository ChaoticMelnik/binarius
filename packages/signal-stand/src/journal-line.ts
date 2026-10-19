import { SIGNAL_ALGORITHM_VERSIONS, storedSignalJournalEntrySchema } from '@binarius/shared';
import type { StoredSignalJournalEntry } from '@binarius/signal';

export type JournalLine =
  | { kind: 'entry'; entry: StoredSignalJournalEntry }
  | { kind: 'malformed_line' }
  | { kind: 'unsupported_version'; version: string };

// A pino line carries the entry under `signal` (feed.ts logs { signal: entry }); a bare entry is
// accepted too. Anything else is counted, never guessed.
export function parseJournalLine(line: string): JournalLine {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { kind: 'malformed_line' };
  }
  if (value === null || typeof value !== 'object') return { kind: 'malformed_line' };
  const candidate: unknown = 'signal' in value ? value.signal : value;
  const version = (candidate as { version?: unknown } | null)?.version;
  if (
    typeof version === 'string' &&
    !(SIGNAL_ALGORITHM_VERSIONS as readonly string[]).includes(version)
  ) {
    return { kind: 'unsupported_version', version };
  }
  // the shared schema of the entry (#666): the trade log's export carries the same lines
  const parsed = storedSignalJournalEntrySchema.safeParse(candidate);
  return parsed.success ? { kind: 'entry', entry: parsed.data } : { kind: 'malformed_line' };
}
