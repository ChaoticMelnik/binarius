export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

export const settle = <T>(promise: Promise<T>): Promise<Settled<T>> =>
  promise.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  );
