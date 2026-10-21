import { describe, expect, it } from 'vitest';
import { ButtonRole, decimalStringSchema, keyboardOf } from '@binarius/shared';
import { stakeGroups } from './stake-rows';

const d = (value: string) => decimalStringSchema.parse(value);
const layout = (amounts: string[], current: string | null) => {
  const keyboard = keyboardOf(...stakeGroups(amounts.map(d), current, (amount) => `s:${amount}`));
  return keyboard.inline_keyboard.map((row, r) =>
    row.map((button, b) => ({
      text: button.text,
      role: keyboard.rows[r]?.[b]?.role,
      style: button.style ?? null,
    })),
  );
};

// #475 (owner's decision 2, Plan Update): from STAKE_RISK_THRESHOLD ($10) inclusive red with
// «· риск», below it green; the amount screen and the picker draw their presets through this
describe('stakeGroups (#475)', () => {
  it('SR1 the boundary: $9.99 green without the mark, $10.00 red with it', () => {
    expect(layout(['9.99', '10'], null)).toEqual([
      [{ text: '$9.99', role: ButtonRole.Stake, style: 'success' }],
      [{ text: '$10.00 · риск', role: ButtonRole.StakeRisk, style: 'danger' }],
    ]);
  });

  it('SR2 the calm three a row, the risky two a row below them, ✅ on the one in effect', () => {
    expect(
      layout(['1', '2', '5', '10', '20', '50'], '20').map((row) => row.map((key) => key.text)),
    ).toEqual([
      ['$1.00', '$2.00', '$5.00'],
      ['$10.00 · риск', '$20.00 ✅ · риск'],
      ['$50.00 · риск'],
    ]);
  });

  it('SR3 the data of each button is the caller’s', () => {
    const [calm, risky] = stakeGroups([d('1'), d('10')], null, (amount) => `x:${amount}`);
    expect(calm?.buttons.map((key) => 'callback_data' in key && key.callback_data)).toEqual([
      'x:1',
    ]);
    expect(risky?.buttons.map((key) => 'callback_data' in key && key.callback_data)).toEqual([
      'x:10',
    ]);
  });
});
