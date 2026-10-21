import {
  BrokerBalanceUnavailableReason,
  UserStatus,
  type BotButton,
  type BotKeyboard,
  type BrokerBalanceView,
  type TelegramHtml,
  type TradingAccessResponse,
} from '@binarius/shared';
import { supportButton } from './keyboards';
import { TEXTS } from './texts';

// What an access read says before any amount can be offered, for the stake picker (#297, #326)
// and the amount screen of a demo cycle (#476): the refusals the stake press would give
// (demo-trade.ts amountOf), the same in both modes, each given to the caller's way back, which
// lays it out with its own button; or the broker snapshot the amounts are drawn from.
export type StakeAccess =
  { refusal: { text: TelegramHtml; keyboard: BotKeyboard } } | { broker: BrokerBalanceView };

export function stakeAccess(
  { status, broker, brokerUnavailable }: TradingAccessResponse,
  back: (actions: readonly BotButton[]) => BotKeyboard,
  connectButtons: () => BotButton[],
): StakeAccess {
  if (status === UserStatus.Blocked) {
    // the support link, as for every blocked user (#350), then the way back
    return { refusal: { text: TEXTS.blocked, keyboard: back([supportButton()]) } };
  }
  if (broker !== null) return { broker };
  if (brokerUnavailable === BrokerBalanceUnavailableReason.NoAccount) {
    return { refusal: { text: TEXTS.accountNone, keyboard: back(connectButtons()) } };
  }
  return {
    refusal: {
      text:
        brokerUnavailable === BrokerBalanceUnavailableReason.AmbiguousAccount
          ? TEXTS.statusAmbiguous
          : TEXTS.stakeBalanceMissing,
      keyboard: back([]),
    },
  };
}
