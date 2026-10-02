// How the fixture delivers each server->client payload. The live broker sent every payload as a
// Node Buffer (2026-10-02), the `bytes` form; `object` stays the default (owner decision, #104).
// ArrayBuffer and TypedArray arrive at a Node client as the same Buffer, so they are one form.
export const MockSocketPayload = {
  Object: 'object',
  Json: 'json',
  Bytes: 'bytes',
  Envelope: 'envelope',
} as const;
export type MockSocketPayload = (typeof MockSocketPayload)[keyof typeof MockSocketPayload];

const FORMS: ReadonlySet<unknown> = new Set(Object.values(MockSocketPayload));

export function assertSocketPayload(value: unknown): asserts value is MockSocketPayload {
  if (!FORMS.has(value)) {
    throw new RangeError(
      `socketPayload must be one of ${[...FORMS].join(', ')}, got ${String(value)}`,
    );
  }
}

// null is the payload of user.auth.success and user.disconnect_token_expired; the live broker
// sent it as a plain null while every other payload was bytes, so it skips the encoding
export function encodeSocketPayload(value: unknown, form: MockSocketPayload): unknown {
  if (value === null) return null;
  switch (form) {
    case MockSocketPayload.Object:
      return value;
    case MockSocketPayload.Json:
      return JSON.stringify(value);
    case MockSocketPayload.Bytes:
      return Buffer.from(JSON.stringify(value));
    case MockSocketPayload.Envelope:
      return { data: [...Buffer.from(JSON.stringify(value))] };
  }
}
