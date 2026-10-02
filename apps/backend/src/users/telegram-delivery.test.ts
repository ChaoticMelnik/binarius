import type { FastifyBaseLogger } from 'fastify';
import { GrammyError, HttpError } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@binarius/db';
import { isTelegramForbidden, recordTelegramSendFailure } from './telegram-delivery';

const refusal = (error_code: number) =>
  new GrammyError(
    'Call to sendMessage failed!',
    { ok: false, error_code, description: 'MARKER-DESCRIPTION' },
    'sendMessage',
    {},
  );

const logger = () => {
  const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
  return { log, asLogger: log as unknown as FastifyBaseLogger };
};

describe('isTelegramForbidden', () => {
  it.each([
    ['a GrammyError 403', refusal(403), true],
    ['a GrammyError 400', refusal(400), false],
    ['an HttpError', new HttpError('Network request failed', new Error('down')), false],
    ['a TypeError', new TypeError('x'), false],
  ])('%s → %s', (_label, error, expected) => {
    expect(isTelegramForbidden(error)).toBe(expected);
  });
});

describe('recordTelegramSendFailure', () => {
  it('never touches the database for anything but a 403', async () => {
    const transaction = vi.fn();
    const { asLogger } = logger();
    const db = { transaction } as unknown as Db;
    expect(await recordTelegramSendFailure({ db, log: asLogger }, 1n, refusal(400))).toBe(false);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('resolves false and logs the failure by name when the database fails', async () => {
    const db = {
      transaction: vi.fn(() => Promise.reject(new Error('MARKER-DB-MESSAGE'))),
    } as unknown as Db;
    const { log, asLogger } = logger();
    await expect(recordTelegramSendFailure({ db, log: asLogger }, 1n, refusal(403))).resolves.toBe(
      false,
    );
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      { err: { name: 'Error' } },
      'the Telegram block could not be recorded',
    );
    expect(JSON.stringify(log.error.mock.calls)).not.toContain('MARKER');
  });
});
