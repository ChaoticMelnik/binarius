import { POSTBACK_PATH_PREFIX, postbackResponseSchema } from '@binarius/shared';
import { E2E_POSTBACK_SECRET } from './env';

export interface PostbackKeys {
  id: string;
  payment_id: string;
  a: string;
}

// A deposit delivery as the cabinet's template sends it (docs/postbacks.md); `patch` changes the
// event or a field of a repeat.
export const depositQuery = (
  keys: PostbackKeys,
  patch: Record<string, string> = {},
): Record<string, string> => ({ event: 'deposit', amount: '50', coin: 'USD', ...keys, ...patch });

// The broker's GET, straight to the backend: no proxy headers, so the route's own answer is read
export async function postback(backendUrl: string, query: Record<string, string>) {
  const url = `${backendUrl}${POSTBACK_PATH_PREFIX}${E2E_POSTBACK_SECRET}?${new URLSearchParams(query)}`;
  const response = await fetch(url);
  return { status: response.status, body: postbackResponseSchema.parse(await response.json()) };
}
