// The confirm button of a pending broker-account link, whoever sends it: the bot on /start (#10)
// and the backend's push after the OAuth callback (#128). One source, so the button the backend
// sends is one the bot recognises when it is pressed. The texts themselves are in the bot texts
// catalog (bot-texts.ts); what is here is the callback and the label's branch on the address.

// Callback data is 1-64 bytes; 'confirm:' + a 36-character uuid is 44.
export const CONFIRM_CALLBACK_PREFIX = 'confirm:';
export const confirmCallbackData = (accountId: string): string =>
  `${CONFIRM_CALLBACK_PREFIX}${accountId}`;
export const CONFIRM_CALLBACK_PATTERN = new RegExp(`^${CONFIRM_CALLBACK_PREFIX}([0-9a-f-]{36})$`);

// The label with the account's address, or without one when the broker sent none. Plain: Telegram
// does not parse a label, so the broker's email keeps its `&` as is.
export const confirmButtonLabel = (
  labels: { confirmButton: (context: { email: string }) => string; confirmButtonNoEmail: string },
  email: string | null,
): string => (email === null ? labels.confirmButtonNoEmail : labels.confirmButton({ email }));
