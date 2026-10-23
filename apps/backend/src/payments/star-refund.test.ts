import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GrammyError, HttpError } from 'grammy';
import { afterEach, describe, expect, it } from 'vitest';
import { DeadlineError } from '@binarius/shared';
import { UNIT_WAIT_CEILING_MS } from '@binarius/shared/testing';
import {
  askRefund,
  CHARGE_ALREADY_REFUNDED,
  classifyRefundAnswer,
  createStarsRefundApi,
} from './star-refund';

const telegramError = (errorCode: number, description: string) =>
  new GrammyError(
    'Call to refundStarPayment failed',
    { ok: false, error_code: errorCode, description },
    'refundStarPayment',
    {},
  );

describe('classifyRefundAnswer (#510)', () => {
  it('T1 reads `true` as refunded', async () => {
    const api = { refundStarPayment: () => Promise.resolve(true as const) };
    expect(await askRefund(api, 42n, 'charge-1')).toEqual({ kind: 'refunded' });
  });

  it(`T2 reads a 400 with ${CHARGE_ALREADY_REFUNDED} as already refunded`, () => {
    expect(
      classifyRefundAnswer(telegramError(400, `Bad Request: ${CHARGE_ALREADY_REFUNDED}`)),
    ).toEqual({ kind: 'already_refunded' });
  });

  it.each([
    [400, 'Bad Request: CHARGE_NOT_FOUND'],
    [403, `Forbidden: ${CHARGE_ALREADY_REFUNDED}`],
    [429, 'Too Many Requests: retry after 5'],
  ])('T3 reads a %i as a refusal with its code and text', (code, text) => {
    expect(classifyRefundAnswer(telegramError(code, text))).toEqual({
      kind: 'refused',
      errorCode: code,
      description: text,
    });
  });

  it.each([500, 502])(
    'T4 reads a %i GrammyError as unknown: the refund may have happened',
    (code) => {
      expect(classifyRefundAnswer(telegramError(code, 'Bad Gateway')).kind).toBe('unknown');
    },
  );

  it('T5 reads an HttpError as unknown', () => {
    const error = new HttpError('Network request for refundStarPayment failed', new Error('x'));
    expect(classifyRefundAnswer(error)).toEqual({ kind: 'unknown', error });
  });

  it.each([
    ['a DeadlineError', new DeadlineError('timeout')],
    ['a plain Error', new Error('boom')],
  ])('T6 reads %s as unknown', (_label, error) => {
    expect(classifyRefundAnswer(error)).toEqual({ kind: 'unknown', error });
  });
});

describe('createStarsRefundApi (#510)', () => {
  let server: Server | undefined;
  afterEach(async () => {
    const running = server;
    server = undefined;
    if (running === undefined) return;
    running.closeAllConnections();
    await new Promise<void>((resolve) => running.close(() => resolve()));
  });

  it('T7 passes the caller’s signal to the call: an abort ends a call Telegram does not answer', async () => {
    let seen = '';
    // accepts the request and then says nothing: only the signal can end the call early
    server = createServer((request) => {
      seen = request.url ?? '';
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;
    const api = createStarsRefundApi({ token: '1:test', apiRoot: `http://127.0.0.1:${port}` });
    const controller = new AbortController();
    const at = Date.now();
    const call = api.refundStarPayment(42, 'charge-1', controller.signal);
    setTimeout(() => controller.abort(), 50);
    const error: unknown = await call.catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(HttpError);
    // the abort ended the call, not grammY's own timeout (STARS_TELEGRAM_API_TIMEOUT_MS), whose
    // HttpError wraps «Request to 'refundStarPayment' timed out …»
    expect(String((error as HttpError).error)).not.toContain('timed out');
    expect(Date.now() - at).toBeLessThan(UNIT_WAIT_CEILING_MS);
    expect(seen).toContain('refundStarPayment');
  });
});
