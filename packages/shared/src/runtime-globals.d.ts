// URL, URLSearchParams and the timer functions are WHATWG/Node globals that TypeScript declares
// only in lib.dom or @types/node; the subset used by env.ts, process.ts and admin.ts is declared
// here for the same reason
// as whatwg-encoding.d.ts (this package compiles with `types: []`).
declare class URL {
  constructor(url: string);
  protocol: string;
  hostname: string;
  username: string;
  password: string;
  pathname: string;
  search: string;
  hash: string;
  readonly href: string;
  readonly origin: string;
}

declare function setTimeout(callback: () => void, ms?: number): unknown;
declare function clearTimeout(handle: unknown): void;

declare class URLSearchParams {
  constructor(init?: string | Record<string, string> | Iterable<readonly [string, string]>);
  readonly size: number;
  set(name: string, value: string): void;
  get(name: string): string | null;
  toString(): string;
  [Symbol.iterator](): IterableIterator<[string, string]>;
}
