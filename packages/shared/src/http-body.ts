// The body as text, or undefined once it passes maxBytes. Counted as the bytes arrive, so a body
// without content-length, with a false one, or without an end costs at most maxBytes of memory.
// A failed read (cut mid-flight, our timeout, the caller's abort) is thrown. Every server-side
// fetch client reads its bodies through here (Architecture Rule 26).
export async function readBody(response: Response, maxBytes: number): Promise<string | undefined> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  // joined before decoding: a multi-byte character can straddle two chunks
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
