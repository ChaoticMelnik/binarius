import { createHmac } from 'node:crypto';

export interface SignInitDataOptions {
  botToken: string;
  telegramUserId: bigint | number;
  // seconds, as Telegram stamps it; now by default
  authDate?: number;
  // more signed fields, or replacements for user and auth_date; null leaves the field out
  fields?: Record<string, string | null>;
  // extra keys inside the user object
  user?: Record<string, unknown>;
}

// Builds initData the way Telegram does, written apart from the verifier on purpose: a shared
// helper would let both sides agree on the same mistake.
export function signInitData({
  botToken,
  telegramUserId,
  authDate = Math.floor(Date.now() / 1000),
  fields = {},
  user = {},
}: SignInitDataOptions): string {
  const signed: Record<string, string> = {
    auth_date: String(authDate),
    user: JSON.stringify({ id: Number(telegramUserId), first_name: 'Test', ...user }),
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value === null) delete signed[key];
    else signed[key] = value;
  }
  const checkString = Object.keys(signed)
    .sort()
    .map((key) => `${key}=${signed[key]}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secret).update(checkString).digest('hex');
  return new URLSearchParams({ ...signed, hash }).toString();
}
