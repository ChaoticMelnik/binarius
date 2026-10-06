// Test-only helpers shared by the apps' suites (subpath `@binarius/shared/testing`).

import { expect } from 'vitest';
import type { ClosedTrade, OpenTrade } from './broker';
import type { DecimalString } from './money';
import { TradeMode, type TradeAction } from './trading';
import {
  plainTextOf,
  TELEGRAM_MESSAGE_LIMIT,
  telegramHtmlProblems,
  type TelegramHtml,
} from './telegram-html';

// --- Waiting in tests (#205) ------------------------------------------------------------------
// One ceiling per vitest project, each below that project's test budget so a wait that never ends
// fails with its own message instead of the runner's timeout. The chain is asserted by
// tooling/vitest-projects.test.ts.
// Unit: vitest's default testTimeout (5 s); the unit project leaves it unset.
export const UNIT_WAIT_CEILING_MS = 4_000;
// Integration: the integration project's testTimeout (20 s, vitest.config.ts).
export const INTEGRATION_WAIT_CEILING_MS = 15_000;

// The suffix half of INTEGRATION_TEST_GLOB; tooling/vitest-projects.test.ts checks the two agree
// file by file.
export function isIntegrationTestPath(file: string): boolean {
  return /\.(db|redis)\.test\.ts$/.test(file);
}

function waitCeilingMs(): number {
  const file = expect.getState().testPath;
  return file !== undefined && isIntegrationTestPath(file)
    ? INTEGRATION_WAIT_CEILING_MS
    : UNIT_WAIT_CEILING_MS;
}

// Polls until the condition holds. The ceiling comes from the calling file's project, never from
// the call site; a condition that throws or rejects ends the wait with that error.
export async function until(
  what: string,
  condition: () => boolean | Promise<boolean>,
  options: { intervalMs?: number } = {},
): Promise<void> {
  const ceilingMs = waitCeilingMs();
  const intervalMs = options.intervalMs ?? 10;
  const deadline = Date.now() + ceilingMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${ceilingMs} ms waiting for ${what}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
}

// Reads one direct key of a compose service out of compose.yaml text, so a test can hold a
// TypeScript timing constant and the container's stop_grace_period together. A service block
// starts at its two-space-indented `<name>:` line and ends at the next line indented the same
// way; only the block's direct (four-space) children count, so a nested `stop_grace_period`
// under some other key, or the same key on a neighbouring service, never matches.
export function composeServiceValue(
  yaml: string,
  service: string,
  key: string,
): string | undefined {
  const lines = yaml.split('\n');
  const start = lines.findIndex((line) => line === `  ${service}:`);
  if (start === -1) return undefined;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (/^ {2}\S/.test(line)) break;
    const match = /^ {4}([\w-]+):\s*(.*?)\s*$/.exec(line);
    if (match !== null && match[1] === key) return match[2];
  }
  return undefined;
}

// Reads one variable of a compose service's `environment:` map — the block's direct four-space
// `environment:` child, then its six-space `NAME: value` lines — so a test can pin a default the
// file interpolates. The same name under another service, outside `environment:`, or nested
// deeper never matches.
export function composeServiceEnvValue(
  yaml: string,
  service: string,
  name: string,
): string | undefined {
  const lines = yaml.split('\n');
  const start = lines.findIndex((line) => line === `  ${service}:`);
  if (start === -1) return undefined;
  let inEnvironment = false;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (/^ {2}\S/.test(line)) break;
    if (/^ {4}[^\s#]/.test(line)) {
      inEnvironment = line.trimEnd() === '    environment:';
      continue;
    }
    if (!inEnvironment) continue;
    const match = /^ {6}([A-Z_]+):\s*(.*?)\s*$/.exec(line);
    if (match !== null && match[1] === name) return match[2];
  }
  return undefined;
}

// The start-payload corpus, run twice: against startPayloadSchema (packages/shared) and against
// the live users_acquisition_source_check (packages/db). One list, so the two verdicts are
// compared row by row instead of two lists drifting apart.
export const START_PAYLOAD_CORPUS: readonly { label: string; value: string; valid: boolean }[] = [
  { label: '1 char', value: 'a', valid: true },
  { label: '64 chars', value: 'a'.repeat(64), valid: true },
  { label: 'dash underscore', value: 'src_ab-CD9', valid: true },
  { label: '65 chars', value: 'a'.repeat(65), valid: false },
  { label: 'empty', value: '', valid: false },
  { label: 'plus sign', value: 'a+b', valid: false },
  { label: 'space', value: 'a b', valid: false },
  { label: 'newline', value: 'a\nb', valid: false },
  { label: 'cyrillic', value: 'исток', valid: false },
];

// The staff-login corpus, run twice: against staffLoginSchema (packages/shared) and against
// the live staff_login_check (packages/db). One list, for the same reason as the one above.
export const STAFF_LOGIN_CORPUS: readonly { label: string; value: string; valid: boolean }[] = [
  { label: '3 chars', value: 'ada', valid: true },
  { label: '64 chars', value: 'a'.repeat(64), valid: true },
  { label: 'dot underscore dash', value: 'ada.lovelace_1-A', valid: true },
  { label: 'digits only', value: '007', valid: true },
  { label: '2 chars', value: 'ab', valid: false },
  { label: '65 chars', value: 'a'.repeat(65), valid: false },
  { label: 'empty', value: '', valid: false },
  { label: 'space', value: 'ada l', valid: false },
  { label: 'at sign', value: 'ada@host', valid: false },
  { label: 'newline', value: 'ada\nb', valid: false },
  // JavaScript's `$` without `m` and PostgreSQL's `~` both anchor at the very end, so this row
  // is the one that would show them disagreeing if either ever stopped doing so
  { label: 'trailing newline', value: 'ada\n', valid: false },
  { label: 'cyrillic', value: 'ада', valid: false },
];

// `40s` → 40000; compose accepts h/m/s/ms suffixes, this project only writes seconds
export function composeDurationMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d+)s$/.exec(value);
  return match === null ? undefined : Number(match[1]) * 1000;
}

// Everything the texts' tests check about one message: valid Telegram HTML, non-empty after
// entities parsing, inside the limit (UTF-16 code units of the parsed text, as the Bot API
// counts), no line starting or ending with a space. Empty when the text is fine.
export function telegramTextProblems(text: TelegramHtml, limit = TELEGRAM_MESSAGE_LIMIT): string[] {
  const problems = telegramHtmlProblems(text.value);
  const plain = plainTextOf(text);
  if (plain.trim() === '') problems.push('empty after entities parsing');
  if (plain.length > limit) {
    problems.push(
      `${plain.length} UTF-16 code units after entities parsing, the limit is ${limit}`,
    );
  }
  plain.split('\n').forEach((line, index) => {
    if (line !== line.trim()) problems.push(`line ${index + 1} starts or ends with a space`);
  });
  return problems;
}

// --- Broker trade builders (#17) ---------------------------------------------------------------
// The broker's open trade for an intent, as the executor would hand it over. A TradeIntentRow
// satisfies the first parameter as is, so the integration suites pass the row; a patch makes the
// mismatch cases (another asset, mode, amount) one line each.

let tradeSeq = 0;

export interface TradeTarget {
  mode: TradeMode;
  assetId: number;
  action: TradeAction;
  amount: DecimalString;
}

export function openTradeFor(
  { mode, assetId, action, amount }: TradeTarget,
  patch: Partial<OpenTrade> = {},
): OpenTrade {
  return {
    id: `bt-${++tradeSeq}`,
    assetId,
    action,
    amount,
    payout: 85,
    openPrice: 1.08765,
    openTimestamp: Date.now(),
    isDemo: mode === TradeMode.Demo,
    potentialProfit: amount,
    ...patch,
  };
}

// a loss by default, so the signed profit column is exercised
export function closedTradeFor(open: OpenTrade, patch: Partial<ClosedTrade> = {}): ClosedTrade {
  return {
    id: open.id,
    assetId: open.assetId,
    action: open.action,
    amount: open.amount,
    payout: open.payout,
    openPrice: open.openPrice,
    openTimestamp: open.openTimestamp,
    isDemo: open.isDemo,
    closePrice: 1.08712,
    closeTimestamp: open.openTimestamp + 60_000,
    profit: '-10.00' as DecimalString,
    ...patch,
  };
}
