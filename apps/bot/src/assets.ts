import { fileURLToPath } from 'node:url';

// The picture of the account card (#200), sent as a file on every card. The bot runs from src
// (tsx), so the path is resolved next to this module; assets.test.ts gates the file itself.
export const ACCOUNT_CARD_PHOTO_PATH = fileURLToPath(
  new URL('./assets/account-card.jpg', import.meta.url),
);
