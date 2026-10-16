import type {
  CandleComparison,
  DecisionComparison,
  MacdCounts,
  SideCounts,
} from './candle-spike-compare';
import {
  SPIKE_INTERVALS,
  type IntervalResult,
  type SeriesStatus,
  type SpikeReportInput,
} from './candle-spike-run';

// The candle spike's report (#392, docs/broker-socket.md -> The candle spike): markdown on stdout,
// pasted by the owner as a comment on #392. Shares print with their counts; nothing compared
// prints `0 of 0`, a display indicator never compared on both sides prints «не измерено».

const NOT_MEASURED = 'не измерено';

export function share(part: number, whole: number): string {
  if (whole === 0) return '0 of 0';
  return `${((part / whole) * 100).toFixed(1)} % (${part} of ${whole})`;
}

const fixed = (value: number | undefined, digits = 1) =>
  value === undefined ? '-' : value.toFixed(digits);

const status = (rest: SeriesStatus) => (rest.ok ? 'ok' : rest.code);

const sideCell = (counts: SideCounts) =>
  counts.compared === 0 ? NOT_MEASURED : share(counts.sideDiffer, counts.compared);

const macdCell = (counts: MacdCounts, field: 'crossDiffer' | 'signDiffer') =>
  counts.compared === 0 ? NOT_MEASURED : share(counts[field], counts.compared);

interface Totals {
  candles: CandleComparison[];
  decisions: DecisionComparison[];
  aggregation: CandleComparison[];
}

const sum = <T>(items: readonly T[], pick: (item: T) => number) =>
  items.reduce((total, item) => total + pick(item), 0);

function candleTable(rows: { id: number; result: IntervalResult }[]): string[] {
  const lines = [
    '| pair | compared | open = | close = | high Δ 0/1/2/≥3 | low Δ 0/1/2/≥3 | REST only | ticks only | in hole | ATR mean / max % |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const { id, result } of rows) {
    const c = result.candles;
    if (c === undefined) {
      lines.push(`| ${id} | REST ${status(result.rest)} | | | | | | | | |`);
      continue;
    }
    lines.push(
      `| ${id} | ${c.compared} | ${share(c.openEq, c.compared)} | ${share(c.closeEq, c.compared)} | ${c.high.join('/')} | ${c.low.join('/')} | ${c.restOnly} | ${c.ticksOnly} | ${c.inHole} | ${fixed(c.atr?.meanPct, 2)} / ${fixed(c.atr?.maxPct, 2)} |`,
    );
  }
  return lines;
}

function decisionTable(rows: { id: number; result: IntervalResult }[]): string[] {
  const lines = [
    '| pair | moments | differ | signal→no_signal | no_signal→signal | up↔down | reason changed | tick floor ≠ | in-hole moments (differ) |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const { id, result } of rows) {
    const d = result.decisions;
    if (d === undefined) continue;
    const c = d.categories;
    lines.push(
      `| ${id} | ${d.compared} | ${share(d.differ, d.compared)} | ${c.signal_to_no_signal} | ${c.no_signal_to_signal} | ${c.up_down} | ${c.reason_changed} | ${share(d.tickFloorDiffer, d.tickFloorCompared)} | ${d.inHole.compared} (${d.inHole.differ}) |`,
    );
  }
  return lines;
}

function displayTable(rows: { id: number; result: IntervalResult }[]): string[] {
  const lines = [
    '| pair | MACD cross ≠ | MACD sign ≠ | MA50 side ≠ | MA200 side ≠ | ok ≠ (MACD/MA50/MA200) |',
    '|---|---|---|---|---|---|',
  ];
  for (const { id, result } of rows) {
    const d = result.decisions?.display;
    if (d === undefined) continue;
    lines.push(
      `| ${id} | ${macdCell(d.macd, 'crossDiffer')} | ${macdCell(d.macd, 'signDiffer')} | ${sideCell(d.ma50)} | ${sideCell(d.ma200)} | ${d.macd.okDiffer}/${d.ma50.okDiffer}/${d.ma200.okDiffer} |`,
    );
  }
  return lines;
}

function aggregationTable(rows: { id: number; result: IntervalResult }[]): string[] {
  const lines = ['| pair | REST 1s | compared | exact |', '|---|---|---|---|'];
  for (const { id, result } of rows) {
    const a = result.aggregation;
    lines.push(
      `| ${id} | ${status(result.aggregationRest)} | ${a?.compared ?? '-'} | ${a === undefined ? '-' : share(a.allEq, a.compared)} |`,
    );
  }
  return lines;
}

function summary(input: SpikeReportInput, totals: Totals): string[] {
  const compared = sum(totals.candles, (c) => c.compared);
  const withinOne = sum(totals.candles, (c) => c.high[0] + c.high[1] + c.low[0] + c.low[1]);
  const moments = sum(totals.decisions, (d) => d.compared);
  const differ = sum(totals.decisions, (d) => d.differ);
  const display = totals.decisions.map((d) => d.display);
  const macdCompared = sum(display, (d) => d.macd.compared);
  const average = (pick: (d: DecisionComparison['display']) => SideCounts) => {
    const counts = display.map(pick);
    return sideCell({
      compared: sum(counts, (c) => c.compared),
      sideDiffer: sum(counts, (c) => c.sideDiffer),
      okDiffer: 0,
    });
  };
  const macd = (field: 'crossDiffer' | 'signDiffer') =>
    macdCell(
      {
        compared: macdCompared,
        crossDiffer: 0,
        signDiffer: 0,
        okDiffer: 0,
        [field]: sum(display, (d) => d.macd[field]),
      },
      field,
    );
  const longest = Math.max(0, ...input.holes.map((hole) => hole.span.toMs - hole.span.fromMs));
  return [
    '## Summary (for #404)',
    '',
    '- subscription cap: not measured here (#555)',
    `- open / close exact: ${share(
      sum(totals.candles, (c) => c.openEq),
      compared,
    )} / ${share(
      sum(totals.candles, (c) => c.closeEq),
      compared,
    )}`,
    `- high / low within 1 step: ${share(withinOne, compared * 2)}`,
    `- decisions differ: ${share(differ, moments)}`,
    `- tick floor differs: ${share(
      sum(totals.decisions, (d) => d.tickFloorDiffer),
      sum(totals.decisions, (d) => d.tickFloorCompared),
    )}`,
    `- display differs: cross ${macd('crossDiffer')} / sign ${macd('signDiffer')} / MA50 ${average((d) => d.ma50)} / MA200 ${average((d) => d.ma200)}`,
    `- 1s aggregation exact: ${share(
      sum(totals.aggregation, (a) => a.allEq),
      sum(totals.aggregation, (a) => a.compared),
    )}`,
    `- holes: ${input.holes.length} (longest ${longest} ms)`,
    `- receipt delay p95: ${input.delay === undefined ? '-' : `${input.delay.p95} ms`}`,
    `- cpu: ${fixed(input.process.cpuPct)} %, max RSS ${fixed(input.process.maxRssMb)} MB`,
  ];
}

export function renderReport(input: SpikeReportInput): string {
  const end = input.interrupted
    ? 'interrupted'
    : input.endedBy !== undefined
      ? `ended by ${input.endedBy}`
      : 'complete';
  const { choice, catalog } = input;
  const seconds = input.phaseBMs / 1000;
  const lines = [
    '# Candle spike (#392)',
    '',
    `- started ${new Date(input.startedAt).toISOString()}; phase B ${fixed(seconds / 60)} of ${input.minutes} min, ${end}`,
    `- pairs: ${input.operatorChoice ? 'SPIKE_ASSET_IDS' : 'by type group, payout first'}; skipped: digits out of range ${choice.skippedDigits}; groups without a candidate: ${choice.emptyGroups.length === 0 ? 'none' : choice.emptyGroups.join(', ')}`,
    `- catalogs: REST ${catalog.rest}, socket ${catalog.socket}; socket only ${catalog.socketOnly}, REST only ${catalog.restOnly}`,
    '- one sample of market conditions: another run may differ',
    '',
    '| id | symbol | group | digits | payout | ticks | ticks/s |',
    '|---|---|---|---|---|---|---|',
    ...input.pairs.map(
      ({ pair, ticks }) =>
        `| ${pair.id} | ${pair.symbol} | ${pair.group} | ${pair.digits} | ${pair.payout} | ${ticks} | ${seconds > 0 ? fixed(ticks / seconds, 2) : '-'} |`,
    ),
  ];

  const totals: Totals = { candles: [], decisions: [], aggregation: [] };
  for (const { name } of SPIKE_INTERVALS) {
    const rows = input.pairs.flatMap(({ pair, intervals }) =>
      intervals
        .filter((result) => result.interval === name)
        .map((result) => ({ id: pair.id, result })),
    );
    for (const { result } of rows) {
      if (result.candles !== undefined) totals.candles.push(result.candles);
      if (result.decisions !== undefined) totals.decisions.push(result.decisions);
      if (result.aggregation !== undefined) totals.aggregation.push(result.aggregation);
    }
    lines.push(
      '',
      `## Phase B: ${name}`,
      '',
      ...candleTable(rows),
      '',
      'Signal decisions (REST → ticks):',
      '',
      ...decisionTable(rows),
      '',
      'Display indicators:',
      '',
      ...displayTable(rows),
      '',
      `1s rows aggregated to ${name} against the native ${name}:`,
      '',
      ...aggregationTable(rows),
    );
  }

  const delay = input.delay;
  lines.push(
    '',
    '## Phase B: load',
    '',
    `- receipt delay (now − tick time): ${delay === undefined ? '-' : `median ${delay.median} ms, p95 ${delay.p95} ms, min ${delay.min} ms (${delay.count} ticks)`}`,
    `- ticks: ${input.ticks.total} (${seconds > 0 ? fixed(input.ticks.total / seconds, 1) : '-'}/s); late ${input.ticks.late} (per builder), invalid ${input.ticks.invalid}, skewed ${input.ticks.skewed}`,
    `- cpu ${fixed(input.process.cpuPct)} % of wall time, max RSS ${fixed(input.process.maxRssMb)} MB`,
    '',
    '## Phase C: drops',
    '',
  );
  if (input.stateChanges.length === 0) lines.push('- no state change');
  for (const change of input.stateChanges) {
    lines.push(
      `- +${fixed((change.at - input.startedAt) / 1000)} s: ${change.from} → ${change.to}${change.reason === undefined ? '' : ` (${change.reason})`}`,
    );
  }
  for (const hole of input.holes) {
    const affected = SPIKE_INTERVALS.map(({ name, ms }) => {
      const first = Math.floor(hole.span.fromMs / ms);
      const last = Math.floor(hole.span.toMs / ms);
      return `${name} ${Math.max(0, last - first + 1)}`;
    }).join(', ');
    lines.push(
      `- hole: ${hole.backAt === undefined ? 'not back to ready' : `${hole.backAt - hole.leftAt} ms to ready`}, ${hole.span.toMs - hole.span.fromMs} ms between ticks; candles overlapping it: ${affected}`,
    );
  }
  lines.push('', ...summary(input, totals));
  return lines.join('\n');
}
