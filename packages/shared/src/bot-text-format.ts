// How the bot texts print the backend's numbers (#24), for the bot and the variables of
// bot-text-vars.ts (#358). Text in, text out: an amount is a decimal string and a count an
// integer string, and going through Number would lose digits a numeric(20,8) or a bigint holds
// (Rule 2). The fraction is cut to two digits, not rounded, so the card never shows more than the
// broker reported.

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

// A stake (#297): every fraction digit it has, at least two, so a stake of 0.005 is not shown
// as $0.00. '5' → '$5.00', '0.005' → '$0.005', '1000.5' → '$1 000.50'
export function formatStake(amount: string): string {
  const [whole = '0', fraction = ''] = amount.split('.');
  const digits = fraction.replace(/0+$/, '').padEnd(2, '0');
  return `$${groupDigits(whole)}.${digits}`;
}

export const formatCount = (count: string): string => groupDigits(count);

// whole seconds under a minute, whole minutes (floor) from one
export const formatAge = (seconds: number): string =>
  seconds < 60 ? `${seconds} с` : `${Math.floor(seconds / 60)} мин`;
