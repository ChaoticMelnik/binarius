import type { TradeAction } from '@binarius/shared';
import { botFile, sharedFile } from './package-root';

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

// The bot's logo on the promo card (#594), drawn into the SVG as a data URI (session-promo.ts):
// a file replaced in place changes the card without a code change. assets.test.ts gates the file.
export const PROMO_LOGO_PATH = botFile('src', 'assets', 'bot-logo.png');

// The wait for a signal's media (#859, Rule 58): the scanner's looping animation and the still
// that ends the wait, in packages/shared/assets so the backend's session wait sends the same files.
// tooling/scan-media.ts generates the defaults; a file replaced in place (any GIF or MP4, any PNG)
// changes the wait without a code change. Sent as a file per process until an answer brings its
// file_id (scan-media.ts); assets.test.ts gates both files.
export const SCAN_ANIMATION_PATH = sharedFile('assets', 'scan-radar.gif');
export const SCAN_STILL_PATH = sharedFile('assets', 'scan-still.png');
