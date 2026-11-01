import type { ApiError } from 'grammy/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BOT_TEXT_DEFAULT_SOURCES,
  BotLanguage,
  referralLinkOf,
  TradeIntentStatus,
  TradingSessionStatus,
} from '@binarius/shared';
import { botTextSourcesWith } from '@binarius/shared/testing';
import { BackendError, BackendErrorCode, type BackendClient } from './backend-client';
import { createBot } from './bot';
import type { UserLanguages } from './language';
import { INLINE_QUERY_LIMIT, SHARE_PATTERN, shareFallbackLink, shareQuery } from './session-share';
import {
  BOT_INFO,
  SESSION_ID,
  SHARE_REFERRAL_CODE,
  USER,
  captureApi,
  chosenInlineResultUpdate,
  fakeBackend,
  fakeLogger,
  inlineQueryUpdate,
  intentView,
  photoAnswer,
  sessionShare,
  sessionView,
  stubSessionResumer,
  stubSignalWaiter,
  stubSessionTracker,
  stubTracker,
  type ApiCall,
  stubShownSignals,
  stubTextSource,
  detachedWork,
  userLanguagesWith,
} from './testing';
import { sessionShareCaption, setBotTextSources } from './texts';

const STORAGE_CHAT_ID = -1001234567890;
const QUERY = shareQuery(SESSION_ID);
const OLD_FILE_ID = 'AgACAgIAAxkBAAIBY2b4c2FyZF9maWxlX2lkX2Zvcl90ZXN0cw';
const OLD_QUERY = `${QUERY}:${OLD_FILE_ID}`;
const PROMO_FILE_ID = 'AgACAgIAAxkBAAIBpromo_large';
const DONE = sessionShare();
const CAPTION = sessionShareCaption(referralLinkOf(BOT_INFO.username, SHARE_REFERRAL_CODE)).value;

function setup(
  options: {
    readSessionShare?: BackendClient['readSessionShare'];
    storageOff?: true;
    languages?: UserLanguages;
  } = {},
) {
  const readSessionShare = vi.fn<BackendClient['readSessionShare']>(
    options.readSessionShare ?? (() => Promise.resolve(DONE)),
  );
  const logger = fakeLogger();
  const bot = createBot({
    token: '123456:AA-bot-token',
    backend: fakeBackend({ readSessionShare }),
    logger,
    botInfo: BOT_INFO,
    intentTracker: stubTracker(),
    sessionTracker: stubSessionTracker(),
    sessionResumer: stubSessionResumer(),
    signalWaiter: stubSignalWaiter(),
    shownSignals: stubShownSignals(),
    detached: detachedWork(),
    ...(options.languages === undefined ? {} : { languages: options.languages }),
    ...(options.storageOff === true ? {} : { shareStorageChatId: STORAGE_CHAT_ID }),
  });
  const api = captureApi(bot);
  // sizes smallest first, as Telegram lists them: the largest is the one answered with
  api.answers.set('sendPhoto', photoAnswer(900, ['AgACAgIAAxkBAAIBpromo_small', PROMO_FILE_ID]));
  const ask = (query: string, chatType?: string) =>
    bot.handleUpdate(inlineQueryUpdate(query, chatType === undefined ? {} : { chatType }));
  return { bot, ask, logger, readSessionShare, ...api };
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
const postsOf = (calls: readonly ApiCall[]) => calls.filter((call) => call.method === 'sendPhoto');
const warnings = (logger: ReturnType<typeof fakeLogger>) =>
  logger.warn.mock.calls.map((call) => call[1] as string);
const notFound = () =>
  Promise.reject(
    new BackendError(BackendErrorCode.HttpStatus, { status: 404, reason: 'not_found' }),
  );
const EMPTY = { results: [], cache_time: 0, is_personal: true };
const photoResult = (fileId: string, caption = CAPTION) => ({
  results: [{ type: 'photo', id: SESSION_ID, photo_file_id: fileId, caption, parse_mode: 'HTML' }],
  is_personal: true,
});

// the file id each answer carried
const answeredIds = (calls: readonly ApiCall[]) =>
  answersOf(calls).map(
    (answer) => (answer.results as { photo_file_id?: string }[] | undefined)?.[0]?.photo_file_id,
  );

// every post answered with a file id of its own: promo-1, promo-2, …
function numberedPosts(scene: ReturnType<typeof setup>) {
  let posted = 0;
  scene.answers.set('sendPhoto', (payload) => {
    posted += 1;
    return photoAnswer(900 + posted, [`promo-${String(posted)}`])(payload);
  });
}

describe('the share query (#321, #538)', () => {
  it('carries the session id alone, well under the inline query limit', () => {
    expect(QUERY).toBe(`share:${SESSION_ID}`);
    expect(QUERY.length).toBeLessThan(INLINE_QUERY_LIMIT);
    expect(SHARE_PATTERN.exec(QUERY)?.slice(1)).toEqual([SESSION_ID, undefined]);
  });

  it("still reads a button sent before #538, the #318 card's file id up to the limit", () => {
    const longest = 'x'.repeat(INLINE_QUERY_LIMIT - `${QUERY}:`.length);
    expect(SHARE_PATTERN.exec(`${QUERY}:${longest}`)?.slice(1)).toEqual([SESSION_ID, longest]);
    expect(SHARE_PATTERN.test(`${QUERY}:${longest}x`)).toBe(false);
  });
});

describe('the inline share answer (#538)', () => {
  afterEach(() => setBotTextSources(BOT_TEXT_DEFAULT_SOURCES));

  it('S1 draws the promo card, posts it to the storage channel and answers with its file id', async () => {
    const scene = setup();
    await scene.ask(QUERY);
    expect(scene.readSessionShare.mock.calls).toEqual([[SESSION_ID, String(USER.id)]]);
    const posts = postsOf(scene.calls);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.payload).toMatchObject({
      chat_id: STORAGE_CHAT_ID,
      disable_notification: true,
    });
    expect(posts[0]?.payload).not.toHaveProperty('caption');
    expect(posts[0]?.payload).not.toHaveProperty('reply_markup');
    const answers = answersOf(scene.calls);
    expect(answers).toEqual([photoResult(PROMO_FILE_ID)]);
    expect(CAPTION).toBe(
      `Присоединяйся к Binarius — получи бесплатные токены!\nhttps://t.me/${BOT_INFO.username}?start=ref_${SHARE_REFERRAL_CODE}`,
    );
    expect(JSON.stringify(answers[0])).not.toContain('reply_markup');
    expect(scene.logger.warn).not.toHaveBeenCalled();
  });

  it("S1b a button sent before #538 is answered with its own card's file id, nothing posted", async () => {
    const scene = setup();
    await scene.ask(OLD_QUERY);
    expect(postsOf(scene.calls)).toEqual([]);
    expect(answersOf(scene.calls)).toEqual([photoResult(OLD_FILE_ID)]);
  });

  it('S1c a sender without a code shares the plain bot link', async () => {
    const scene = setup({
      readSessionShare: () => Promise.resolve(sessionShare({ referralCode: null })),
    });
    await scene.ask(QUERY);
    const caption = sessionShareCaption(shareFallbackLink(BOT_INFO.username)).value;
    expect(answersOf(scene.calls)).toEqual([photoResult(PROMO_FILE_ID, caption)]);
    expect(caption).toContain(`https://t.me/${BOT_INFO.username}?start=share`);
  });

  it('S2 answers another user, or a session that does not exist, empty and says nothing', async () => {
    const scene = setup({ readSessionShare: notFound });
    await scene.ask(QUERY);
    expect(answersOf(scene.calls)).toEqual([EMPTY]);
    expect(postsOf(scene.calls)).toEqual([]);
    expect(scene.logger.warn).not.toHaveBeenCalled();
  });

  it('S3 answers empty and warns when the read fails otherwise', async () => {
    const scene = setup({
      readSessionShare: () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
    });
    await scene.ask(OLD_QUERY);
    expect(answersOf(scene.calls)).toEqual([EMPTY]);
    expect(warnings(scene.logger)).toEqual(['trading session not shared']);
    expect(scene.logger.warn.mock.calls[0]?.[0]).toMatchObject({ sessionId: SESSION_ID });
    expect(JSON.stringify(scene.logger.warn.mock.calls[0]?.[0])).not.toContain(OLD_FILE_ID);
  });

  it.each([
    [
      'active',
      sessionView({ ...DONE.session, status: TradingSessionStatus.Active, stopReason: null }),
    ],
    [
      'stopped with its last trade still live',
      sessionView({
        ...DONE.session,
        lastIntent: intentView({ status: TradeIntentStatus.Accepted }),
      }),
    ],
  ])('S4 answers empty for a session that is %s', async (_label, session) => {
    const scene = setup({ readSessionShare: () => Promise.resolve(sessionShare({ session })) });
    await scene.ask(QUERY);
    expect(answersOf(scene.calls)).toEqual([EMPTY]);
    expect(postsOf(scene.calls)).toEqual([]);
    expect(scene.logger.warn).not.toHaveBeenCalled();
  });

  it('S5 answers without the pair: the card names the asset by its id', async () => {
    const scene = setup({ readSessionShare: () => Promise.resolve(sessionShare({ pair: null })) });
    await scene.ask(QUERY);
    expect(answersOf(scene.calls)).toEqual([photoResult(PROMO_FILE_ID)]);
  });

  it("S6 without settings the last trade's asset; without either, and without a trade, empty", async () => {
    const bare = sessionShare({ session: sessionView({ ...DONE.session, settings: null }) });
    const scene = setup({ readSessionShare: () => Promise.resolve(bare) });
    await scene.ask(QUERY);
    expect(answersOf(scene.calls)).toEqual([photoResult(PROMO_FILE_ID)]);

    for (const share of [
      sessionShare({
        session: sessionView({ ...DONE.session, settings: null, lastIntent: null }),
      }),
      sessionShare({ trades: [] }),
    ]) {
      const none = setup({ readSessionShare: () => Promise.resolve(share) });
      await none.ask(QUERY);
      expect(answersOf(none.calls)).toEqual([EMPTY]);
      expect(postsOf(none.calls)).toEqual([]);
    }
  });

  it.each([
    ['empty', ''],
    ['the prefix alone', 'share:'],
    ['an empty file id', `share:${SESSION_ID}:`],
    ['not a uuid', 'share:not-a-uuid'],
    ['an upper-case uuid', `share:${SESSION_ID.toUpperCase()}`],
    ['a space in the file id', `share:${SESSION_ID}:ab c`],
    ['a file id of 214 characters', `share:${SESSION_ID}:${'x'.repeat(214)}`],
    ['any other text', 'hello'],
  ])('S7 answers %s empty without reading anything', async (_label, query) => {
    const scene = setup();
    await scene.ask(query);
    expect(answersOf(scene.calls)).toEqual([EMPTY]);
    expect(scene.readSessionShare).not.toHaveBeenCalled();
    expect(scene.logger.warn).not.toHaveBeenCalled();
  });

  it('S7b without the storage channel a new button is answered empty with a warning', async () => {
    const scene = setup({ storageOff: true });
    await scene.ask(QUERY);
    expect(answersOf(scene.calls)).toEqual([EMPTY]);
    expect(postsOf(scene.calls)).toEqual([]);
    expect(scene.logger.warn.mock.calls).toEqual([
      [{ sessionId: SESSION_ID, reason: 'storage_off' }, 'trading session not shared'],
    ]);
    // an old button needs no channel
    const old = setup({ storageOff: true });
    await old.ask(OLD_QUERY);
    expect(answersOf(old.calls)).toEqual([photoResult(OLD_FILE_ID)]);
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

  it.each([
    [400, 'Bad Request: chat not found'],
    [403, 'Forbidden: bot is not a member of the channel chat'],
  ])(
    'S8b a post the channel refuses (%s) warns and answers empty, once',
    async (code, description) => {
      const scene = setup();
      scene.apiErrors.set('sendPhoto', { ok: false, error_code: code, description });
      await scene.ask(QUERY);
      expect(postsOf(scene.calls)).toHaveLength(1);
      expect(answersOf(scene.calls)).toEqual([EMPTY]);
      expect(warnings(scene.logger)).toEqual(['trading session promo not uploaded']);
      expect(scene.logger.warn.mock.calls[0]?.[0]).toMatchObject({
        method: 'sendPhoto',
        telegramErrorCode: code,
        sessionId: SESSION_ID,
      });
      expect(JSON.stringify(scene.logger.warn.mock.calls)).not.toContain(String(STORAGE_CHAT_ID));
    },
  );

  it('S8c a post answered without sizes is no_file_id and an empty answer', async () => {
    const scene = setup();
    scene.answers.set('sendPhoto', photoAnswer(900, []));
    await scene.ask(QUERY);
    expect(answersOf(scene.calls)).toEqual([EMPTY]);
    expect(scene.logger.warn.mock.calls).toEqual([
      [{ sessionId: SESSION_ID, reason: 'no_file_id' }, 'trading session not shared'],
    ]);
  });

  it('S9 answers a query typed in a group the same: inline updates have no chat filter', async () => {
    const scene = setup();
    await scene.ask(QUERY, 'group');
    expect(answersOf(scene.calls)).toEqual([photoResult(PROMO_FILE_ID)]);
  });

  // #875, Rule 72: one drawing and one post per picture and process
  it('S11 a second query of the same session is answered by the kept file id, nothing drawn or posted', async () => {
    const scene = setup();
    await scene.ask(QUERY);
    await scene.ask(QUERY);
    expect(scene.readSessionShare).toHaveBeenCalledTimes(2);
    expect(postsOf(scene.calls)).toHaveLength(1);
    expect(answersOf(scene.calls)).toEqual([
      photoResult(PROMO_FILE_ID),
      photoResult(PROMO_FILE_ID),
    ]);
    expect(scene.logger.warn).not.toHaveBeenCalled();
  });

  it('S12 a kept file id the answer refuses is forgotten: the next query posts the card again', async () => {
    const scene = setup();
    await scene.ask(QUERY);
    scene.apiErrors.set('answerInlineQuery', {
      ok: false,
      error_code: 400,
      description: 'Bad Request: wrong file identifier/HTTP URL specified',
    });
    await scene.ask(QUERY);
    scene.apiErrors.delete('answerInlineQuery');
    await scene.ask(QUERY);
    expect(postsOf(scene.calls)).toHaveLength(2);
    expect(answersOf(scene.calls)).toHaveLength(3);
    expect(warnings(scene.logger)).toEqual(['inline query not answered']);
  });

  it('S14 the same session after a language change is drawn and posted again', async () => {
    const languages = userLanguagesWith();
    const scene = setup({ languages });
    numberedPosts(scene);
    await scene.ask(QUERY);
    languages.set(USER.id, BotLanguage.En);
    await scene.ask(QUERY);
    expect(postsOf(scene.calls)).toHaveLength(2);
    expect(answeredIds(scene.calls)).toEqual(['promo-1', 'promo-2']);
  });

  it('S15 the same session after a text override of the card is drawn and posted again', async () => {
    const scene = setup();
    numberedPosts(scene);
    await scene.ask(QUERY);
    setBotTextSources(botTextSourcesWith(BotLanguage.Ru, stubTextSource('sessionPromoResult')));
    await scene.ask(QUERY);
    expect(postsOf(scene.calls)).toHaveLength(2);
    expect(answeredIds(scene.calls)).toEqual(['promo-1', 'promo-2']);
  });

  it('S16 a kept file id refused for an expired query stays kept: nothing posted again', async () => {
    const scene = setup();
    await scene.ask(QUERY);
    scene.apiErrors.set('answerInlineQuery', {
      ok: false,
      error_code: 400,
      description:
        'Bad Request: query is too old and response timeout expired or query ID is invalid',
    });
    await scene.ask(QUERY);
    scene.apiErrors.delete('answerInlineQuery');
    await scene.ask(QUERY);
    expect(postsOf(scene.calls)).toHaveLength(1);
    expect(answeredIds(scene.calls)).toEqual([PROMO_FILE_ID, PROMO_FILE_ID, PROMO_FILE_ID]);
    expect(warnings(scene.logger)).toEqual(['inline query not answered']);
  });

  it("S13 the owner's read comes before the kept id: a refused read answers empty", async () => {
    const readSessionShare = vi
      .fn<BackendClient['readSessionShare']>()
      .mockResolvedValueOnce(DONE)
      .mockImplementationOnce(notFound);
    const scene = setup({ readSessionShare });
    await scene.ask(QUERY);
    await scene.ask(QUERY);
    expect(readSessionShare).toHaveBeenCalledTimes(2);
    expect(answersOf(scene.calls)).toEqual([photoResult(PROMO_FILE_ID), EMPTY]);
    expect(postsOf(scene.calls)).toHaveLength(1);
  });

  it('S10 logs the chosen result with its session, and calls nothing', async () => {
    const scene = setup();
    await scene.bot.handleUpdate(chosenInlineResultUpdate(SESSION_ID, QUERY));
    expect(scene.logger.info).toHaveBeenCalledWith(
      { sessionId: SESSION_ID },
      'trading session card shared',
    );
    expect(scene.calls).toEqual([]);
    expect(scene.readSessionShare).not.toHaveBeenCalled();
  });
});
