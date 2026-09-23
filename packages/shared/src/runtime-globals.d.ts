// URL and the timer functions are WHATWG/Node globals that TypeScript declares only in lib.dom
// or @types/node; the subset used by env.ts and process.ts is declared here for the same reason
// as whatwg-encoding.d.ts (this package compiles with `types: []`).
declare class URL {
  constructor(url: string);
  protocol: string;
  hostname: string;
  username: string;
  password: string;
}

declare function setTimeout(callback: () => void, ms?: number): unknown;
declare function clearTimeout(handle: unknown): void;
