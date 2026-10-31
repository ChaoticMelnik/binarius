import { describe, expect, it } from 'vitest';
import {
  BotLanguage,
  ButtonRole,
  DEMO_TO_REAL_CHAIN,
  NotificationKind,
  urlButton,
} from '@binarius/shared';
import { clientLabelsOf } from '../auth/texts';
import {
  enabledKinds,
  helpLinksConfigured,
  helpLinksKeyboard,
  managerButton,
  type HelpLinks,
} from './help-links';

const MANAGER = 'https://t.me/binarius_manager';
const CASHIER_URL = 'https://web.example/cashier';
const NONE: HelpLinks = { channelUrl: undefined, reviewsUrl: undefined, managerUrl: undefined };
const ONE_EACH: HelpLinks[] = [
  { ...NONE, channelUrl: 'https://t.me/binarius_news' },
  { ...NONE, reviewsUrl: 'https://t.me/binarius_reviews' },
  { ...NONE, managerUrl: MANAGER },
];

// #879 (docs/mailing.md → The help push)
describe('the help push links', () => {
  it('HK1 the manager button is a green url button on the contact, in the recipient’s language', () => {
    for (const language of Object.values(BotLanguage)) {
      expect(managerButton({ helpLinks: { ...NONE, managerUrl: MANAGER }, language })).toEqual(
        urlButton(ButtonRole.Forward, clientLabelsOf(language).managerButton, MANAGER),
      );
    }
    expect(
      helpLinksKeyboard({ helpLinks: { ...NONE, managerUrl: MANAGER }, language: BotLanguage.Ru })
        .inline_keyboard,
    ).toEqual([[{ text: '💬 Написать менеджеру', url: MANAGER, style: 'success' }]]);
  });

  it('HK2 there is no manager button without the contact', () => {
    expect(managerButton({ helpLinks: NONE, language: BotLanguage.Ru })).toBeUndefined();
    expect(
      managerButton({
        helpLinks: { ...NONE, channelUrl: 'https://t.me/binarius_news' },
        language: BotLanguage.Ru,
      }),
    ).toBeUndefined();
  });

  it('HK3 the links are configured when any one is set, and not when none is', () => {
    expect(helpLinksConfigured(NONE)).toBe(false);
    for (const links of ONE_EACH) expect(helpLinksConfigured(links)).toBe(true);
  });

  it('HK4 the process leaves the help push out of its kinds without a link, and keeps every kind with one', () => {
    const all = Object.values(NotificationKind);
    expect(enabledKinds({ helpLinks: NONE, cashierUrl: CASHIER_URL })).toEqual(
      all.filter((kind) => kind !== NotificationKind.HelpLinks),
    );
    for (const links of ONE_EACH) {
      expect(enabledKinds({ helpLinks: links, cashierUrl: CASHIER_URL })).toEqual(all);
    }
  });

  // #880 (docs/mailing.md → The demo-to-real chain)
  it('HK5 the process leaves the demo-to-real chain out of its kinds without the cashier', () => {
    const chain: NotificationKind[] = DEMO_TO_REAL_CHAIN.map((step) => step.kind);
    const all = Object.values(NotificationKind);
    expect(enabledKinds({ helpLinks: ONE_EACH[0]!, cashierUrl: undefined })).toEqual(
      all.filter((kind) => !chain.includes(kind)),
    );
    expect(enabledKinds({ helpLinks: NONE, cashierUrl: undefined })).toEqual(
      all.filter((kind) => !chain.includes(kind) && kind !== NotificationKind.HelpLinks),
    );
  });
});
