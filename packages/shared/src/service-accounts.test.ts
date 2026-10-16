import { describe, expect, it } from 'vitest';
import { SERVICE_ACCOUNTS_MIN, serviceAccountNotWorkingReasonSchema } from './service-accounts';

describe('service accounts (#391)', () => {
  it('SC1: the minimum is the owner-decided integer 3', () => {
    expect(SERVICE_ACCOUNTS_MIN).toBe(3);
  });

  it('lists the four not-working reasons and nothing else', () => {
    expect(serviceAccountNotWorkingReasonSchema.options).toEqual([
      'user_blocked',
      'pending',
      'revoked',
      'token_expired',
    ]);
  });
});
