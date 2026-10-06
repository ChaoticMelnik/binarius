import { describe, expect, it } from 'vitest';
import { telegramHtml } from './telegram-html';
import { parseClosedTrade, parseOpenTrade, type ClosedTrade, type OpenTrade } from './broker';
import type { DecimalString } from './money';
import {
  closedTradeFor,
  composeDurationMs,
  composeServiceEnvValue,
  composeServiceValue,
  openTradeFor,
  telegramTextProblems,
  type TradeTarget,
} from './testing';

const yaml = `services:
  postgres:
    image: postgres:18-alpine
    healthcheck:
      stop_grace_period: 99s
  backend:
    <<: *app
    stop_grace_period: 20s
    environment:
      PORT: "3000"
    labels:
      HOST: backend.example
  trading-worker:
    stop_grace_period: 40s
`;

describe('composeServiceValue', () => {
  it('reads a direct child of the named service only', () => {
    expect(composeServiceValue(yaml, 'backend', 'stop_grace_period')).toBe('20s');
    expect(composeServiceValue(yaml, 'trading-worker', 'stop_grace_period')).toBe('40s');
  });

  it('ignores the same key nested under another key or on a neighbouring service', () => {
    expect(composeServiceValue(yaml, 'postgres', 'stop_grace_period')).toBeUndefined();
    expect(composeServiceValue(yaml, 'bot', 'stop_grace_period')).toBeUndefined();
  });
});

describe('composeServiceEnvValue', () => {
  it("reads a variable of the named service's environment map", () => {
    expect(composeServiceEnvValue(yaml, 'backend', 'PORT')).toBe('"3000"');
  });

  it('ignores the name outside environment, under another service, or absent', () => {
    expect(composeServiceEnvValue(yaml, 'backend', 'HOST')).toBeUndefined();
    expect(composeServiceEnvValue(yaml, 'postgres', 'PORT')).toBeUndefined();
    expect(composeServiceEnvValue(yaml, 'backend', 'MISSING')).toBeUndefined();
  });
});

describe('composeDurationMs', () => {
  it('converts whole seconds and rejects anything else', () => {
    expect(composeDurationMs('40s')).toBe(40_000);
    expect(composeDurationMs('1m')).toBeUndefined();
    expect(composeDurationMs(undefined)).toBeUndefined();
  });
});

describe('telegramTextProblems', () => {
  it('passes a clean text', () => {
    expect(telegramTextProblems(telegramHtml`<b>a</b>\nb`)).toEqual([]);
  });

  it('reports what the validator finds', () => {
    expect(telegramTextProblems(telegramHtml`<p>${'x'}</p>`)).toContain(
      '<p> is not a Telegram tag',
    );
  });

  it('reports a text empty after entities parsing', () => {
    expect(telegramTextProblems(telegramHtml`<b></b>`)).toEqual(['empty after entities parsing']);
  });

  it('reports a text over the limit it is given', () => {
    expect(telegramTextProblems(telegramHtml`${'a'.repeat(5)}`, 4)).toEqual([
      '5 UTF-16 code units after entities parsing, the limit is 4',
    ]);
  });

  it('measures against the message limit by default', () => {
    expect(telegramTextProblems(telegramHtml`${'a'.repeat(4096)}`)).toEqual([]);
    expect(telegramTextProblems(telegramHtml`${'a'.repeat(4097)}`)).toEqual([
      '4097 UTF-16 code units after entities parsing, the limit is 4096',
    ]);
  });

  it('reports a line starting or ending with a space, by its number', () => {
    expect(telegramTextProblems(telegramHtml`a\n b\nc `)).toEqual([
      'line 2 starts or ends with a space',
      'line 3 starts or ends with a space',
    ]);
  });
});

// the builders stand in for the broker's parsed trades, so they must be what the parsers produce
describe('trade builders', () => {
  const wireOf = (trade: OpenTrade | ClosedTrade) => ({
    id: trade.id,
    asset_id: trade.assetId,
    action: trade.action,
    amount: trade.amount,
    payout: trade.payout,
    open_price: trade.openPrice,
    open_timestamp: trade.openTimestamp,
    is_demo: trade.isDemo,
  });
  const target: TradeTarget = {
    mode: 'real',
    assetId: 91,
    action: 'down',
    amount: '2.50' as DecimalString,
  };

  it('builds an open trade the open-trade parser reproduces', () => {
    const open = openTradeFor(target);
    expect(open).toMatchObject({ assetId: 91, action: 'down', amount: '2.50', isDemo: false });
    expect(parseOpenTrade({ ...wireOf(open), potential_profit: open.potentialProfit })).toEqual(
      open,
    );
  });

  it('builds a closed trade at a loss the closed-trade parser reproduces', () => {
    const open = openTradeFor({ ...target, mode: 'demo', action: 'up' });
    const closed = closedTradeFor(open);
    expect(closed).toMatchObject({ id: open.id, profit: '-10.00', isDemo: true });
    expect(closed.closeTimestamp).toBe(open.openTimestamp + 60_000);
    expect(
      parseClosedTrade({
        ...wireOf(closed),
        close_price: closed.closePrice,
        close_timestamp: closed.closeTimestamp,
        profit: closed.profit,
      }),
    ).toEqual(closed);
  });
});
