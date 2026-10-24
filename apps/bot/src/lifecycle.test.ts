import { EventEmitter } from 'node:events';
import { HttpError } from 'grammy';
import type { ApiError, Update } from 'grammy/types';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { BOT_TEXT_DEFAULT_SOURCES, BOT_TEXT_SOURCES_EN, BotLanguage } from '@binarius/shared';
import { until } from '@binarius/shared/testing';
import type { BackendClient } from './backend-client';
import { createBot } from './bot';
import { runBot, type PollingLoop } from './lifecycle';
import { runWithLanguage } from './language';
import { PROFILE, setBotTextSources } from './texts';
import { STARTUP_CALLS } from './timing';
import {
  BOT_INFO,
  USER_VIEW,
  captureApi,
  stubText,
  stubTextSource,
  fakeLogger,
  startUpdate,
  type FakeLogger,
  stubSessionResumer,
  stubSignalWaiter,
  stubSessionTracker,
  stubTracker,
} from './testing';

// `bot.start()` resolves only once the polling loop has ended, which is what makes the drain
// interesting: the fake reproduces that rather than resolving straight away.
function fakeBot() {
  let resolveStart: () => void = () => {};
  let rejectStart: (error: unknown) => void = () => {};
  let resolveStop: () => void = () => {};
  let rejectStop: (error: unknown) => void = () => {};
  const started = new Promise<void>((resolve, reject) => {
    resolveStart = resolve;
    rejectStart = reject;
  });
  const stopped = new Promise<void>((resolve, reject) => {
    resolveStop = resolve;
    rejectStop = reject;
  });
  const stopCalls: number[] = [];
  const options: Parameters<PollingLoop['start']>[0][] = [];
  const api = {
    setMyCommands: vi.fn<PollingLoop['api']['setMyCommands']>(() => Promise.resolve(true as const)),
    setMyDescription: vi.fn<PollingLoop['api']['setMyDescription']>(() =>
      Promise.resolve(true as const),
    ),
    setMyShortDescription: vi.fn<PollingLoop['api']['setMyShortDescription']>(() =>
      Promise.resolve(true as const),
    ),
  };
  const bot: PollingLoop = {
    start: (startOptions) => {
      options.push(startOptions);
      return started;
    },
    stop: () => {
      stopCalls.push(Date.now());
      return stopped;
    },
    api,
  };
  return { bot, api, options, stopCalls, resolveStart, rejectStart, resolveStop, rejectStop };
}

// The signal source is a real EventEmitter rather than a hand-written double: `process` is one,
// so `on`/`once`/`emit`/`listenerCount` here are the very implementations production runs, and a
// double cannot quietly model `once` as `on` again.
const signals = () => new EventEmitter();

// a tracker with nothing in flight: its stop settles at once (#127)
const idleTracker = () => ({ stop: vi.fn(() => Promise.resolve()) });
const idleResumer = () => ({ ...idleTracker(), start: vi.fn() });
// a refresher whose first load has settled already (#301)
const idleTexts = () => ({ ...idleTracker(), loaded: () => Promise.resolve() });
// A refresher whose first load is still pending: settle() ends it, and so does stop(). In
// production start() has begun that load, and stop() awaits it, which ends within its budget —
// the stub stands for that load ending, not for a signal cutting it short.
function heldTexts() {
  let settleLoad = (): void => {};
  const first = new Promise<void>((resolve) => {
    settleLoad = resolve;
  });
  return {
    texts: {
      stop: vi.fn(() => {
        settleLoad();
        return Promise.resolve();
      }),
      loaded: () => first,
    },
    settle: () => settleLoad(),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

// the profile calls onStart makes, in order, with the warn line each one's failure writes
const REGISTRATIONS = [
  ['setMyCommands', 'bot commands not registered'],
  ['setMyDescription', 'bot description not registered'],
  ['setMyShortDescription', 'bot short description not registered'],
] as const;
// each method once per language, Russian first (#508)
const LANGUAGES = [BotLanguage.Ru, BotLanguage.En] as const;
const STARTUP_EVENTS = REGISTRATIONS.flatMap(([method]) => LANGUAGES.map(() => method));
const inRussian = <T>(read: () => T): T => runWithLanguage(BotLanguage.Ru, read);
// literals on purpose: the command list and its scope are the values asserted
const RU_COMMANDS = [
  { command: 'start', description: 'Начать' },
  { command: 'menu', description: 'Главное меню' },
  { command: 'stop', description: 'Остановить сессию' },
  { command: 'account', description: 'Аккаунт Binodex' },
  { command: 'buy', description: 'Купить токены' },
  { command: 'settings', description: 'Настройки уведомлений' },
  { command: 'language', description: 'Язык бота' },
  { command: 'invite', description: 'Пригласить друга' },
  { command: 'help', description: 'Помощь' },
  { command: 'support', description: 'Поддержка' },
  { command: 'paysupport', description: 'Вопросы по оплате Stars и возврат' },
];
const EN_COMMANDS = [
  { command: 'start', description: 'Start' },
  { command: 'menu', description: 'Main menu' },
  { command: 'stop', description: 'Stop the session' },
  { command: 'account', description: 'Binodex account' },
  { command: 'buy', description: 'Buy tokens' },
  { command: 'settings', description: 'Notification settings' },
  { command: 'language', description: 'Bot language' },
  { command: 'invite', description: 'Invite a friend' },
  { command: 'help', description: 'Help' },
  { command: 'support', description: 'Support' },
  { command: 'paysupport', description: 'Stars payment questions and refunds' },
];
const payloadsOf = (calls: readonly { method: string; payload: unknown }[], method: string) =>
  calls.filter((call) => call.method === method).map((call) => call.payload);

// pino takes either (message) or (fields, message), so the message is the last argument
const errorMessages = (log: FakeLogger): unknown[] =>
  log.error.mock.calls.map((call) => call[call.length - 1]);

const BUDGET_LINE = 'shutdown: polling did not stop within the budget, exiting anyway';
const STEP_LINE = 'shutdown: a drain step failed, exiting anyway';

describe('runBot', () => {
  it('starts long polling with this project’s own timeout, batch size and update filter', async () => {
    const fake = fakeBot();
    const log = fakeLogger();
    const signalSource = signals();
    runBot({
      tracker: idleTracker(),
      sessionTracker: idleTracker(),
      sessionResumer: idleResumer(),
      signalWaiter: idleTracker(),
      botTexts: idleTexts(),
      bot: fake.bot,
      logger: log,
      exit: vi.fn(),
      signalSource,
    });

    // Literals on purpose. These constants are what runBot passes, so an assertion written
    // against them proves the keys are there and nothing at all about the values — one update
    // per getUpdates is what makes the drain wait for at most one handler and bot.stop()
    // confirm exactly the update in flight, and timing.ts pins the constant to 1 at import.
    expect(fake.options[0]).toMatchObject({
      timeout: 5,
      limit: 1,
      allowed_updates: [
        'message',
        'callback_query',
        'my_chat_member',
        'pre_checkout_query',
        'inline_query',
        'chosen_inline_result',
      ],
    });
    expect(signalSource.listenerCount('SIGTERM')).toBe(1);
    expect(signalSource.listenerCount('SIGINT')).toBe(1);

    // literals for the same reason: the command list and its scope are the values asserted
    await fake.options[0]?.onStart?.(BOT_INFO);
    // L-lang (#508): Russian under language_code ru, English as the default for every other
    // client
    expect(fake.api.setMyCommands.mock.calls).toEqual([
      [RU_COMMANDS, { scope: { type: 'all_private_chats' }, language_code: 'ru' }],
      [EN_COMMANDS, { scope: { type: 'all_private_chats' } }],
    ]);
    // the profile texts by reference: their content is checked where it lives, texts.test.ts
    expect(fake.api.setMyDescription.mock.calls).toEqual([
      [inRussian(() => PROFILE.description), { language_code: 'ru' }],
      [BOT_TEXT_SOURCES_EN.profileDescription, {}],
    ]);
    expect(fake.api.setMyShortDescription.mock.calls).toEqual([
      [inRussian(() => PROFILE.shortDescription), { language_code: 'ru' }],
      [BOT_TEXT_SOURCES_EN.profileShortDescription, {}],
    ]);
    expect(log.info).toHaveBeenCalledWith('bot started');
    expect(log.info.mock.invocationCallOrder[0]).toBeGreaterThan(
      Math.max(...fake.api.setMyShortDescription.mock.invocationCallOrder),
    );
    fake.resolveStart();
  });

  it('R1 publishes after the first texts load, with the overrides it applied (#301)', async () => {
    const fake = fakeBot();
    const held = heldTexts();
    runBot({
      tracker: idleTracker(),
      sessionTracker: idleTracker(),
      sessionResumer: idleResumer(),
      signalWaiter: idleTracker(),
      botTexts: held.texts,
      bot: fake.bot,
      logger: fakeLogger(),
      exit: vi.fn(),
      signalSource: signals(),
    });
    try {
      const onStart = fake.options[0]?.onStart?.(BOT_INFO);
      await settle();
      expect(fake.api.setMyCommands).not.toHaveBeenCalled();
      expect(fake.api.setMyDescription).not.toHaveBeenCalled();

      // #634: each language with overrides of its own
      setBotTextSources({
        [BotLanguage.Ru]: stubTextSource('startCommand', 'profileDescription'),
        [BotLanguage.En]: {
          sourceOf: (key) =>
            key === 'startCommand' ? 'Go' : BOT_TEXT_DEFAULT_SOURCES.en.sourceOf(key),
        },
      });
      held.settle();
      await onStart;
      expect(fake.api.setMyCommands.mock.calls[0]?.[0][0]).toEqual({
        command: 'start',
        description: stubText('startCommand'),
      });
      expect(fake.api.setMyCommands.mock.calls[0]?.[0][1]).toEqual({
        command: 'menu',
        description: 'Главное меню',
      });
      // the English call carries the English overrides of the first load (#634)
      expect(fake.api.setMyCommands.mock.calls[1]?.[0][0]).toEqual({
        command: 'start',
        description: 'Go',
      });
      expect(fake.api.setMyDescription.mock.calls).toEqual([
        [stubText('profileDescription'), { language_code: 'ru' }],
        [BOT_TEXT_SOURCES_EN.profileDescription, {}],
      ]);
    } finally {
      setBotTextSources(BOT_TEXT_DEFAULT_SOURCES);
      fake.resolveStart();
    }
  });

  it('R3 publishes nothing when a signal arrives while the first load is pending', async () => {
    const fake = fakeBot();
    const log = fakeLogger();
    const exit = vi.fn();
    const signalSource = signals();
    const held = heldTexts();
    runBot({
      tracker: idleTracker(),
      sessionTracker: idleTracker(),
      sessionResumer: idleResumer(),
      signalWaiter: idleTracker(),
      botTexts: held.texts,
      bot: fake.bot,
      logger: log,
      exit,
      signalSource,
    });
    const onStart = fake.options[0]?.onStart?.(BOT_INFO);
    await settle();

    signalSource.emit('SIGTERM');
    await onStart;
    fake.resolveStop();
    fake.resolveStart();
    await until('the exit', () => exit.mock.calls.length >= 1);
    expect(exit.mock.calls).toEqual([[0]]);
    for (const [method] of REGISTRATIONS) expect(fake.api[method]).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalledWith('bot started');
  });

  // call order alone cannot tell this apart from Promise.all, which invokes all three at once;
  // a method's two languages go together (#508), under one client timeout
  it('makes one method at a time, both languages of it together', async () => {
    const fake = fakeBot();
    const log = fakeLogger();
    const releases: (() => void)[] = [];
    fake.api.setMyCommands.mockImplementation(
      () =>
        new Promise<true>((resolve) => {
          releases.push(() => resolve(true));
        }),
    );
    runBot({
      tracker: idleTracker(),
      sessionTracker: idleTracker(),
      sessionResumer: idleResumer(),
      signalWaiter: idleTracker(),
      botTexts: idleTexts(),
      bot: fake.bot,
      logger: log,
      exit: vi.fn(),
      signalSource: signals(),
    });

    const onStart = fake.options[0]?.onStart?.(BOT_INFO);
    await until('setMyCommands', () => fake.api.setMyCommands.mock.calls.length >= 2);
    expect(fake.api.setMyCommands).toHaveBeenCalledTimes(2);
    expect(fake.api.setMyDescription).not.toHaveBeenCalled();
    expect(fake.api.setMyShortDescription).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();

    releases[0]?.();
    await settle();
    expect(fake.api.setMyDescription).not.toHaveBeenCalled();
    releases[1]?.();
    await onStart;
    expect(fake.api.setMyDescription).toHaveBeenCalledTimes(2);
    expect(fake.api.setMyShortDescription).toHaveBeenCalledTimes(2);
    expect(Math.max(...fake.api.setMyDescription.mock.invocationCallOrder)).toBeLessThan(
      Math.min(...fake.api.setMyShortDescription.mock.invocationCallOrder),
    );
    expect(log.info.mock.calls).toEqual([['bot started']]);
    expect(log.info.mock.invocationCallOrder[0]).toBeGreaterThan(
      Math.max(...fake.api.setMyShortDescription.mock.invocationCallOrder),
    );
    fake.resolveStart();
  });

  // neither a GrammyError nor an HttpError — a throwing transformer, a bug — still costs only
  // that part of the profile: onStart resolving is what keeps start() from rejecting and the
  // process from exit 1, and the other calls are still made
  it.each(REGISTRATIONS)(
    'goes on when %s fails for a reason the transport cannot produce',
    async (method, message) => {
      const fake = fakeBot();
      const log = fakeLogger();
      const exit = vi.fn();
      fake.api[method].mockImplementation(() => Promise.reject(new TypeError('sentinel')));
      runBot({
        tracker: idleTracker(),
        sessionTracker: idleTracker(),
        sessionResumer: idleResumer(),
        signalWaiter: idleTracker(),
        botTexts: idleTexts(),
        bot: fake.bot,
        logger: log,
        exit,
        signalSource: signals(),
      });

      await expect(fake.options[0]?.onStart?.(BOT_INFO)).resolves.toBeUndefined();
      expect(log.warn.mock.calls).toEqual(
        LANGUAGES.map((botLanguage) => [
          { err: { name: 'TypeError' }, method, botLanguage },
          message,
        ]),
      );
      for (const [other] of REGISTRATIONS) expect(fake.api[other]).toHaveBeenCalledTimes(2);
      expect(exit).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith('bot started');
      expect(log.info.mock.invocationCallOrder[0]).toBeGreaterThan(
        log.warn.mock.invocationCallOrder[0] ?? Infinity,
      );
      fake.resolveStart();
    },
  );

  it('exits non-zero when polling never starts', async () => {
    const fake = fakeBot();
    const log = fakeLogger();
    const exit = vi.fn();
    runBot({
      tracker: idleTracker(),
      sessionTracker: idleTracker(),
      sessionResumer: idleResumer(),
      signalWaiter: idleTracker(),
      botTexts: idleTexts(),
      bot: fake.bot,
      logger: log,
      exit,
      signalSource: signals(),
    });

    fake.rejectStart(Object.assign(new Error('Unauthorized'), { name: 'GrammyError' }));
    await until('the exit', () => exit.mock.calls.length >= 1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(log.error.mock.calls[0]?.[0]).toMatchObject({ err: { name: 'GrammyError' } });
  });

  it('stops once however many signals arrive, and exits 0 when the drain finishes', async () => {
    const fake = fakeBot();
    const exit = vi.fn();
    const signalSource = signals();
    runBot({
      tracker: idleTracker(),
      sessionTracker: idleTracker(),
      sessionResumer: idleResumer(),
      signalWaiter: idleTracker(),
      botTexts: idleTexts(),
      bot: fake.bot,
      logger: fakeLogger(),
      exit,
      signalSource,
    });

    signalSource.emit('SIGTERM');
    // Half of "a second signal is ignored" is that there still is a listener to ignore it with:
    // registered with `once`, the handler is gone by now, and in production Node would answer
    // the second SIGTERM with its default action and kill the drain. An EventEmitter cannot
    // model that half — it has no default action — so the premise itself is what is asserted.
    expect(
      signalSource.listenerCount('SIGTERM'),
      'the SIGTERM handler must survive the first signal (`on`, not `once`), or the second one ' +
        'kills the drain instead of being ignored',
    ).toBe(1);
    signalSource.emit('SIGTERM');
    signalSource.emit('SIGINT');
    expect(fake.stopCalls).toHaveLength(1);

    fake.resolveStop();
    fake.resolveStart();
    await until('the exit', () => exit.mock.calls.length >= 1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('waits for the polling loop itself, not only for stop()', async () => {
    const fake = fakeBot();
    const exit = vi.fn();
    const signalSource = signals();
    runBot({
      tracker: idleTracker(),
      sessionTracker: idleTracker(),
      sessionResumer: idleResumer(),
      signalWaiter: idleTracker(),
      botTexts: idleTexts(),
      bot: fake.bot,
      logger: fakeLogger(),
      exit,
      signalSource,
    });

    signalSource.emit('SIGTERM');
    fake.resolveStop();
    await settle();
    expect(exit).not.toHaveBeenCalled();

    // the real loop resolves after stop() has aborted its getUpdates
    fake.resolveStart();
    await until('the exit', () => exit.mock.calls.length >= 1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits non-zero when the drain overruns its budget, and blames the budget', async () => {
    const fake = fakeBot();
    const log = fakeLogger();
    const exit = vi.fn();
    const signalSource = signals();
    runBot({
      tracker: idleTracker(),
      sessionTracker: idleTracker(),
      sessionResumer: idleResumer(),
      signalWaiter: idleTracker(),
      botTexts: idleTexts(),
      bot: fake.bot,
      logger: log,
      exit,
      shutdownBudgetMs: 20,
      signalSource,
    });

    signalSource.emit('SIGTERM');
    await until('the exit', () => exit.mock.calls.length >= 1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(errorMessages(log)).toEqual([BUDGET_LINE]);

    fake.resolveStop();
    fake.resolveStart();
  });

  it('lets the drain own the exit code when polling rejects after the signal', async () => {
    const fake = fakeBot();
    const log = fakeLogger();
    const exit = vi.fn();
    const signalSource = signals();
    runBot({
      tracker: idleTracker(),
      sessionTracker: idleTracker(),
      sessionResumer: idleResumer(),
      signalWaiter: idleTracker(),
      botTexts: idleTexts(),
      bot: fake.bot,
      logger: log,
      exit,
      signalSource,
    });

    signalSource.emit('SIGTERM');
    fake.resolveStop();
    // without the stopping guard this handler would exit(1) on its own and kill the middleware
    // closeAll is still waiting for, then closeAll would exit a second time
    fake.rejectStart(Object.assign(new Error('polling died'), { name: 'GrammyError' }));
    await until('the exit', () => exit.mock.calls.length >= 1);

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(errorMessages(log)).toEqual(['shutdown: polling loop failed', STEP_LINE]);
    expect(log.error.mock.calls[0]?.[0]).toMatchObject({ err: { name: 'GrammyError' } });
  });

  it('names bot.stop() when that is the step that failed', async () => {
    const fake = fakeBot();
    const log = fakeLogger();
    const exit = vi.fn();
    const signalSource = signals();
    runBot({
      tracker: idleTracker(),
      sessionTracker: idleTracker(),
      sessionResumer: idleResumer(),
      signalWaiter: idleTracker(),
      botTexts: idleTexts(),
      bot: fake.bot,
      logger: log,
      exit,
      signalSource,
    });

    signalSource.emit('SIGTERM');
    fake.rejectStop(Object.assign(new Error('stop died'), { name: 'GrammyError' }));
    fake.resolveStart();
    await until('the exit', () => exit.mock.calls.length >= 1);

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(errorMessages(log)).toEqual(['shutdown: bot.stop() failed', STEP_LINE]);
  });

  // #127
  it('stops the intent tracker with the bot and waits for it', async () => {
    const fake = fakeBot();
    const exit = vi.fn();
    const signalSource = signals();
    let release: () => void = () => {};
    const tracker = {
      stop: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      ),
    };
    runBot({
      tracker,
      sessionTracker: idleTracker(),
      sessionResumer: idleResumer(),
      signalWaiter: idleTracker(),
      botTexts: idleTexts(),
      bot: fake.bot,
      logger: fakeLogger(),
      exit,
      signalSource,
    });

    signalSource.emit('SIGTERM');
    expect(tracker.stop).toHaveBeenCalledTimes(1);
    fake.resolveStop();
    fake.resolveStart();
    await settle();
    expect(exit).not.toHaveBeenCalled();
    release();
    await until('the exit', () => exit.mock.calls.length >= 1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('names the intent tracker when its stop fails', async () => {
    const fake = fakeBot();
    const log = fakeLogger();
    const exit = vi.fn();
    const signalSource = signals();
    const tracker = { stop: vi.fn(() => Promise.reject(new Error('tracker died'))) };
    runBot({
      tracker,
      sessionTracker: idleTracker(),
      sessionResumer: idleResumer(),
      signalWaiter: idleTracker(),
      botTexts: idleTexts(),
      bot: fake.bot,
      logger: log,
      exit,
      signalSource,
    });

    signalSource.emit('SIGTERM');
    fake.resolveStop();
    fake.resolveStart();
    await until('the exit', () => exit.mock.calls.length >= 1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(errorMessages(log)).toEqual(['shutdown: intent tracker failed', STEP_LINE]);
  });

  it('blames the budget when the intent tracker never stops', async () => {
    const fake = fakeBot();
    const log = fakeLogger();
    const exit = vi.fn();
    const signalSource = signals();
    const tracker = { stop: vi.fn(() => new Promise<void>(() => {})) };
    runBot({
      tracker,
      sessionTracker: idleTracker(),
      sessionResumer: idleResumer(),
      signalWaiter: idleTracker(),
      botTexts: idleTexts(),
      bot: fake.bot,
      logger: log,
      exit,
      shutdownBudgetMs: 20,
      signalSource,
    });

    signalSource.emit('SIGTERM');
    fake.resolveStop();
    fake.resolveStart();
    await until('the exit', () => exit.mock.calls.length >= 1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(errorMessages(log)).toEqual([BUDGET_LINE]);
  });

  // #284
  it('stops the session tracker with the bot and waits for it', async () => {
    const fake = fakeBot();
    const exit = vi.fn();
    const signalSource = signals();
    let release: () => void = () => {};
    const sessionTracker = {
      stop: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      ),
    };
    runBot({
      tracker: idleTracker(),
      sessionTracker,
      sessionResumer: idleResumer(),
      signalWaiter: idleTracker(),
      botTexts: idleTexts(),
      bot: fake.bot,
      logger: fakeLogger(),
      exit,
      signalSource,
    });

    signalSource.emit('SIGTERM');
    expect(sessionTracker.stop).toHaveBeenCalledTimes(1);
    fake.resolveStop();
    fake.resolveStart();
    await settle();
    expect(exit).not.toHaveBeenCalled();
    release();
    await until('the exit', () => exit.mock.calls.length >= 1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  // #567
  it('starts the session recovery once the profile is published, and not after a signal during the load', async () => {
    const fake = fakeBot();
    const order: string[] = [];
    fake.api.setMyShortDescription.mockImplementation(() => {
      order.push('profile');
      return Promise.resolve(true as const);
    });
    const sessionResumer = { ...idleResumer(), start: vi.fn(() => void order.push('resume')) };
    runBot({
      tracker: idleTracker(),
      sessionTracker: idleTracker(),
      sessionResumer,
      signalWaiter: idleTracker(),
      botTexts: idleTexts(),
      bot: fake.bot,
      logger: fakeLogger(),
      exit: vi.fn(),
      signalSource: signals(),
    });
    expect(sessionResumer.start).not.toHaveBeenCalled();
    await fake.options[0]?.onStart?.(BOT_INFO);
    expect(order).toEqual(['profile', 'profile', 'resume']);
    fake.resolveStart();

    const held = heldTexts();
    const signalled = fakeBot();
    const signalSource = signals();
    const late = idleResumer();
    runBot({
      tracker: idleTracker(),
      sessionTracker: idleTracker(),
      sessionResumer: late,
      signalWaiter: idleTracker(),
      botTexts: held.texts,
      bot: signalled.bot,
      logger: fakeLogger(),
      exit: vi.fn(),
      signalSource,
    });
    const onStart = signalled.options[0]?.onStart?.(BOT_INFO);
    signalSource.emit('SIGTERM');
    held.settle();
    await onStart;
    expect(late.start).not.toHaveBeenCalled();
    signalled.resolveStop();
    signalled.resolveStart();
  });

  it('stops the session recovery with the bot and names it when its stop fails', async () => {
    const fake = fakeBot();
    const log = fakeLogger();
    const exit = vi.fn();
    const signalSource = signals();
    const sessionResumer = {
      start: vi.fn(),
      stop: vi.fn(() => Promise.reject(new Error('resume died'))),
    };
    runBot({
      tracker: idleTracker(),
      sessionTracker: idleTracker(),
      sessionResumer,
      signalWaiter: idleTracker(),
      botTexts: idleTexts(),
      bot: fake.bot,
      logger: log,
      exit,
      signalSource,
    });
    signalSource.emit('SIGTERM');
    expect(sessionResumer.stop).toHaveBeenCalledTimes(1);
    fake.resolveStop();
    fake.resolveStart();
    await until('the exit', () => exit.mock.calls.length >= 1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(errorMessages(log)).toEqual(['shutdown: session resume failed', STEP_LINE]);
  });

  // #664
  it('waits for the signal waiter’s stop with the bot: one that never ends overruns the budget', async () => {
    const fake = fakeBot();
    const log = fakeLogger();
    const exit = vi.fn();
    const signalSource = signals();
    const signalWaiter = { stop: vi.fn(() => new Promise<void>(() => {})) };
    runBot({
      tracker: idleTracker(),
      sessionTracker: idleTracker(),
      sessionResumer: idleResumer(),
      signalWaiter,
      botTexts: idleTexts(),
      bot: fake.bot,
      logger: log,
      exit,
      signalSource,
      shutdownBudgetMs: 50,
    });
    signalSource.emit('SIGTERM');
    expect(signalWaiter.stop).toHaveBeenCalledTimes(1);
    fake.resolveStop();
    fake.resolveStart();
    await until('the exit', () => exit.mock.calls.length >= 1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(errorMessages(log)).toEqual([
      'shutdown: polling did not stop within the budget, exiting anyway',
    ]);
  });

  it('names the signal waiter when its stop fails', async () => {
    const fake = fakeBot();
    const log = fakeLogger();
    const exit = vi.fn();
    const signalSource = signals();
    runBot({
      tracker: idleTracker(),
      sessionTracker: idleTracker(),
      sessionResumer: idleResumer(),
      signalWaiter: { stop: vi.fn(() => Promise.reject(new Error('waiter died'))) },
      botTexts: idleTexts(),
      bot: fake.bot,
      logger: log,
      exit,
      signalSource,
    });
    signalSource.emit('SIGTERM');
    fake.resolveStop();
    fake.resolveStart();
    await until('the exit', () => exit.mock.calls.length >= 1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(errorMessages(log)).toEqual(['shutdown: signal waiter failed', STEP_LINE]);
  });

  // #299
  it('S1 names the bot texts refresher when its stop fails', async () => {
    const fake = fakeBot();
    const log = fakeLogger();
    const exit = vi.fn();
    const signalSource = signals();
    runBot({
      tracker: idleTracker(),
      sessionTracker: idleTracker(),
      sessionResumer: idleResumer(),
      signalWaiter: idleTracker(),
      botTexts: {
        stop: vi.fn(() => Promise.reject(new Error('refresher died'))),
        loaded: () => Promise.resolve(),
      },
      bot: fake.bot,
      logger: log,
      exit,
      signalSource,
    });
    signalSource.emit('SIGTERM');
    fake.resolveStop();
    fake.resolveStart();
    await until('the exit', () => exit.mock.calls.length >= 1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(errorMessages(log)).toEqual(['shutdown: bot texts failed', STEP_LINE]);
  });

  it('names the session tracker when its stop fails, and blames the budget when it never stops', async () => {
    const failing = fakeBot();
    const log = fakeLogger();
    const exit = vi.fn();
    const signalSource = signals();
    runBot({
      tracker: idleTracker(),
      sessionTracker: { stop: vi.fn(() => Promise.reject(new Error('tracker died'))) },
      sessionResumer: idleResumer(),
      signalWaiter: idleTracker(),
      botTexts: idleTexts(),
      bot: failing.bot,
      logger: log,
      exit,
      signalSource,
    });
    signalSource.emit('SIGTERM');
    failing.resolveStop();
    failing.resolveStart();
    await until('the exit', () => exit.mock.calls.length >= 1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(errorMessages(log)).toEqual(['shutdown: session tracker failed', STEP_LINE]);

    const stuck = fakeBot();
    const stuckLog = fakeLogger();
    const stuckExit = vi.fn();
    const stuckSignals = signals();
    runBot({
      tracker: idleTracker(),
      sessionTracker: { stop: vi.fn(() => new Promise<void>(() => {})) },
      sessionResumer: idleResumer(),
      signalWaiter: idleTracker(),
      botTexts: idleTexts(),
      bot: stuck.bot,
      logger: stuckLog,
      exit: stuckExit,
      shutdownBudgetMs: 20,
      signalSource: stuckSignals,
    });
    stuckSignals.emit('SIGTERM');
    stuck.resolveStop();
    stuck.resolveStart();
    await until('the exit', () => stuckExit.mock.calls.length >= 1);
    expect(stuckExit).toHaveBeenCalledWith(1);
    expect(errorMessages(stuckLog)).toEqual([BUDGET_LINE]);
  });

  it('reports the failed step and the overrun separately when both happen', async () => {
    const fake = fakeBot();
    const log = fakeLogger();
    const exit = vi.fn();
    const signalSource = signals();
    runBot({
      tracker: idleTracker(),
      sessionTracker: idleTracker(),
      sessionResumer: idleResumer(),
      signalWaiter: idleTracker(),
      botTexts: idleTexts(),
      bot: fake.bot,
      logger: log,
      exit,
      shutdownBudgetMs: 20,
      signalSource,
    });

    signalSource.emit('SIGTERM');
    fake.rejectStop(Object.assign(new Error('stop died'), { name: 'GrammyError' }));
    await until('the exit', () => exit.mock.calls.length >= 1);

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    // the step logged itself when it failed; the closing line answers only for the budget
    expect(errorMessages(log)).toEqual(['shutdown: bot.stop() failed', BUDGET_LINE]);

    fake.resolveStart();
  });
});

// The premises fakeBot encodes — start() resolving only when the loop ends, stop() cutting an
// idle getUpdates short, a stop() that rejects, an init that fails without a retry, onStart,
// and a throwing handler reaching bot.catch — are assertions about grammY, and a fake cannot
// check any of them. These scenes run runBot over a real Bot whose only replacement is the
// transport, so each premise is read off the library instead of off our model of it.

const TOKEN = '123456:AA-bot-token';

// bot.stop() confirms the offset with getUpdates({ offset, limit: 1 }) — neither a timeout nor
// the polling AbortSignal, which is what tells it apart from a long poll (grammY bot.js)
const isLongPoll = (payload: Record<string, unknown>): boolean => payload.timeout !== undefined;

// the sleep grammY takes after a failed getUpdates (out/bot.js, handlePollingError)
const GRAMMY_BACKOFF_MS = 3_000;

const transportFailure = (method: string): HttpError =>
  new HttpError(`Network request for '${method}' failed!`, new Error('The operation was aborted'));

interface SceneOptions {
  recordStart?: BackendClient['recordStart'];
  withBotInfo?: boolean;
  confirmFails?: boolean;
  // registered before runBot on purpose: bot.start() issues getMe and deleteWebhook
  // synchronously, so a failure programmed after the call returns arrives too late
  apiErrors?: readonly (readonly [string, ApiError | HttpError])[];
  // what the setMyCommands answer resolves with; a held promise keeps onStart running
  registration?: Promise<true>;
}

const running: { signalSource: EventEmitter; exit: Mock }[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  // a scene left polling holds a promise that never settles; the drain is how it is put down
  for (const scene of running.splice(0)) {
    if (scene.exit.mock.calls.length === 0) scene.signalSource.emit('SIGTERM');
  }
  await settle();
});

function scene(options: SceneOptions = {}) {
  // read off the timer itself rather than off how long the drain took
  const timers = vi.spyOn(globalThis, 'setTimeout');
  const log = fakeLogger();
  const exit = vi.fn();
  const signalSource = new EventEmitter();
  const events: string[] = [];
  log.info.mockImplementation((...args: unknown[]) => {
    events.push(`info:${String(args[args.length - 1])}`);
  });

  const backend: BackendClient = {
    recordStart: options.recordStart ?? (() => Promise.resolve(USER_VIEW)),
    readAccount: () => Promise.reject(new Error('not used by these scenes')),
    readReferral: () => Promise.reject(new Error('not used by these scenes')),
    confirmLogin: () => Promise.reject(new Error('not used by these scenes')),
    sendEmailCode: () => Promise.reject(new Error('not used by these scenes')),
    emailLogin: () => Promise.reject(new Error('not used by these scenes')),
    recordChatMember: () => Promise.reject(new Error('not used by these scenes')),
    setNotificationLevel: () => Promise.reject(new Error('not used by these scenes')),
    readLanguage: () => Promise.resolve(BotLanguage.Ru),
    setLanguage: () => Promise.reject(new Error('not used here')),
    readTradingAccess: () => Promise.reject(new Error('not used by these scenes')),
    readPairs: () => Promise.reject(new Error('not used by these scenes')),
    readSignals: vi.fn(() => Promise.reject(new Error('not used here'))),
    evaluateSignal: () => Promise.reject(new Error('not used by these scenes')),
    createIntent: () => Promise.reject(new Error('not used by these scenes')),
    readIntent: () => Promise.reject(new Error('not used by these scenes')),
    startSession: () => Promise.reject(new Error('not used by these scenes')),
    readSession: () => Promise.reject(new Error('not used by these scenes')),
    stopSession: () => Promise.reject(new Error('not used by these scenes')),
    claimSessionSummary: () => Promise.reject(new Error('not used by these scenes')),
    readSessionShare: () => Promise.reject(new Error('not used by these scenes')),
    stopSessions: () => Promise.reject(new Error('not used by these scenes')),
    recordSessionMessage: () => Promise.reject(new Error('not used by these scenes')),
    listTrackedSessions: () => Promise.reject(new Error('not used by these scenes')),
    forgetSessionMessage: () => Promise.reject(new Error('not used by these scenes')),
    setStake: () => Promise.reject(new Error('not used by these scenes')),
    setTradingMode: () => Promise.reject(new Error('not used by these scenes')),
    readBotTexts: () => Promise.reject(new Error('not used by these scenes')),
    createStarsInvoice: () => Promise.reject(new Error('not used by these scenes')),
    checkStarsPreCheckout: () => Promise.reject(new Error('not used by these scenes')),
    reportStarsPaid: () => Promise.reject(new Error('not used by these scenes')),
    listStarsPayments: () => Promise.reject(new Error('not used by these scenes')),
    requestStarsRefund: () => Promise.reject(new Error('not used by these scenes')),
  };
  const bot = createBot({
    intentTracker: stubTracker(),
    sessionTracker: stubSessionTracker(),
    sessionResumer: stubSessionResumer(),
    signalWaiter: stubSignalWaiter(),
    token: TOKEN,
    backend,
    logger: log,
    ...(options.withBotInfo === false ? {} : { botInfo: BOT_INFO }),
  });
  const api = captureApi(bot);
  for (const [method, failure] of options.apiErrors ?? []) api.apiErrors.set(method, failure);

  const getUpdates = (long: boolean) =>
    api.calls.filter((call) => call.method === 'getUpdates' && isLongPoll(call.payload) === long);
  const longPolls = () => getUpdates(true);

  let pending: { resolve: (updates: Update[]) => void } | undefined;
  api.answers.set('deleteWebhook', () => {
    events.push('deleteWebhook');
    return true;
  });
  api.answers.set('setMyCommands', () => {
    events.push('setMyCommands');
    return options.registration ?? true;
  });
  for (const method of ['setMyDescription', 'setMyShortDescription']) {
    api.answers.set(method, () => {
      events.push(method);
      return true;
    });
  }
  api.answers.set('getUpdates', (payload, signal) => {
    if (!isLongPoll(payload)) {
      if (options.confirmFails === true) throw transportFailure('getUpdates');
      return [];
    }
    events.push(`getUpdates#${longPolls().length}`);
    return new Promise<Update[]>((resolve, reject) => {
      pending = { resolve };
      // what the real transport does with an aborted request
      signal?.addEventListener('abort', () => reject(transportFailure('getUpdates')));
    });
  });

  runBot({
    tracker: idleTracker(),
    sessionTracker: idleTracker(),
    sessionResumer: idleResumer(),
    signalWaiter: idleTracker(),
    botTexts: idleTexts(),
    bot,
    logger: log,
    exit,
    signalSource,
  });
  running.push({ signalSource, exit });

  return {
    api,
    log,
    exit,
    events,
    signalSource,
    longPolls,
    confirmations: () => getUpdates(false),
    methods: () => api.calls.map((call) => call.method),
    deliver: (updates: Update[]) => pending?.resolve(updates),
    backoffSleeps: () => timers.mock.calls.filter(([, ms]) => ms === GRAMMY_BACKOFF_MS).length,
    firstPoll: () => until('the first long poll', () => longPolls().length >= 1),
    drained: () => until('the drain to finish', () => exit.mock.calls.length >= 1),
  };
}

describe('runBot over the real grammY Bot the fake above stands in for', () => {
  it('waits for the handler in flight, and a second signal does not cut it short', async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const s = scene({
      recordStart: () => {
        calls += 1;
        return held.then(() => USER_VIEW);
      },
    });
    await s.firstPoll();

    const update = startUpdate('/start');
    s.deliver([update]);
    await until('the handler to reach the backend', () => calls === 1);

    s.signalSource.emit('SIGTERM');
    await until('bot.stop() to confirm the offset', () => s.confirmations().length === 1);
    expect(s.confirmations()[0]?.payload).toEqual({ offset: update.update_id + 1, limit: 1 });
    expect(s.exit).not.toHaveBeenCalled();

    s.signalSource.emit('SIGTERM');
    await settle();
    expect(s.exit).not.toHaveBeenCalled();

    release();
    await s.drained();
    expect(s.exit.mock.calls).toEqual([[0]]);
    expect(s.methods()).toContain('sendMessage');
    expect(s.backoffSleeps()).toBe(0);
  });

  it('ends an idle long poll at once rather than sleeping through the backoff', async () => {
    const s = scene();
    await s.firstPoll();

    s.signalSource.emit('SIGTERM');
    await s.drained();
    expect(s.exit.mock.calls).toEqual([[0]]);
    expect(errorMessages(s.log)).toEqual([]);
    // grammY skips its backoff because the poll was cancelled by a stop(); a drain that went
    // through it would wait the sleep out, which bot.stop() does not interrupt
    expect(s.backoffSleeps()).toBe(0);
  });

  it('blames bot.stop() when the confirming getUpdates fails, and still settles the loop', async () => {
    const s = scene({ confirmFails: true });
    await s.firstPoll();

    s.signalSource.emit('SIGTERM');
    await s.drained();
    expect(s.exit.mock.calls).toEqual([[1]]);
    expect(s.backoffSleeps()).toBe(0);
    // the step line rather than the budget line is what says the polling loop itself settled
    expect(errorMessages(s.log)).toEqual(['shutdown: bot.stop() failed', STEP_LINE]);
    expect(s.log.error.mock.calls[0]?.[0]).toMatchObject({ err: { name: 'HttpError' } });
  });

  it('exits non-zero when the token is refused, and asks getMe exactly once', async () => {
    const s = scene({
      withBotInfo: false,
      apiErrors: [['getMe', { ok: false, error_code: 401, description: 'Unauthorized' }]],
    });
    await until('the process to give up', () => s.exit.mock.calls.length >= 1);

    expect(s.exit.mock.calls).toEqual([[1]]);
    expect(errorMessages(s.log)).toEqual(['long polling stopped with an error']);
    expect(s.log.error.mock.calls[0]?.[0]).toMatchObject({ err: { name: 'GrammyError' } });
    // grammY retries neither getMe nor a 401 on the way in, so the exit is immediate
    expect(s.methods().filter((method) => method === 'getMe')).toHaveLength(1);
    expect(s.longPolls()).toHaveLength(0);
  });

  it('logs that the bot started, after the webhook is dropped and before a first poll for one update on this project’s terms', async () => {
    const s = scene();
    await s.firstPoll();

    expect(s.events).toEqual([
      'deleteWebhook',
      ...STARTUP_EVENTS,
      'info:bot started',
      'getUpdates#1',
    ]);
    // equality on the whole payloads: language_code only on the Russian ones (#508)
    expect(payloadsOf(s.api.calls, 'setMyCommands')).toEqual([
      { commands: RU_COMMANDS, scope: { type: 'all_private_chats' }, language_code: 'ru' },
      { commands: EN_COMMANDS, scope: { type: 'all_private_chats' } },
    ]);
    expect(payloadsOf(s.api.calls, 'setMyDescription')).toEqual([
      { description: inRussian(() => PROFILE.description), language_code: 'ru' },
      { description: BOT_TEXT_SOURCES_EN.profileDescription },
    ]);
    expect(payloadsOf(s.api.calls, 'setMyShortDescription')).toEqual([
      { short_description: inRussian(() => PROFILE.shortDescription), language_code: 'ru' },
      { short_description: BOT_TEXT_SOURCES_EN.profileShortDescription },
    ]);
    // the calls the budget in timing.ts is computed from: everything onStart sends
    const methods = s.methods();
    const startup = methods.slice(
      methods.indexOf('deleteWebhook') + 1,
      methods.indexOf('getUpdates'),
    );
    expect(startup).toEqual(STARTUP_EVENTS);
    // a slot a method: its two languages under one client timeout (timing.ts)
    expect(new Set(startup).size).toBe(STARTUP_CALLS);
    // The premise the fake above stands on: the options object runBot hands start() is what
    // grammY puts in getUpdates. Only the first poll — after one succeeds grammY stops sending
    // allowed_updates, because Telegram keeps the last setting (out/bot.js, loop()).
    expect(s.longPolls()[0]?.payload).toMatchObject({
      limit: 1,
      timeout: 5,
      allowed_updates: [
        'message',
        'callback_query',
        'my_chat_member',
        'pre_checkout_query',
        'inline_query',
        'chosen_inline_result',
      ],
    });
  });

  // the failed call's event is never pushed: captureApi answers a programmed failure first
  const eventsWithout = (failed: string): string[] => [
    'deleteWebhook',
    ...STARTUP_EVENTS.filter((method) => method !== failed),
    'info:bot started',
    'getUpdates#1',
  ];

  it.each(REGISTRATIONS)('goes on polling when Telegram refuses %s', async (method, message) => {
    const s = scene({
      apiErrors: [[method, { ok: false, error_code: 400, description: 'Bad Request: refused' }]],
    });
    await s.firstPoll();

    expect(s.exit).not.toHaveBeenCalled();
    expect(errorMessages(s.log)).toEqual([]);
    expect(s.log.warn.mock.calls).toEqual(
      LANGUAGES.map((botLanguage) => [
        { err: { name: 'GrammyError' }, method, telegramErrorCode: 400, botLanguage },
        message,
      ]),
    );
    expect(s.events).toEqual(eventsWithout(method));
  });

  it.each(REGISTRATIONS)('goes on polling when %s fails in transport', async (method, message) => {
    const s = scene({ apiErrors: [[method, transportFailure(method)]] });
    await s.firstPoll();

    expect(s.exit).not.toHaveBeenCalled();
    expect(errorMessages(s.log)).toEqual([]);
    expect(s.log.warn.mock.calls).toEqual(
      LANGUAGES.map((botLanguage) => [
        { err: { name: 'HttpError' }, method, transportError: { name: 'Error' }, botLanguage },
        message,
      ]),
    );
    expect(s.events).toEqual(eventsWithout(method));
  });

  // grammY's «Bot was stopped during `onStart`» branch, read off the library: stop() confirms
  // the offset while the registration runs out — every call of it, which is what
  // STARTUP_BUDGET_MS bounds — and start() then returns without a first poll
  it('drains a SIGTERM during the registration without a first poll', async () => {
    let release = (): void => {};
    const held = new Promise<true>((resolve) => {
      release = () => resolve(true);
    });
    const s = scene({ registration: held });
    await until('the registration to start', () => s.events.includes('setMyCommands'));

    s.signalSource.emit('SIGTERM');
    await until('bot.stop() to confirm the offset', () => s.confirmations().length === 1);
    expect(s.exit).not.toHaveBeenCalled();

    release();
    await s.drained();
    expect(s.exit.mock.calls).toEqual([[0]]);
    expect(s.longPolls()).toEqual([]);
    expect(errorMessages(s.log)).toEqual([]);
    // onStart finishes before grammY sees the stop, so its line follows the shutdown's
    expect(s.events).toEqual([
      'deleteWebhook',
      'setMyCommands',
      'setMyCommands',
      'info:shutting down',
      'setMyDescription',
      'setMyDescription',
      'setMyShortDescription',
      'setMyShortDescription',
      'info:bot started',
    ]);
  });

  it('hands a handler that throws to bot.catch and goes on polling', async () => {
    const s = scene({ apiErrors: [['sendMessage', transportFailure('sendMessage')]] });
    await s.firstPoll();

    const update = startUpdate('/start');
    s.deliver([update]);
    await until('the loop to ask for the next update', () => s.longPolls().length >= 2);

    expect(errorMessages(s.log)).toEqual(['update handler failed']);
    expect(s.log.error.mock.calls[0]?.[0]).toMatchObject({
      err: { name: 'HttpError' },
      updateId: update.update_id,
    });

    s.signalSource.emit('SIGTERM');
    await s.drained();
    expect(s.exit.mock.calls).toEqual([[0]]);
    expect(s.backoffSleeps()).toBe(0);
  });
});
