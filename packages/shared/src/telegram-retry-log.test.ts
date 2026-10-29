import { describe, expect, it } from 'vitest';
import {
  createTelegramRetryLog,
  TELEGRAM_RETRIED_METHODS,
  TELEGRAM_RETRY_FAILED_MESSAGE,
  TELEGRAM_RETRY_RECOVERED_MESSAGE,
  type TelegramAnswer,
} from './telegram-retry-log';

interface Line {
  level: 'warn' | 'info';
  fields: object;
  message: string;
}

const TOKEN_URL = 'https://api.telegram.org/bot<token>/getUpdates';
const DESCRIPTION = 'Too Many Requests: retry after 7';

function setup() {
  const lines: Line[] = [];
  let clock = 0;
  const log = createTelegramRetryLog({
    logger: {
      warn: (fields, message) => lines.push({ level: 'warn', fields, message }),
      info: (fields, message) => lines.push({ level: 'info', fields, message }),
    },
    now: () => (clock += 10),
  });
  return { lines, log };
}

function transportFailure(): Error {
  return Object.assign(new Error(`Network request for 'getUpdates' failed! ${TOKEN_URL}`), {
    name: 'HttpError',
    error: Object.assign(new Error(`boom at ${TOKEN_URL}`), { code: 'ECONNRESET' }),
  });
}

const ok = (): Promise<TelegramAnswer> => Promise.resolve({ ok: true, result: [] });
const refusal = (fields: Partial<TelegramAnswer> = {}): TelegramAnswer =>
  ({
    ok: false,
    error_code: 429,
    description: DESCRIPTION,
    parameters: { retry_after: 7 },
    ...fields,
  }) as TelegramAnswer;
const throwing = (error: unknown) => (): Promise<TelegramAnswer> => Promise.reject(error);
const answering = (value: unknown) => (): Promise<TelegramAnswer> =>
  Promise.resolve(value as TelegramAnswer);

describe('createTelegramRetryLog', () => {
  it('R1 logs a thrown transport failure by identity and rethrows the same error', async () => {
    const { lines, log } = setup();
    const failure = transportFailure();

    await expect(log.call('getUpdates', throwing(failure))).rejects.toBe(failure);

    expect(lines).toEqual([
      {
        level: 'warn',
        fields: {
          err: { name: 'HttpError' },
          method: 'getUpdates',
          transportError: { name: 'Error', code: 'ECONNRESET' },
          failures: 1,
          elapsedMs: 10,
        },
        message: TELEGRAM_RETRY_FAILED_MESSAGE,
      },
    ]);
  });

  it('R2 logs a refusal as the GrammyError it becomes, with retry_after, and returns it as is', async () => {
    const { lines, log } = setup();
    const answer = refusal();

    await expect(log.call('getUpdates', answering(answer))).resolves.toBe(answer);

    expect(lines).toEqual([
      {
        level: 'warn',
        fields: {
          err: { name: 'GrammyError' },
          method: 'getUpdates',
          telegramErrorCode: 429,
          retryAfterS: 7,
          failures: 1,
          elapsedMs: 10,
        },
        message: TELEGRAM_RETRY_FAILED_MESSAGE,
      },
    ]);
  });

  it.each([
    ['no parameters', { parameters: undefined }],
    ['a string retry_after', { parameters: { retry_after: '7' } }],
  ])('R2 carries no retryAfterS for a refusal with %s', async (_, fields) => {
    const { lines, log } = setup();

    await log.call('getUpdates', answering(refusal(fields as Partial<TelegramAnswer>)));

    expect(lines).toHaveLength(1);
    expect(lines[0]?.fields).not.toHaveProperty('retryAfterS');
  });

  it('R3 logs the first success after a series once, and starts the next series anew', async () => {
    const { lines, log } = setup();
    const failure = transportFailure();

    await log.call('getUpdates', throwing(failure)).catch(() => undefined);
    await log.call('getUpdates', answering(refusal()));
    await log.call('getUpdates', ok);
    await log.call('getUpdates', ok);
    await log.call('getUpdates', throwing(failure)).catch(() => undefined);

    expect(lines.map((line) => line.level)).toEqual(['warn', 'warn', 'info', 'warn']);
    expect(lines[1]?.fields).toMatchObject({ failures: 2 });
    // clock: first failure started at 10, the recovery read at 60
    expect(lines[2]).toEqual({
      level: 'info',
      fields: { method: 'getUpdates', failures: 2, downMs: 50 },
      message: TELEGRAM_RETRY_RECOVERED_MESSAGE,
    });
    expect(lines[3]?.fields).toMatchObject({ failures: 1 });
  });

  it('R4 writes nothing for a success without failures before it', async () => {
    const { lines, log } = setup();

    await log.call('getMe', ok);

    expect(lines).toEqual([]);
  });

  it('R5 stays silent about a call our own stop aborted, and does not count it', async () => {
    const { lines, log } = setup();
    const failure = transportFailure();

    await expect(log.call('getUpdates', throwing(failure), { aborted: true })).rejects.toBe(
      failure,
    );
    expect(lines).toEqual([]);

    await log.call('getUpdates', throwing(failure), { aborted: false }).catch(() => undefined);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.fields).toMatchObject({ failures: 1 });
  });

  it('R6 passes a method grammY does not retry through untouched', async () => {
    const { lines, log } = setup();
    const failure = transportFailure();
    let runs = 0;
    const counted = (run: () => Promise<TelegramAnswer>) => () => {
      runs += 1;
      return run();
    };
    const answer = refusal();

    await expect(log.call('sendMessage', counted(throwing(failure)))).rejects.toBe(failure);
    await expect(log.call('sendMessage', counted(answering(answer)))).resolves.toBe(answer);

    expect(runs).toBe(2);
    expect(lines).toEqual([]);
  });

  it('R7 keeps a series per method', async () => {
    const { lines, log } = setup();

    await log.call('getMe', throwing(transportFailure())).catch(() => undefined);
    await log.call('getUpdates', ok);
    await log.call('deleteWebhook', answering(refusal()));
    await log.call('getMe', ok);

    expect(lines.map((line) => [line.level, (line.fields as { method: string }).method])).toEqual([
      ['warn', 'getMe'],
      ['warn', 'deleteWebhook'],
      ['info', 'getMe'],
    ]);
  });

  it('R8 never logs the description, the wrapped message or the token URL', async () => {
    const { lines, log } = setup();

    await log.call('getUpdates', throwing(transportFailure())).catch(() => undefined);
    await log.call('getUpdates', answering(refusal()));
    await log.call('getUpdates', answering(null));
    await log.call('getUpdates', ok);

    expect(lines).toHaveLength(4);
    for (const line of lines) {
      const text = JSON.stringify(line.fields);
      expect(text).not.toContain(DESCRIPTION);
      expect(text).not.toContain('boom');
      expect(text).not.toContain('bot<token>');
    }
  });

  it.each([
    ['null', null],
    ['a string', 'Bad Gateway'],
    ['an object without ok', {}],
  ])('R9 logs an answer that is %s as the TypeError grammY fails on', async (_, value) => {
    const { lines, log } = setup();

    await expect(log.call('getUpdates', answering(value))).resolves.toBe(value);
    await log.call('getUpdates', answering(value));

    expect(lines).toEqual([
      expect.objectContaining({
        level: 'warn',
        fields: expect.objectContaining({
          err: { name: 'TypeError' },
          method: 'getUpdates',
          failures: 1,
        }) as object,
      }),
      expect.objectContaining({
        fields: expect.objectContaining({ failures: 2 }) as object,
      }),
    ]);
  });

  it('R10 names the retried methods and the two messages the docs quote', () => {
    expect(TELEGRAM_RETRIED_METHODS).toEqual(['getUpdates', 'getMe', 'deleteWebhook']);
    expect(TELEGRAM_RETRY_FAILED_MESSAGE).toBe('Bot API call failed, grammY retries it');
    expect(TELEGRAM_RETRY_RECOVERED_MESSAGE).toBe('Bot API call succeeded after failures');
  });
});
