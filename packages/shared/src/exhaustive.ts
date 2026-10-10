export function assertExhausted(value: never, what: string): never {
  throw new Error(`unhandled ${what}: ${String(value)}`);
}
