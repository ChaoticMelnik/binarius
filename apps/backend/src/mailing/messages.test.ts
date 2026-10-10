import { describe, expect, it } from 'vitest';
import { DEMO_CALLBACK_DATA, NotificationKind, plainTextOf, TOKEN_NUDGES } from '@binarius/shared';
import { LINK_BONUS_TOKENS } from '@binarius/db';
import { CLIENT_LABELS } from '../auth/texts';
import { mailingMessage } from './messages';

// #123: the progress is the share of the starter pack used, nothing else (the issue's acceptance)
describe('the low-token nudge texts', () => {
  const nudges = TOKEN_NUDGES.map((nudge) => [nudge.kind, nudge] as const);

  it.each(nudges)('claims no accuracy, learning or model in %s', (kind) => {
    const text = plainTextOf(mailingMessage(kind).text).toLowerCase();
    for (const word of ['вероятност', 'точност', 'обуч', 'учится', 'модел']) {
      expect(text).not.toContain(word);
    }
  });

  it.each(nudges)('names the balance of its threshold in %s', (kind, { usedPercent }) => {
    const left = (LINK_BONUS_TOKENS * BigInt(100 - usedPercent)) / 100n;
    const text = plainTextOf(mailingMessage(kind).text);
    expect(text).toContain(left === 0n ? 'не осталось токенов' : `не больше ${left} токенов`);
  });
});

// The owner's choice of 2026-10-10: every mailing, the low-token nudge's included, carries the
// demo button, and its text names that button
describe('the mailing keyboards', () => {
  it.each(Object.values(NotificationKind))('carries the demo button in %s', (kind) => {
    const message = mailingMessage(kind);
    expect(message.reply_markup.inline_keyboard).toEqual([
      [{ text: CLIENT_LABELS.demoButton, callback_data: DEMO_CALLBACK_DATA }],
    ]);
    expect(plainTextOf(message.text)).toContain(`«${CLIENT_LABELS.demoButton}»`);
  });
});
