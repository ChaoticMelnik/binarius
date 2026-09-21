export type CloseStep = () => Promise<unknown>;

export async function closeAll(steps: CloseStep[], timeoutMs = 5000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  const settled = Promise.allSettled(steps.map((step) => Promise.resolve().then(step)));
  try {
    await Promise.race([settled, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
