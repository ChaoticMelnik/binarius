import { ButtonRole, keyboardOf, webAppButton, type BotKeyboard } from '@binarius/shared';
import { clientLabelsOf } from '../auth/texts';
import { sharedFile } from '../package-root';
import { managerButton } from './help-links';
import type { MailingContext } from './messages';

// the 1 h step's banner (tooling/demo-to-real-banner.ts renders it from the SVG beside it)
export const DEMO_TO_REAL_BANNER_PATH = sharedFile('assets', 'demo-to-real-banner.png');

// The demo-to-real chain's keyboard (#880): the cashier and, when HELP_MANAGER_URL is set, the
// manager under it, each a green row of its own. Without the cashier the engine neither plans nor
// takes the chain; the throw (`mailing not built`) keeps a step without its button from going out.
export function demoToRealKeyboard(
  context: Pick<MailingContext, 'cashierUrl' | 'helpLinks' | 'language'>,
): BotKeyboard {
  const { cashierUrl, language } = context;
  if (cashierUrl === undefined) throw new Error('the demo-to-real chain has no cashier');
  return keyboardOf(
    [
      webAppButton(ButtonRole.Forward, clientLabelsOf(language).depositButton, cashierUrl),
      managerButton(context),
    ].filter((button) => button !== undefined),
  );
}
