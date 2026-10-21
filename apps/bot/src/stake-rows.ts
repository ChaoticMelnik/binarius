import {
  ButtonRole,
  callbackButton,
  stakeIsRisky,
  type ButtonList,
  type DecimalString,
} from '@binarius/shared';
import { cycleStakeLabel } from './texts';

// The stake presets of the amount screen (#476), the analysis card (#482) and the picker (#297,
// #326): ✅ on the amount in effect; below STAKE_RISK_THRESHOLD green three a row, from it red
// with «· риск» two a row below them (#475, owner's decision 2). `current` null marks none.
const CALM_PER_ROW = 3;
const RISKY_PER_ROW = 2;

export function stakeGroups(
  amounts: readonly DecimalString[],
  current: string | null,
  data: (amount: DecimalString) => string,
): ButtonList[] {
  const button = (amount: DecimalString) =>
    callbackButton(
      stakeIsRisky(amount) ? ButtonRole.StakeRisk : ButtonRole.Stake,
      cycleStakeLabel(amount, amount === current),
      data(amount),
    );
  return [
    {
      buttons: amounts.filter((amount) => !stakeIsRisky(amount)).map(button),
      perRow: CALM_PER_ROW,
    },
    { buttons: amounts.filter(stakeIsRisky).map(button), perRow: RISKY_PER_ROW },
  ];
}
