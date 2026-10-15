import { fileURLToPath } from 'node:url';
import type { TradeAction } from '@binarius/shared';

// The picture of the account card (#200), sent as a file on every card. The bot runs from src
// (tsx), so the path is resolved next to this module; assets.test.ts gates the file itself.
export const ACCOUNT_CARD_PHOTO_PATH = fileURLToPath(
  new URL('./assets/account-card.jpg', import.meta.url),
);

// The analysis card's pictures (#482), by the signal's direction: a file replaced in place changes
// the card without a code change. Sent as a file once per process and direction, then by the
// file_id Telegram answered with (demo.ts); assets.test.ts gates both files.
export const SETUP_CARD_PHOTO_PATHS = {
  up: fileURLToPath(new URL('./assets/setup-bull.png', import.meta.url)),
  down: fileURLToPath(new URL('./assets/setup-bear.png', import.meta.url)),
} as const satisfies Record<TradeAction, string>;
