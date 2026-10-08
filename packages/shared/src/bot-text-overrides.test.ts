import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotTextProblemCode } from './bot-text-template';
import {
  BotTextRejectionCode,
  botTextChangeProblems,
  botTextOverridesResponseSchema,
  botTextProblemMessage,
  botTextRejectionMessage,
  createBotTextRefresher,
  resolveBotTextOverrides,
  type BotTextOverrideRow,
  type BotTextRejection,
} from './bot-text-overrides';
import { BOT_TEXT_MESSAGES, estimateBotTextMessage } from './bot-text-messages';
import { BOT_TEXT_CATALOG, type BotTextKey } from './bot-texts';
import { TELEGRAM_MESSAGE_LIMIT } from './telegram-html';

const row = (key: string, source: string, version = 1): BotTextOverrideRow => ({
  key,
  source,
  version,
});
const codes = (rows: BotTextOverrideRow[]) =>
  Object.fromEntries(
    [...resolveBotTextOverrides(rows).rejected].map(([key, rejection]) => [key, rejection.code]),
  );
const accepted = (rows: BotTextOverrideRow[]) => [...resolveBotTextOverrides(rows).texts.keys()];
const longer = (key: BotTextKey, extra: number) =>
  `${BOT_TEXT_CATALOG[key].source}\n${'я'.repeat(extra)}`;

// a welcome that fits its caption with a one-letter connect button, and not with the default one
const tightWelcome = `${'я'.repeat(1022)} {connectButton}`;
// alone within /help's own limit, with the rest of /help over 4096
const longHelpAbout = 'я'.repeat(3900);

describe('resolveBotTextOverrides', () => {
  it('V1 applies a valid override', () => {
    const { source, texts } = resolveBotTextOverrides([row('welcome', 'Привет')]);
    expect(source.sourceOf('welcome')).toBe('Привет');
    expect(source.sourceOf('support')).toBe(BOT_TEXT_CATALOG.support.source);
    expect([...texts]).toEqual([['welcome', 'Привет']]);
  });

  it('V2 ignores an unknown key and applies the rest', () => {
    expect(codes([row('renamedKey', 'x', 7), row('welcome', 'Привет')])).toEqual({
      renamedKey: BotTextRejectionCode.UnknownKey,
    });
    expect(accepted([row('renamedKey', 'x'), row('welcome', 'Привет')])).toEqual(['welcome']);
    expect(resolveBotTextOverrides([row('renamedKey', 'x', 7)]).rejected.get('renamedKey')).toEqual(
      {
        code: BotTextRejectionCode.UnknownKey,
        version: 7,
      },
    );
  });

  it('V3 ignores the commands and the profile until #301', () => {
    expect(codes([row('startCommand', 'Старт'), row('profileShortDescription', 'x')])).toEqual({
      startCommand: BotTextRejectionCode.ReadOnlyGroup,
      profileShortDescription: BotTextRejectionCode.ReadOnlyGroup,
    });
  });

  it.each([
    ['<b>Привет', BotTextProblemCode.InvalidHtml],
    ['Привет, {x}', BotTextProblemCode.UnknownPlaceholder],
    ['я'.repeat(1025), BotTextProblemCode.TooLong],
  ])('V4 rejects the invalid welcome %#', (source, code) => {
    const rejection = resolveBotTextOverrides([row('welcome', source)]).rejected.get('welcome');
    expect(rejection?.code).toBe(BotTextRejectionCode.Invalid);
    expect(rejection?.code === 'invalid' && rejection.problems.map((p) => p.code)).toContain(code);
  });

  // #358 В3, in place of #240's В11: a text may leave out any of its variables
  it('V4 accepts a text that drops its variable', () => {
    expect(accepted([row('codeSent', 'Код отправлен')])).toEqual(['codeSent']);
  });

  it("O2 accepts a key's registry variables and refuses the name the key had before #358", () => {
    expect(accepted([row('statusTokens', '🪙 {firstName}, у тебя {tokens}')])).toEqual([
      'statusTokens',
    ]);
    expect(
      resolveBotTextOverrides([row('statusTokens', '🪙 {count}')]).rejected.get('statusTokens'),
    ).toMatchObject({
      code: BotTextRejectionCode.Invalid,
      problems: [{ code: BotTextProblemCode.UnknownPlaceholder, detail: 'count' }],
    });
  });

  it('O1 names the refused variable and what the key may hold', () => {
    const [problem] = botTextChangeProblems('codeSent', 'Код на {realBalance}', []);
    expect(problem && botTextRejectionMessage(problem.rejection, problem.key)).toBe(
      'Переменная {realBalance} недоступна в этом тексте. Доступны: {email}, {firstName}',
    );
    const [welcome] = botTextChangeProblems('welcome', 'Привет, {firstName}', []);
    expect(welcome && botTextRejectionMessage(welcome.rejection, welcome.key)).toBe(
      'Переменная {firstName} недоступна в этом тексте. Переменных у этого текста нет; фрагменты: {connectButton}',
    );
  });

  it('V5 rejects a fragment that breaks a host on its default', () => {
    const rejection = resolveBotTextOverrides([row('featureLines', 'я'.repeat(950))]).rejected.get(
      'featureLines',
    );
    expect(rejection).toMatchObject({ code: BotTextRejectionCode.BreaksHost, host: 'cardBody' });
  });

  it('V6 takes out an overridden host its fragment breaks, and keeps the fragment', () => {
    const rows = [
      row('cardBody', `${'я'.repeat(750)}\n{features}`),
      row('featureLines', 'я'.repeat(300)),
    ];
    expect(codes(rows)).toEqual({ cardBody: BotTextRejectionCode.Invalid });
    expect(accepted(rows)).toEqual(['featureLines']);
  });

  it('V7 takes out every overridden part of a message they overflow together', () => {
    const body = row('cardBody', longer('cardBody', 250));
    const bonus = row('cardBonusAlready', longer('cardBonusAlready', 250));
    expect(accepted([body])).toEqual(['cardBody']);
    expect(accepted([bonus])).toEqual(['cardBonusAlready']);
    const { rejected } = resolveBotTextOverrides([body, bonus]);
    expect(rejected.get('cardBody')).toMatchObject({
      code: BotTextRejectionCode.MessageOverflow,
      message: { id: 'accountCard', limit: 1024 },
    });
    expect(rejected.get('cardBonusAlready')?.code).toBe(BotTextRejectionCode.MessageOverflow);
  });

  it('V8 repeats until nothing more fails', () => {
    // /help overflows → helpAbout and connectButton go → the welcome no longer fits
    const rows = [
      row('connectButton', 'A'),
      row('welcome', tightWelcome),
      row('helpAbout', longHelpAbout),
    ];
    expect(accepted([row('connectButton', 'A'), row('welcome', tightWelcome)])).toEqual([
      'welcome',
      'connectButton',
    ]);
    expect(codes(rows)).toEqual({
      helpAbout: BotTextRejectionCode.MessageOverflow,
      connectButton: BotTextRejectionCode.MessageOverflow,
      welcome: BotTextRejectionCode.Invalid,
    });
  });

  it('V13 counts a plain label with markup at the length it is shown', () => {
    const intent = BOT_TEXT_MESSAGES.find((m) => m.id === 'intentStatus')!;
    const base = estimateBotTextMessage(intent, resolveBotTextOverrides([]).source);
    // 30 characters below the limit on its own; the label adds 63 shown characters
    const filler = 'я'.repeat(TELEGRAM_MESSAGE_LIMIT - 30 - base - 1);
    const deadline = row('intentDeadline', `${BOT_TEXT_CATALOG.intentDeadline.source}\n${filler}`);
    const action = row('actionUp', '<b></b>'.repeat(9));
    expect(accepted([deadline])).toEqual(['intentDeadline']);
    expect(accepted([action])).toEqual(['actionUp']);
    expect(codes([deadline, action])).toEqual({
      intentDeadline: BotTextRejectionCode.MessageOverflow,
      actionUp: BotTextRejectionCode.MessageOverflow,
    });
    expect(botTextChangeProblems('actionUp', action.source, [deadline])).not.toEqual([]);
  });

  it('V9 rejects nothing with no overrides', () => {
    expect(resolveBotTextOverrides([]).rejected.size).toBe(0);
  });

  it('V10 gives the same result whatever the order of the rows', () => {
    const rows = [
      row('zzz', 'x'),
      row('connectButton', 'A'),
      row('welcome', tightWelcome),
      row('aaa', 'x'),
      row('helpAbout', longHelpAbout),
    ];
    const forward = resolveBotTextOverrides(rows);
    const backward = resolveBotTextOverrides([...rows].reverse());
    expect([...backward.rejected]).toEqual([...forward.rejected]);
    expect([...backward.texts]).toEqual([...forward.texts]);
  });
});

describe('botTextChangeProblems', () => {
  const keysOf = (problems: { key: string }[]) => problems.map((p) => p.key);

  it('W1 lets a valid text through', () => {
    expect(botTextChangeProblems('welcome', 'Привет', [])).toEqual([]);
  });

  it('W2 names the host a fragment breaks', () => {
    const [problem] = botTextChangeProblems('featureLines', 'я'.repeat(950), []);
    expect(problem).toMatchObject({
      key: 'featureLines',
      rejection: { code: BotTextRejectionCode.BreaksHost, host: 'cardBody' },
    });
  });

  it('W3 names the message a text overflows', () => {
    const problems = botTextChangeProblems('cardBonusAlready', longer('cardBonusAlready', 250), [
      row('cardBody', longer('cardBody', 250)),
    ]);
    expect(keysOf(problems)).toEqual(['cardBonusAlready', 'cardBody']);
    expect(problems[0]?.rejection).toMatchObject({ message: { id: 'accountCard' } });
  });

  it('W4 refuses a reset that breaks an overridden host', () => {
    const rows = [row('connectButton', 'A'), row('welcome', tightWelcome)];
    const problems = botTextChangeProblems('connectButton', null, rows);
    expect(problems).toMatchObject([{ key: 'welcome', rejection: { code: 'invalid' } }]);
  });

  it('W5 is not blocked by an override rejected already', () => {
    const rows = [row('featureLines', 'я'.repeat(950))];
    expect(botTextChangeProblems('welcome', 'Привет', rows)).toEqual([]);
    expect(botTextChangeProblems('featureLines', null, rows)).toEqual([]);
  });

  it('W6 refuses a command description', () => {
    expect(botTextChangeProblems('startCommand', 'Старт', [])).toMatchObject([
      { key: 'startCommand', rejection: { code: BotTextRejectionCode.ReadOnlyGroup } },
    ]);
  });

  it('W7 refuses an unknown key, and lets its reset through', () => {
    expect(botTextChangeProblems('renamedKey', 'x', [])).toMatchObject([
      { key: 'renamedKey', rejection: { code: BotTextRejectionCode.UnknownKey } },
    ]);
    expect(botTextChangeProblems('renamedKey', null, [row('renamedKey', 'x')])).toEqual([]);
  });

  it('W8 words every problem and every rejection in Russian', () => {
    const problemMessages = Object.values(BotTextProblemCode).map((code) =>
      botTextProblemMessage('welcome', { code, detail: 'email' }),
    );
    expect(new Set(problemMessages).size).toBe(problemMessages.length);
    expect(botTextProblemMessage('welcome', { code: 'too_long', detail: '1100' })).toBe(
      'Текст welcome — 1100 символов при лимите 1024',
    );
    const rejected = [
      ...resolveBotTextOverrides([
        row('zzz', 'x'),
        row('startCommand', 'x'),
        row('codeSent', 'нет {tokens}'),
        row('featureLines', 'я'.repeat(950)),
      ]).rejected,
      ...resolveBotTextOverrides([
        row('cardBody', longer('cardBody', 250)),
        row('cardBonusAlready', longer('cardBonusAlready', 250)),
      ]).rejected,
    ];
    const messages = Object.fromEntries(
      rejected.map(([key, r]: [string, BotTextRejection]) => [
        key,
        botTextRejectionMessage(r, key),
      ]),
    );
    expect(messages).toEqual({
      zzz: 'Неизвестный ключ — игнорируется',
      startCommand: 'Только чтение: команды и профиль правятся после #301',
      codeSent: 'Переменная {tokens} недоступна в этом тексте. Доступны: {email}, {firstName}',
      featureLines: expect.stringMatching(
        /^Ломает текст-хозяин cardBody: Текст cardBody — \d+ символов при лимите 1024$/,
      ),
      cardBody: expect.stringMatching(
        /^Сообщение «Карточка аккаунта» станет \d+ символов при лимите 1024$/,
      ),
      cardBonusAlready: expect.stringMatching(/^Сообщение «Карточка аккаунта»/),
    });
  });
});

describe('botTextOverridesResponseSchema', () => {
  it('takes a key outside the catalog and refuses a malformed one', () => {
    const parse = (key: string) =>
      botTextOverridesResponseSchema.safeParse({ overrides: [{ key, source: 'x', version: 1 }] })
        .success;
    expect(parse('renamedKey')).toBe(true);
    expect(parse('Renamed')).toBe(false);
    expect(
      botTextOverridesResponseSchema.safeParse({
        overrides: [{ key: 'a', source: 'x', version: 0 }],
      }).success,
    ).toBe(false);
  });
});

describe('createBotTextRefresher', () => {
  const INTERVAL = 30_000;
  const BUDGET = 3_000;
  let loads: number[];
  let applied: string[];
  let warns: { fields: Record<string, unknown>; message: string }[];
  let next: () => Promise<BotTextOverrideRow[]>;

  beforeEach(() => {
    vi.useFakeTimers();
    loads = [];
    applied = [];
    warns = [];
    next = () => Promise.resolve([]);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const refresher = () =>
    createBotTextRefresher({
      load: () => {
        loads.push(Date.now());
        return next();
      },
      intervalMs: INTERVAL,
      budgetMs: BUDGET,
      apply: (source) => applied.push(source.sourceOf('welcome')),
      logger: {
        warn: (fields, message) =>
          warns.push({ fields: fields as Record<string, unknown>, message }),
      },
      failureFields: () => ({ status: 503 }),
    });
  const delay = <T>(ms: number, value: T) =>
    new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

  it('F1 loads at once on start', async () => {
    const r = refresher();
    r.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(loads).toEqual([Date.now()]);
    await r.stop();
  });

  it('F2 steps from the start of the previous load, not from its end', async () => {
    next = () => delay(2_000, []);
    const start = Date.now();
    const r = refresher();
    r.start();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(loads).toEqual([start, start + INTERVAL]);
    const stopping = r.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    await stopping;
  });

  it('F3 keeps the last loaded set when a load fails', async () => {
    next = () => Promise.resolve([row('welcome', 'Привет')]);
    const r = refresher();
    r.start();
    await vi.advanceTimersByTimeAsync(0);
    next = () => Promise.reject(new Error('down'));
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(applied).toEqual(['Привет']);
    await r.stop();
  });

  it('F4 applies nothing before the first success: the defaults stay', async () => {
    next = () => Promise.reject(new Error('down'));
    const r = refresher();
    r.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(applied).toEqual([]);
    await r.stop();
  });

  it('F5 counts a load over the budget as failed', async () => {
    next = () => delay(BUDGET + 1, [row('welcome', 'Поздно')]);
    const r = refresher();
    r.start();
    await vi.advanceTimersByTimeAsync(BUDGET + 1);
    expect(applied).toEqual([]);
    expect(warns[0]?.fields).toMatchObject({ err: { name: 'BotTextsLoadTimeout' } });
    await r.stop();
  });

  it('F6 waits on stop for the load in flight, at most the budget, and never starts again', async () => {
    next = () => new Promise(() => undefined);
    const r = refresher();
    r.start();
    let stopped = false;
    void r.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(BUDGET - 1);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(stopped).toBe(true);
    r.start();
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(loads).toHaveLength(1);
  });

  it('F7 reports rejected overrides once per change of the set', async () => {
    next = () => Promise.resolve([row('zzz', 'x', 4)]);
    const r = refresher();
    r.start();
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(loads).toHaveLength(3);
    expect(warns.map((w) => w.fields)).toEqual([
      { botTextKey: 'zzz', botTextVersion: 4, rejection: 'unknown_key' },
    ]);
    next = () => Promise.resolve([row('zzz', 'x', 5)]);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(warns).toHaveLength(2);
    await r.stop();
  });

  it('F8 logs a failure by identity only', async () => {
    next = () => Promise.reject(Object.assign(new Error('secret body'), { code: 'ECONNREFUSED' }));
    const r = refresher();
    r.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(warns).toEqual([
      {
        fields: { err: { name: 'Error', code: 'ECONNREFUSED' }, status: 503 },
        message: 'bot texts load failed, the last loaded texts stay',
      },
    ]);
    expect(JSON.stringify(warns)).not.toContain('secret');
    await r.stop();
  });
});
