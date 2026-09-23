import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { LOG_REDACT_PATHS } from '@binarius/shared';

// the shared list is only a list of strings; this is where pino actually runs it
describe('LOG_REDACT_PATHS with pino', () => {
  it('redacts secret keys at every listed depth, including client-error shapes', () => {
    const lines: string[] = [];
    const logger = pino(
      { level: 'info', redact: [...LOG_REDACT_PATHS] },
      { write: (line: string) => void lines.push(line) },
    );
    logger.info(
      {
        token: 'ROOT-SECRET',
        req: { headers: { authorization: 'Bearer HEADER-SECRET' } },
        err: {
          message: 'request failed',
          config: { headers: { authorization: 'Bearer DEPTH3-SECRET' } },
          response: { request: { headers: { authorization: 'Bearer DEPTH4-SECRET' } } },
          a: { b: { c: { d: { password: 'DEPTH5-SECRET' } } } },
        },
      },
      'probe',
    );
    const line = lines[0] ?? '';
    for (const secret of ['ROOT', 'HEADER', 'DEPTH3', 'DEPTH4', 'DEPTH5']) {
      expect(line).not.toContain(`${secret}-SECRET`);
    }
    expect(line.match(/\[Redacted\]/g)).toHaveLength(5);
    expect(line).toContain('request failed');
  });
});
