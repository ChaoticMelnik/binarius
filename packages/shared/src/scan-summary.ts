import type { BotLanguage } from './bot-language';
import type { BotHtmlTexts, BotPlainTexts } from './bot-texts';
import { pluralWordOf } from './session-texts';
import type { ScanSummary } from './signal';
import type { TelegramHtml } from './telegram-html';

// The scanner's lines of the wait for a signal (#859, Rule 58, docs/bot-demo.md → The wait for a
// signal): every figure is a field of GET /trading/signals' list or that field times 60, nothing
// made up. One source for the bot's wait and the backend's session wait (#860); every builder
// takes the catalog it prints with, so each side's overrides apply (Rule 30), as session-texts.ts.

// the pairs «Ближе всего к сигналу» names, of the summary's closeness
export const SCAN_CLOSEST_SHOWN = 3;
// the scanner decides every pair once a closed second
const CHECKS_PER_MINUTE = 60;

// what the wait holds of the signals list: its count and its summary
export interface ScanList {
  scanned: number;
  summary: ScanSummary;
}

// the symbol of a pair by its id in the catalog the caller read, undefined when it is not there
export type ScanSymbolOf = (assetId: number) => string | undefined;

export function createScanTexts({
  html,
  plain,
  language,
}: {
  html: BotHtmlTexts;
  plain: BotPlainTexts;
  language: BotLanguage;
}) {
  const stage = (done: boolean): string => (done ? plain.scanStageDone : plain.scanStagePending);
  const stages = ({ scanned, summary }: ScanList): TelegramHtml =>
    html.scanStages({ quotes: stage(summary.streaming), moves: stage(scanned > 0) });

  // The list's wait: the scanned pairs and checks, the pair the scanner is on, the stages, the
  // closest pairs; a line whose pair is not in the catalog is left out.
  const scanSummaryLines = (list: ScanList, symbolOf: ScanSymbolOf): TelegramHtml[] => {
    const { scanned, summary } = list;
    const word = pluralWordOf(language, scanned, [
      plain.scanPairOne,
      plain.scanPairFew,
      plain.scanPairMany,
    ]);
    const lines = [
      html.signalsScanning({
        pairs: `${String(scanned)} ${word}`,
        checks: String(scanned * CHECKS_PER_MINUTE),
      }),
    ];
    const now = summary.scanning === null ? undefined : symbolOf(summary.scanning);
    if (now !== undefined) lines.push(html.signalsScanningPair({ symbol: now }));
    lines.push(stages(list));
    const closest = summary.closeness
      .flatMap(({ assetId, pct }) => {
        const symbol = symbolOf(assetId);
        return symbol === undefined ? [] : [`${symbol} ${String(pct)} %`];
      })
      .slice(0, SCAN_CLOSEST_SHOWN);
    return closest.length === 0
      ? lines
      : [...lines, html.signalsScanningClosest({ closest: closest.join(' · ') })];
  };

  // The wait for one pair: its own closeness, or that it waits for a move, and the stages; no
  // lines without a list.
  const pairScanLines = (
    list: ScanList | undefined,
    pair: { assetId: number; symbol: string },
  ): TelegramHtml[] => {
    if (list === undefined) return [];
    const own = list.summary.closeness.find(({ assetId }) => assetId === pair.assetId);
    return [
      own === undefined
        ? html.pairScanningNoMove({ symbol: pair.symbol })
        : html.pairScanning({ symbol: pair.symbol, pct: String(own.pct) }),
      stages(list),
    ];
  };

  return { scanSummaryLines, pairScanLines };
}

export type ScanTexts = ReturnType<typeof createScanTexts>;
