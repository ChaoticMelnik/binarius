import { openTradeFailWireSchema, type OpenTradeFailWire } from '@binarius/shared';

export type MockSocketEndpoint = 'auth' | 'openTrade';

// One scripted answer to the next event on an endpoint, consumed when the event arrives, before
// auth and validation (as REST scripts are). The shapes exclude each other in the type and at
// runtime (assertSocketScript), as MockScript does.
export type MockAuthScript =
  // user.auth.error with this text
  | { error: { message: string }; silent?: never; disconnect?: never }
  // no answer
  | { silent: true; error?: never; disconnect?: never }
  // the server drops the socket without an answer
  | { disconnect: true; error?: never; silent?: never };

type NoOpenTradeFields = { fail?: never; silent?: never; disconnect?: never; delayMs?: never };
export type MockOpenTradeScript =
  // user.<mode>.open_trade.fail with this array; nothing opens
  | ({ fail: OpenTradeFailWire } & Omit<NoOpenTradeFields, 'fail'> & { open?: never })
  // no answer; open: true opens the trade in the store anyway
  | ({ silent: true; open?: boolean } & Omit<NoOpenTradeFields, 'silent'>)
  // the server drops the socket first; open: true opens the trade after the drop
  | ({ disconnect: true; open?: boolean } & Omit<NoOpenTradeFields, 'disconnect'>)
  // waits, then the event is handled as if it arrived only then
  | ({ delayMs: number } & Omit<NoOpenTradeFields, 'delayMs'> & { open?: never });

export type MockSocketScript<E extends MockSocketEndpoint> = E extends 'auth'
  ? MockAuthScript
  : MockOpenTradeScript;

export type PlayedSocketScript =
  | { kind: 'error'; message: string }
  | { kind: 'fail'; failures: OpenTradeFailWire }
  | { kind: 'silent'; open: boolean }
  | { kind: 'disconnect'; open: boolean }
  | { kind: 'delay'; delayMs: number };

const DISCRIMINATORS: Record<MockSocketEndpoint, readonly string[]> = {
  auth: ['error', 'silent', 'disconnect'],
  openTrade: ['fail', 'silent', 'disconnect', 'delayMs'],
};

// the one place a socket script's shape is read: assertSocketScript validates with it, the
// socket layer plays by it
export function socketScriptKind(script: MockAuthScript | MockOpenTradeScript): PlayedSocketScript {
  const open = 'open' in script && script.open === true;
  if ('error' in script && script.error !== undefined) {
    return { kind: 'error', message: script.error.message };
  }
  if ('fail' in script && script.fail !== undefined) return { kind: 'fail', failures: script.fail };
  if ('delayMs' in script && script.delayMs !== undefined) {
    return { kind: 'delay', delayMs: script.delayMs };
  }
  if (script.disconnect !== undefined) return { kind: 'disconnect', open };
  return { kind: 'silent', open };
}

const isNonNegativeInteger = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

// a script the fixture cannot play as written would test something other than what it says
export function assertSocketScript(endpoint: MockSocketEndpoint, script: unknown): void {
  const discriminators = DISCRIMINATORS[endpoint] as readonly string[] | undefined;
  if (discriminators === undefined) {
    throw new TypeError(`failNext: unknown socket endpoint ${String(endpoint)}`);
  }
  if (script === null || typeof script !== 'object') {
    throw new TypeError(`failNext(${endpoint}): a script has one of ${discriminators.join(', ')}`);
  }
  const fields = Object.entries(script).filter(([, value]) => value !== undefined);
  const present = discriminators.filter((key) => fields.some(([field]) => field === key));
  if (present.length !== 1) {
    throw new TypeError(
      `failNext(${endpoint}): a script has exactly one of ${discriminators.join(', ')}; got ${present.join(', ') || 'none'}`,
    );
  }
  const [discriminator] = present;
  const takesOpen =
    endpoint === 'openTrade' && (discriminator === 'silent' || discriminator === 'disconnect');
  const extra = fields
    .map(([key]) => key)
    .filter((key) => key !== discriminator && !(takesOpen && key === 'open'));
  if (extra.length > 0) {
    throw new TypeError(
      `failNext(${endpoint}): { ${discriminator} } does not take ${extra.join(', ')}`,
    );
  }

  const value: unknown = (script as Record<string, unknown>)[discriminator ?? ''];
  const open: unknown = (script as Record<string, unknown>).open;
  switch (discriminator) {
    case 'silent':
    case 'disconnect':
      if (value !== true)
        throw new TypeError(`failNext(${endpoint}): ${discriminator} must be true`);
      if (open !== undefined && typeof open !== 'boolean') {
        throw new TypeError(`failNext(${endpoint}): open must be a boolean`);
      }
      return;
    case 'error': {
      const message: unknown =
        value !== null && typeof value === 'object'
          ? (value as { message?: unknown }).message
          : undefined;
      if (typeof message !== 'string') {
        throw new TypeError('failNext(auth): error is { message: string }');
      }
      return;
    }
    case 'fail':
      if (!openTradeFailWireSchema.safeParse(value).success) {
        throw new TypeError('failNext(openTrade): fail is an array of { message, field? }');
      }
      return;
    case 'delayMs':
      if (!isNonNegativeInteger(value)) {
        throw new RangeError(
          `failNext(openTrade): delayMs must be a non-negative integer, got ${String(value)}`,
        );
      }
      return;
  }
}
