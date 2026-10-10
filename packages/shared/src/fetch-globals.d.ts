// Response and ReadableStream are WHATWG globals in Node and every browser, but TypeScript ships
// their declarations only in lib.dom; the subset http-body.ts reads is declared here for the same
// reason as whatwg-encoding.d.ts (this package compiles with `types: []`). A consumer passes its
// own global Response, which has every member declared here.
interface ReadableStreamDefaultReader<T> {
  read(): Promise<{ done: true; value?: undefined } | { done: false; value: T }>;
  cancel(reason?: unknown): Promise<void>;
  releaseLock(): void;
}

interface ReadableStreamDefaultController<T> {
  enqueue(chunk: T): void;
  close(): void;
  error(reason?: unknown): void;
}

interface UnderlyingSource<T> {
  start?(controller: ReadableStreamDefaultController<T>): void | Promise<void>;
  pull?(controller: ReadableStreamDefaultController<T>): void | Promise<void>;
  cancel?(reason?: unknown): void | Promise<void>;
}

// the constructors are used by tests only
declare class ReadableStream<T> {
  constructor(source?: UnderlyingSource<T>);
  getReader(): ReadableStreamDefaultReader<T>;
  cancel(reason?: unknown): Promise<void>;
}

declare class Response {
  constructor(body?: ReadableStream<Uint8Array> | string | null, init?: { status?: number });
  readonly body: ReadableStream<Uint8Array> | null;
  readonly status: number;
}
