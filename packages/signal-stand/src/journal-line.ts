import {
  SIGNAL_ALGORITHM_VERSIONS,
  signalDecisionSchema,
  signalDecisionV1Schema,
  signalIntervalSchema,
  signalParamsSchema,
  signalParamsV1Schema,
} from '@binarius/shared';
import type { StoredSignalJournalEntry } from '@binarius/signal';
import { z } from 'zod';

const fetchSchema = z.object({
  startTime: z.number(),
  limit: z.int(),
  rows: z.int(),
  durationMs: z.number(),
});

// the fields of SignalJournalEntry / SignalJournalEntryV2Fetch / SignalJournalEntryV1
// (packages/signal/src/journal.ts)
const base = {
  assetId: z.int(),
  interval: signalIntervalSchema,
  intervalMs: z.int().positive(),
  nowMs: z.number(),
  series: z.array(z.tuple([z.number(), z.number(), z.number(), z.number(), z.number()])),
};
const v2 = {
  ...base,
  version: z.literal('v2'),
  digits: z.int().nonnegative(),
  params: signalParamsSchema,
  decision: signalDecisionSchema,
};
// #405: where the series came from; a v2 line written before it carries fetch instead
const entryV2Schema = z.object({
  ...v2,
  source: z.discriminatedUnion('kind', [
    fetchSchema.extend({ kind: z.literal('rest') }),
    z.object({
      kind: z.literal('socket'),
      startTime: z.number(),
      closedUntil: z.number(),
      gaps: z.int().nonnegative(),
    }),
  ]),
});
const entryV2FetchSchema = z.object({ ...v2, fetch: fetchSchema });
const entryV1Schema = z.object({
  ...base,
  fetch: fetchSchema,
  version: z.literal('v1'),
  params: signalParamsV1Schema,
  decision: signalDecisionV1Schema,
});
const entrySchema = z.union([entryV2Schema, entryV2FetchSchema, entryV1Schema]);

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
  const parsed = entrySchema.safeParse(candidate);
  return parsed.success
    ? { kind: 'entry', entry: parsed.data as StoredSignalJournalEntry }
    : { kind: 'malformed_line' };
}
