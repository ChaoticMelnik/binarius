import { describe, expect, it } from 'vitest';
import { FIRST_SESSION_CHAIN, NotificationKind } from '@binarius/shared';
import { CLIENT_LABELS, CLIENT_TEXTS } from '../auth/texts';
import { mailingMessage } from './messages';

const buttonsOf = (message: ReturnType<typeof mailingMessage>) =>
  message.reply_markup.inline_keyboard.flat();

// #484
describe('the analysis reminder message', () => {
  it('sends the catalog text with one button: a new analysis of the same pair and duration', () => {
    const message = mailingMessage(NotificationKind.AnalysisUnused, {
      assetId: 101,
      durationSec: 15,
    });
    expect(message.text).toBe(CLIENT_TEXTS.analysisUnusedReminder);
    expect(message.text.value).toContain(`«${CLIENT_LABELS.newAnalysisButton}»`);
    expect(buttonsOf(message)).toStrictEqual([
      { text: CLIENT_LABELS.newAnalysisButton, callback_data: 'demo:an:101:15' },
    ]);
  });

  // the analysis screens' rule (#126): the signal is neither a probability nor an accuracy
  it('promises no result', () => {
    const text = CLIENT_TEXTS.analysisUnusedReminder.value.toLowerCase();
    for (const word of ['вероятност', 'точност', 'гарант', 'прибыл']) {
      expect(text).not.toContain(word);
    }
  });

  it.each([
    {},
    { assetId: 0, durationSec: 15 },
    { assetId: 101 },
    { assetId: '101', durationSec: 15 },
  ])('throws on payload %j, which the sender settles as not built', (payload) => {
    expect(() => mailingMessage(NotificationKind.AnalysisUnused, payload)).toThrow();
  });
});

// #576
describe('the referral reward message', () => {
  it('sends the catalog text with the ledger row’s amount and one button: the /invite screen', () => {
    const message = mailingMessage(NotificationKind.ReferralRewarded, { tokens: '75' });
    expect(message.text).toStrictEqual(CLIENT_TEXTS.referralRewarded({ rewardTokens: '75' }));
    expect(message.text.value).toContain('+75');
    expect(message.text.value).toContain(`«${CLIENT_LABELS.inviteMoreButton}»`);
    expect(buttonsOf(message)).toStrictEqual([
      { text: CLIENT_LABELS.inviteMoreButton, callback_data: 'cmd:invite' },
    ]);
  });

  it('promises no result', () => {
    const text = CLIENT_TEXTS.referralRewarded({ rewardTokens: '50' }).value.toLowerCase();
    for (const word of ['вероятност', 'точност', 'гарант', 'прибыл']) {
      expect(text).not.toContain(word);
    }
  });

  it.each([
    {},
    { tokens: 50 },
    { tokens: '0' },
    { tokens: '-5' },
    { tokens: '1e3' },
    { tokens: '' },
    { tokens: '05' },
  ])('throws on payload %j, which the sender settles as not built', (payload) => {
    expect(() => mailingMessage(NotificationKind.ReferralRewarded, payload)).toThrow();
  });
});

describe('the first-session chain messages', () => {
  it.each(FIRST_SESSION_CHAIN.map((step) => step.kind))(
    'sends %s with the demo button whatever the payload',
    (kind) => {
      expect(buttonsOf(mailingMessage(kind, {}))).toStrictEqual([
        { text: CLIENT_LABELS.demoButton, callback_data: 'demo' },
      ]);
    },
  );
});
