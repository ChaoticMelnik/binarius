import type { TradeAction } from '@binarius/shared';
import { botFile } from './package-root';

// The pictures stay in src/assets and are found from the package's root, which holds under tsx
// and in the bundle (docs/deploy.md -> Files a package reads); botFile checks each one at import.
// assets.test.ts gates the files themselves.

// The picture of the account card (#200), sent as a file on every card.
export const ACCOUNT_CARD_PHOTO_PATH = botFile('src', 'assets', 'account-card.jpg');

// The analysis card's pictures (#482), by the signal's direction: a file replaced in place changes
// the card without a code change. Sent as a file per process and direction until an answer brings
// its file_id, then by that file_id (demo.ts); assets.test.ts gates both files.
export const SETUP_CARD_PHOTO_PATHS = {
  up: botFile('src', 'assets', 'setup-bull.png'),
  down: botFile('src', 'assets', 'setup-bear.png'),
} as const satisfies Record<TradeAction, string>;
