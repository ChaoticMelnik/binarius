import pino from 'pino';
import { describe, expect, it } from 'vitest';
import {
  errorLogFields,
  LOG_ERROR_KEYS,
  logOptions,
  UNNAMED_ERROR_MESSAGE,
} from '@binarius/shared';

// The shared options are only data; this is where pino actually runs them, with the same
// logOptions call index.ts makes.
const sink = () => {
  const lines: string[] = [];
  const logger = pino(logOptions('info'), { write: (line: string) => void lines.push(line) });
  const parsed = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { lines, logger, parsed };
};

describe('LOG_REDACT_PATHS with pino', () => {
  it('redacts secret keys at every listed depth, including client-error shapes', () => {
    const { lines, logger } = sink();
    logger.info(
      {
        token: 'ROOT-SECRET',
        sessionToken: 'SESSION-SECRET',
        req: {
          headers: {
            authorization: 'Bearer HEADER-SECRET',
            // the only listed key with a hyphen: whether fast-redact applies it at all is a
            // property of the engine, not of the list, so it is asked here
            'x-staff-session': 'HYPHEN-SECRET',
            cookie: 'admin_session=COOKIE-SECRET',
          },
        },
        // not one of LOG_ERROR_KEYS: under those the serializer would reduce the object before
        // redaction ever saw it, and the depths below would go unexercised
        failure: {
          message: 'request failed',
          config: { headers: { authorization: 'Bearer DEPTH3-SECRET' } },
          response: { request: { headers: { authorization: 'Bearer DEPTH4-SECRET' } } },
          a: { b: { c: { d: { password: 'DEPTH5-SECRET' } } } },
        },
      },
      'probe',
    );
    const line = lines[0] ?? '';
    for (const secret of [
      'ROOT',
      'SESSION',
      'HEADER',
      'HYPHEN',
      'COOKIE',
      'DEPTH3',
      'DEPTH4',
      'DEPTH5',
    ]) {
      expect(line).not.toContain(`${secret}-SECRET`);
    }
    expect(line.match(/\[Redacted\]/g)).toHaveLength(8);
    expect(line).toContain('request failed');
  });
});

describe('the error whitelist with pino', () => {
  const MARKERS = ['MSG-LEAK', 'STACK-LEAK', 'DETAIL-LEAK', 'HEADER-LEAK', 'CAUSE-LEAK'];
  const leaky = () => {
    const error = Object.assign(new TypeError('MSG-LEAK'), {
      code: 'E1',
      detail: 'DETAIL-LEAK',
      config: { headers: { authorization: 'Bearer HEADER-LEAK' } },
      cause: Object.assign(new Error('CAUSE-LEAK'), { code: '23505', detail: 'CAUSE-LEAK' }),
    });
    error.stack = 'TypeError: STACK-LEAK';
    return error;
  };
  const WHITELISTED = { name: 'TypeError', code: 'E1', cause: { name: 'Error', code: '23505' } };
  const expectNoMarker = (lines: string[]) => {
    for (const marker of MARKERS) expect(lines.join('')).not.toContain(marker);
  };

  it.each(LOG_ERROR_KEYS)('reduces a raw error under %s to its identity and cause', (key) => {
    const { lines, logger, parsed } = sink();
    logger.error({ [key]: leaky() }, 'given');
    expect(parsed()[0]?.[key]).toStrictEqual(WHITELISTED);
    expectNoMarker(lines);
  });

  it('writes a fixed message for an error logged positionally or as { err } alone', () => {
    const { lines, logger, parsed } = sink();
    logger.error(leaky());
    logger.error({ err: leaky() });
    for (const entry of parsed()) {
      expect(entry.msg).toBe(UNNAMED_ERROR_MESSAGE);
      expect(entry.err).toStrictEqual(WHITELISTED);
    }
    expect(parsed()).toHaveLength(2);
    expectNoMarker(lines);
  });

  it('keeps a given message', () => {
    const { lines, logger, parsed } = sink();
    logger.error(leaky(), 'given');
    expect(parsed()[0]).toMatchObject({ msg: 'given', err: WHITELISTED });
    expectNoMarker(lines);
  });

  it('carries the serializers and the hook into a child logger', () => {
    const { lines, logger, parsed } = sink();
    logger.child({ reqId: 'r1' }).error(leaky());
    expect(parsed()[0]).toMatchObject({ reqId: 'r1', msg: UNNAMED_ERROR_MESSAGE });
    expect(parsed()[0]?.err).toStrictEqual(WHITELISTED);
    expectNoMarker(lines);
  });

  it('writes errorLogFields output unchanged', () => {
    const { logger, parsed } = sink();
    logger.error(errorLogFields(leaky()), 'given');
    expect(parsed()[0]?.err).toStrictEqual({ name: 'TypeError', code: 'E1' });
    expect(parsed()[0]?.cause).toStrictEqual({ name: 'Error', code: '23505' });
  });
});
