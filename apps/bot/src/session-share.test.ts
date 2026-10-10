import type { ApiError } from 'grammy/types';
import { describe, expect, it, vi } from 'vitest';
import {
  TradeIntentStatus,
  TradingSessionStatus,
  TradingSessionStopReason,
  decimalStringSchema,
} from '@binarius/shared';
import { BackendError, BackendErrorCode, type BackendClient } from './backend-client';
import { createBot } from './bot';
import { INLINE_QUERY_LIMIT, SHARE_PATTERN, shareQuery } from './session-share';
import {
  BOT_INFO,
  PAIR_EURUSD,
  PAIRS_RESPONSE,
  SESSION_ID,
  USER,
  captureApi,
  chosenInlineResultUpdate,
  fakeBackend,
  fakeLogger,
  inlineQueryUpdate,
  intentView,
  sessionView,
  stubSessionTracker,
  stubTracker,
  type ApiCall,
} from './testing';
import { sessionShareCaption } from './texts';

const FILE_ID = 'AgACAgIAAxkBAAIBY2b4c2FyZF9maWxlX2lkX2Zvcl90ZXN0cw';
const QUERY = shareQuery(SESSION_ID, FILE_ID);
const d = (value: string) => decimalStringSchema.parse(value);

const DONE = sessionView({
  status: TradingSessionStatus.Stopped,
  stopReason: TradingSessionStopReason.Completed,
  endedAt: '2026-10-07T10:05:00.000Z',
  trades: {
    planned: 5,
    settled: 5,
    rejected: 0,
    won: 3,
    lost: 2,
    tied: 0,
    profit: d('0.55000000'),
  },
  lastIntent: intentView({ status: TradeIntentStatus.Settled }),
});

function setup(
  options: {
    readSession?: BackendClient['readSession'];
    readPairs?: BackendClient['readPairs'];
  } = {},
) {
  const readSession = vi.fn<BackendClient['readSession']>(
    options.readSession ?? (() => Promise.resolve(DONE)),
  );
  const readPairs = vi.fn<BackendClient['readPairs']>(
    options.readPairs ?? (() => Promise.resolve(PAIRS_RESPONSE)),
  );
  const logger = fakeLogger();
  const bot = createBot({
    token: '123456:AA-bot-token',
    backend: fakeBackend({ readSession, readPairs }),
    logger,
    botInfo: BOT_INFO,
    intentTracker: stubTracker(),
    sessionTracker: stubSessionTracker(),
  });
  const api = captureApi(bot);
  const ask = (query: string, chatType?: string) =>
    bot.handleUpdate(inlineQueryUpdate(query, chatType === undefined ? {} : { chatType }));
  return { bot, ask, logger, readSession, readPairs, ...api };
}

// the answers without their inline_query_id, which only echoes the update's
const answersOf = (calls: readonly ApiCall[]) =>
  calls
    .filter((call) => call.method === 'answerInlineQuery')
    .map(({ payload }) => {
      const answer = { ...payload };
      delete answer.inline_query_id;
      return answer;
    });
const warnings = (logger: ReturnType<typeof fakeLogger>) =>
  logger.warn.mock.calls.map((call) => call[1] as string);
const notFound = () =>
  Promise.reject(
    new BackendError(BackendErrorCode.HttpStatus, { status: 404, reason: 'not_found' }),
  );
const EMPTY = { results: [], cache_time: 0, is_personal: true };

describe('the share query (#321)', () => {
  it('fits a file id up to the inline query limit, and no longer', () => {
    const longest = 'x'.repeat(INLINE_QUERY_LIMIT - shareQuery(SESSION_ID, '').length);
    expect(shareQuery(SESSION_ID, longest)).toHaveLength(INLINE_QUERY_LIMIT);
    expect(SHARE_PATTERN.exec(shareQuery(SESSION_ID, longest))?.slice(1)).toEqual([
      SESSION_ID,
      longest,
    ]);
    expect(SHARE_PATTERN.test(shareQuery(SESSION_ID, `${longest}x`))).toBe(false);
  });
});

describe('the inline share answer (#321)', () => {
  it('S1 answers the owner of a finished session with the cached card and its caption', async () => {
    const scene = setup();
    await scene.ask(QUERY);
    expect(scene.readSession.mock.calls).toEqual([[SESSION_ID, String(USER.id)]]);
    const answers = answersOf(scene.calls);
    expect(answers).toHaveLength(1);
    const caption = sessionShareCaption(
      PAIR_EURUSD.symbol,
      PAIR_EURUSD.id,
      DONE.trades,
      BOT_INFO.username,
    ).value;
    expect(answers[0]).toMatchObject({
      results: [
        {
          type: 'photo',
          id: SESSION_ID,
          photo_file_id: FILE_ID,
          caption,
          parse_mode: 'HTML',
        },
      ],
      is_personal: true,
    });
    expect(answers[0]?.cache_time).toBeUndefined();
    expect(caption).toContain(PAIR_EURUSD.symbol);
    expect(caption).toContain('5 сделок — 3 в плюс, 2 в минус');
    expect(caption).toContain(`https://t.me/${BOT_INFO.username}?start=share`);
    expect(caption).not.toContain('$');
    // the shared message carries no keyboard
    expect(JSON.stringify(answers[0])).not.toContain('reply_markup');
    expect(scene.logger.warn).not.toHaveBeenCalled();
  });

  it('S2 answers another user, or a session that does not exist, empty and says nothing', async () => {
    const scene = setup({ readSession: notFound });
    await scene.ask(QUERY);
    expect(answersOf(scene.calls)).toEqual([EMPTY]);
    expect(scene.logger.warn).not.toHaveBeenCalled();
  });

  it('S3 answers empty and warns when the read fails otherwise', async () => {
    const scene = setup({
      readSession: () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
    });
    await scene.ask(QUERY);
    expect(answersOf(scene.calls)).toEqual([EMPTY]);
    expect(warnings(scene.logger)).toEqual(['trading session not shared']);
    expect(scene.logger.warn.mock.calls[0]?.[0]).toMatchObject({ sessionId: SESSION_ID });
    expect(JSON.stringify(scene.logger.warn.mock.calls[0]?.[0])).not.toContain(FILE_ID);
  });

  it.each([
    ['active', sessionView({ ...DONE, status: TradingSessionStatus.Active, stopReason: null })],
    [
      'stopped with its last trade still live',
      sessionView({ ...DONE, lastIntent: intentView({ status: TradeIntentStatus.Accepted }) }),
    ],
  ])('S4 answers empty for a session that is %s', async (_label, view) => {
    const scene = setup({ readSession: () => Promise.resolve(view) });
    await scene.ask(QUERY);
    expect(answersOf(scene.calls)).toEqual([EMPTY]);
    expect(scene.logger.warn).not.toHaveBeenCalled();
  });

  it('S5 names the asset by its id when the catalog read fails', async () => {
    const scene = setup({
      readPairs: () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
    });
    await scene.ask(QUERY);
    const result = (answersOf(scene.calls)[0]?.results as { caption?: string }[])[0];
    expect(result?.caption).toBe(
      sessionShareCaption(null, PAIR_EURUSD.id, DONE.trades, BOT_INFO.username).value,
    );
    expect(result?.caption).toContain(`актив #${String(PAIR_EURUSD.id)}`);
  });

  // the card's own fallback (trading-session.ts → sendCard): the asset of the last trade
  it("S6 without settings, names the last trade's asset; without either, answers empty", async () => {
    const bare = sessionView({ ...DONE, settings: null });
    const scene = setup({ readSession: () => Promise.resolve(bare) });
    await scene.ask(QUERY);
    const result = (answersOf(scene.calls)[0]?.results as { caption?: string }[])[0];
    expect(result?.caption).toBe(
      sessionShareCaption(
        PAIRS_RESPONSE.pairs.find((pair) => pair.id === bare.lastIntent!.assetId)?.symbol ?? null,
        bare.lastIntent!.assetId,
        DONE.trades,
        BOT_INFO.username,
      ).value,
    );

    const nothing = sessionView({ ...DONE, settings: null, lastIntent: null });
    const none = setup({ readSession: () => Promise.resolve(nothing) });
    await none.ask(QUERY);
    expect(answersOf(none.calls)).toEqual([EMPTY]);
  });

  it.each([
    ['empty', ''],
    ['the prefix alone', 'share:'],
    ['no file id', `share:${SESSION_ID}`],
    ['an empty file id', `share:${SESSION_ID}:`],
    ['not a uuid', 'share:not-a-uuid:abc'],
    ['an upper-case uuid', `share:${SESSION_ID.toUpperCase()}:abc`],
    ['a space in the file id', `share:${SESSION_ID}:ab c`],
    ['a file id of 214 characters', `share:${SESSION_ID}:${'x'.repeat(214)}`],
    ['any other text', 'hello'],
  ])('S7 answers %s empty without reading anything', async (_label, query) => {
    const scene = setup();
    await scene.ask(query);
    expect(answersOf(scene.calls)).toEqual([EMPTY]);
    expect(scene.readSession).not.toHaveBeenCalled();
    expect(scene.readPairs).not.toHaveBeenCalled();
    expect(scene.logger.warn).not.toHaveBeenCalled();
  });

  it('S8 warns when Telegram refuses the answer, with no retry', async () => {
    const scene = setup();
    const refused: ApiError = {
      ok: false,
      error_code: 400,
      description: 'Bad Request: wrong file identifier/HTTP URL specified',
    };
    scene.apiErrors.set('answerInlineQuery', refused);
    await scene.ask(QUERY);
    expect(answersOf(scene.calls)).toHaveLength(1);
    expect(warnings(scene.logger)).toEqual(['inline query not answered']);
    expect(scene.logger.warn.mock.calls[0]?.[0]).toMatchObject({
      method: 'answerInlineQuery',
      telegramErrorCode: 400,
      sessionId: SESSION_ID,
    });
  });

  it('S9 answers a query typed in a group the same: inline updates have no chat filter', async () => {
    const scene = setup();
    await scene.ask(QUERY, 'group');
    expect(answersOf(scene.calls)[0]?.results).toHaveLength(1);
  });

  it('S10 logs the chosen result with its session, and calls nothing', async () => {
    const scene = setup();
    await scene.bot.handleUpdate(chosenInlineResultUpdate(SESSION_ID, QUERY));
    expect(scene.logger.info).toHaveBeenCalledWith(
      { sessionId: SESSION_ID },
      'trading session card shared',
    );
    expect(scene.calls).toEqual([]);
    expect(scene.readSession).not.toHaveBeenCalled();
  });
});
