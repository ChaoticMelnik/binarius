import { InlineKeyboard } from 'grammy';
import {
  BrokerBalanceUnavailableReason,
  UserStatus,
  type BrokerBalanceView,
  type TelegramHtml,
  type TradingAccessResponse,
} from '@binarius/shared';
import { supportKeyboard } from './keyboards';
import { TEXTS } from './texts';

// What an access read says before any amount can be offered, for the stake picker (#297, #326)
// and the amount screen of a demo cycle (#476): the refusals the stake press would give
// (demo-trade.ts amountOf), the same in both modes, each followed by the caller's way back; or the
// broker snapshot the amounts are drawn from.
export type StakeAccess =
  { refusal: { text: TelegramHtml; keyboard: InlineKeyboard } } | { broker: BrokerBalanceView };

export function stakeAccess(
  { status, broker, brokerUnavailable }: TradingAccessResponse,
  back: (keyboard: InlineKeyboard) => InlineKeyboard,
  connectKeyboard: () => InlineKeyboard,
): StakeAccess {
  if (status === UserStatus.Blocked) {
    // the support link, as for every blocked user (#350), then the way back
    return { refusal: { text: TEXTS.blocked, keyboard: back(supportKeyboard().row()) } };
  }
  if (broker !== null) return { broker };
  if (brokerUnavailable === BrokerBalanceUnavailableReason.NoAccount) {
    return { refusal: { text: TEXTS.accountNone, keyboard: back(connectKeyboard().row()) } };
  }
  return {
    refusal: {
      text:
        brokerUnavailable === BrokerBalanceUnavailableReason.AmbiguousAccount
          ? TEXTS.statusAmbiguous
          : TEXTS.stakeBalanceMissing,
      keyboard: back(new InlineKeyboard()),
    },
  };
}
