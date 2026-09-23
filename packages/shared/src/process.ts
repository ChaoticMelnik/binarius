type CloseStep = () => Promise<unknown>;

// Runs the steps concurrently and reports whether every one of them fulfilled within the
// budget. A step that misses the budget keeps running, and a step that rejected may have left
// its work unfinished: either way the caller must not open the next phase on top of it — it
// runs one closeAll per phase and stops at the first false.
export async function closeAll(steps: CloseStep[], timeoutMs = 5000): Promise<boolean> {
  let timer: unknown;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const settled = Promise.allSettled(steps.map(async (step) => step())).then((results) =>
    results.every((result) => result.status === 'fulfilled'),
  );
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
