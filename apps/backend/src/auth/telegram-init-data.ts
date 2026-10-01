import { createHmac, timingSafeEqual } from 'node:crypto';

// Why a callback's initData was refused. Only the warn line carries it; the response is one code.
export const InitDataFailure = {
  // not the shape Telegram sends: no or malformed hash, no user or auth_date, a repeated key
  Malformed: 'malformed',
  BadSignature: 'bad_signature',
  Stale: 'stale',
  // signed, but the user field holds no usable id
  BadUser: 'bad_user',
} as const;
export type InitDataFailure = (typeof InitDataFailure)[keyof typeof InitDataFailure];

export type InitDataVerdict =
  { ok: true; telegramUserId: bigint } | { ok: false; reason: InitDataFailure };

export interface InitDataVerifier {
  verify(raw: string, nowMs: number): InitDataVerdict;
}

export interface CreateInitDataVerifierOptions {
  botToken: string;
  maxAgeMs: number;
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const AUTH_DATE_PATTERN = /^\d+$/;

// The Mini App check from core.telegram.org/bots/webapps -> Validating data received via the
// Mini App: the key is HMAC-SHA256 of the bot token under "WebAppData", and the hash is
// HMAC-SHA256 of every other field, sorted by key, as `key=value` lines with the values decoded.
// Fields this code does not read (signature, start_param, chat_instance, ...) are signed too, so
// they stay in the string.
export function dataCheckString(fields: ReadonlyMap<string, string>): string {
  return [...fields.keys()]
    .filter((key) => key !== 'hash')
    .sort()
    .map((key) => `${key}=${fields.get(key) ?? ''}`)
    .join('\n');
}

export function initDataSecretKey(botToken: string): Buffer {
  return createHmac('sha256', 'WebAppData').update(botToken).digest();
}

export function createInitDataVerifier({
  botToken,
  maxAgeMs,
}: CreateInitDataVerifierOptions): InitDataVerifier {
  const secretKey = initDataSecretKey(botToken);
  return {
    verify(raw, nowMs) {
      const fields = new Map<string, string>();
      for (const [key, value] of new URLSearchParams(raw)) {
        // which copy Telegram signed is not ours to pick
        if (fields.has(key)) return { ok: false, reason: InitDataFailure.Malformed };
        fields.set(key, value);
      }
      const hash = fields.get('hash');
      const authDate = fields.get('auth_date');
      const user = fields.get('user');
      // the length is checked before the comparison: timingSafeEqual throws on unequal lengths
      if (
        hash === undefined ||
        !HASH_PATTERN.test(hash) ||
        authDate === undefined ||
        !AUTH_DATE_PATTERN.test(authDate) ||
        user === undefined
      ) {
        return { ok: false, reason: InitDataFailure.Malformed };
      }

      const expected = createHmac('sha256', secretKey).update(dataCheckString(fields)).digest();
      if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) {
        return { ok: false, reason: InitDataFailure.BadSignature };
      }

      // a future auth_date passes: only Telegram can sign one, and a clock that runs behind
      // must not refuse a real login
      if (nowMs - Number(authDate) * 1000 > maxAgeMs) {
        return { ok: false, reason: InitDataFailure.Stale };
      }

      let id: unknown;
      try {
        id = (JSON.parse(user) as { id?: unknown } | null)?.id;
      } catch {
        return { ok: false, reason: InitDataFailure.BadUser };
      }
      // past 2^53 JSON.parse has already rounded the id, and the comparison with the state's
      // owner would be about some other number
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
        return { ok: false, reason: InitDataFailure.BadUser };
      }
      return { ok: true, telegramUserId: BigInt(id) };
    },
  };
}
