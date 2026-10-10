import { describe, expect, it } from 'vitest';
import { assertExhausted } from './exhaustive';

describe('assertExhausted', () => {
  it('throws naming what was unhandled and the value', () => {
    expect(() => assertExhausted('nope' as never, 'revocation reason')).toThrow(
      /^unhandled revocation reason: nope$/,
    );
  });
});
