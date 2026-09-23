type CloseStep = () => Promise<unknown>;

// Runs the steps concurrently and reports whether every one of them settled within the budget.
// A step that misses the budget keeps running: a caller that must not overlap phases runs one
// closeAll per phase and stops at the first false.
export async function closeAll(steps: CloseStep[], timeoutMs = 5000): Promise<boolean> {
  let timer: unknown;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const settled = Promise.allSettled(steps.map(async (step) => step())).then(() => true as const);
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
