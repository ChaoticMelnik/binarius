import { MAX_PAIR_DIGITS } from './broker';

// How the bot texts print the backend's numbers (#24), for the bot and the variables of
// bot-text-vars.ts (#358). Text in, text out: an amount is a decimal string and a count an
// integer string, and going through Number would lose digits a numeric(20,8) or a bigint holds
// (Rule 2). A balance's fraction is cut to two digits, not rounded, so the card never shows more
// than the broker reported; a signed result keeps every digit (formatSignedUsd).

const GROUP_SEPARATOR = ' ';

const groupDigits = (digits: string): string => {
  const trimmed = digits.replace(/^0+(?=\d)/, '');
  return trimmed.replace(/\B(?=(\d{3})+(?!\d))/g, GROUP_SEPARATOR);
};

// '10000.00000000' → '$10 000.00', '-1.5' → '-$1.50'; a zero keeps no sign
export function formatUsd(amount: string): string {
  const negative = amount.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? amount.slice(1) : amount).split('.');
  const cents = fraction.slice(0, 2).padEnd(2, '0');
  const zero = /^0*$/.test(whole) && cents === '00';
  return `${negative && !zero ? '-' : ''}$${groupDigits(whole)}.${cents}`;
}

// A session's result (#337) and a trade's profit on the summary card: every fraction digit it has,
// at least two, so a loss of 1.7515 is not shown as the smaller -$1.75 (#450: the live broker's
// profit is S × p / 100 unrounded). '1.5' → '+$1.50', '-1.7515' → '-$1.7515'; a zero keeps no
// sign, as in formatUsd
export function formatSignedUsd(amount: string): string {
  const negative = amount.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? amount.slice(1) : amount).split('.');
  const digits = fraction.replace(/0+$/, '').padEnd(2, '0');
  const zero = /^0*$/.test(whole) && /^0*$/.test(digits);
  const sign = zero ? '' : negative ? '-' : '+';
  return `${sign}$${groupDigits(whole)}.${digits}`;
}

// A stake (#297): every fraction digit it has, at least two, so a stake of 0.005 is not shown
// as $0.00. '5' → '$5.00', '0.005' → '$0.005', '1000.5' → '$1 000.50'
export function formatStake(amount: string): string {
  const [whole = '0', fraction = ''] = amount.split('.');
  const digits = fraction.replace(/0+$/, '').padEnd(2, '0');
  return `$${groupDigits(whole)}.${digits}`;
}

export const formatCount = (count: string): string => groupDigits(count);

// A trade's figure after «→» in its message (#464): '9.6' → '+$9.60', '-5' → '-$5.00', every
// fraction digit as formatStake. The value is a stake or a payout, never zero (the session's
// messages print a tie as its returned stake).
export function formatSignedStake(amount: string): string {
  return amount.startsWith('-') ? `-${formatStake(amount.slice(1))}` : `+${formatStake(amount)}`;
}

// A price is not money: a broker's double, printed with the pair's digits. A value outside the sane
// range is printed at the nearest bound rather than failing the message.
export const formatPrice = (value: number, digits: number): string =>
  value.toFixed(Math.min(Math.max(Math.trunc(digits), 0), MAX_PAIR_DIGITS));

// A Stars payment's time (#118, /paysupport): Moscow time, which has had no DST since 2014, so a
// fixed +3 h. 1790000000 → '21.09.2026 17:13'
const MOSCOW_OFFSET_S = 3 * 3600;
const two = (value: number) => String(value).padStart(2, '0');
export function formatPaymentDate(unixSeconds: number): string {
  const at = new Date((unixSeconds + MOSCOW_OFFSET_S) * 1000);
  return `${two(at.getUTCDate())}.${two(at.getUTCMonth() + 1)}.${String(at.getUTCFullYear())} ${two(at.getUTCHours())}:${two(at.getUTCMinutes())}`;
}

// whole seconds under a minute, whole minutes (floor) from one
export const formatAge = (seconds: number): string =>
  seconds < 60 ? `${seconds} с` : `${Math.floor(seconds / 60)} мин`;
