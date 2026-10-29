// The bots' inline keyboards by the role of each button (#475, docs/bot-navigation.md → Roles,
// colours and rows): the role alone decides the colour (the Bot API's `style`) and whether the
// button takes a row of its own. The client bot, the backend's pushes and the staff bot build every
// keyboard here; their send seams take only a BotKeyboard, which nothing else constructs.
// grammY is not imported: the wire is described by the types below, which grammY's
// InlineKeyboardMarkup accepts (exactOptionalPropertyTypes included). Old clients ignore `style`.

export const ButtonRole = {
  // the step forward of the funnel: an entry, a connection, a confirmation, a start, a payment
  Forward: 'forward',
  // the trade button of a ⬇️ signal: a step forward, red as «⬇️ Вниз» is
  ForwardDown: 'forward_down',
  // a step forward that shares a row with a step aside: «🔁 Ещё сессия» next to «📡 Сигналы» (#858)
  ForwardShared: 'forward_shared',
  // a risk or the irreversible: a stop, «Это не я»
  Danger: 'danger',
  // a stake preset below / at or above STAKE_RISK_THRESHOLD (stake.ts)
  Stake: 'stake',
  StakeRisk: 'stake_risk',
  // a pair of a signal list by the signal's direction
  Up: 'up',
  Down: 'down',
  // the secondary actions: refresh, repeat, «➕ Ещё», the amount, a new code
  Secondary: 'secondary',
  // navigation and a choice among options: menu, back, a list, support
  Nav: 'nav',
} as const;
export type ButtonRole = (typeof ButtonRole)[keyof typeof ButtonRole];

export type ButtonStyle = 'success' | 'danger' | 'primary';

export const BUTTON_ROLE_STYLES: Readonly<Record<ButtonRole, ButtonStyle | null>> = {
  [ButtonRole.Forward]: 'success',
  [ButtonRole.ForwardDown]: 'danger',
  [ButtonRole.ForwardShared]: 'success',
  [ButtonRole.Danger]: 'danger',
  [ButtonRole.Stake]: 'success',
  [ButtonRole.StakeRisk]: 'danger',
  [ButtonRole.Up]: 'success',
  [ButtonRole.Down]: 'danger',
  [ButtonRole.Secondary]: 'primary',
  [ButtonRole.Nav]: null,
};

// the roles that take a row of their own; every other button shares a row with 1-2 more
export const FULL_WIDTH_ROLES: ReadonlySet<ButtonRole> = new Set([
  ButtonRole.Forward,
  ButtonRole.ForwardDown,
]);

export interface SwitchInlineChosenChat {
  query?: string;
  allow_user_chats?: boolean;
  allow_bot_chats?: boolean;
  allow_group_chats?: boolean;
  allow_channel_chats?: boolean;
}

type ButtonAction =
  | { callback_data: string }
  | { url: string }
  | { web_app: { url: string } }
  | { pay: true }
  | { switch_inline_query_chosen_chat: SwitchInlineChosenChat };

export type WireButton = { text: string; style?: ButtonStyle } & ButtonAction;
export type BotButton = { readonly role: ButtonRole; readonly text: string } & ButtonAction;

export const callbackButton = (role: ButtonRole, text: string, data: string): BotButton => ({
  role,
  text,
  callback_data: data,
});
export const urlButton = (role: ButtonRole, text: string, url: string): BotButton => ({
  role,
  text,
  url,
});
export const webAppButton = (role: ButtonRole, text: string, url: string): BotButton => ({
  role,
  text,
  web_app: { url },
});
// the Bot API wants an invoice's pay button first in the first row: forward takes a row, and the
// invoice seam stacks it above the rest
export const payButton = (text: string): BotButton => ({
  role: ButtonRole.Forward,
  text,
  pay: true,
});
export const switchInlineButton = (
  role: ButtonRole,
  text: string,
  chosenChat: SwitchInlineChosenChat,
): BotButton => ({ role, text, switch_inline_query_chosen_chat: chosenChat });

// A group the screen's author gives keyboardOf: actions (an array), laid out by the rule, or a
// list of like items (pairs, signals, types, presets) in rows of `perRow`, the remainder as is.
export interface ButtonList {
  readonly buttons: readonly BotButton[];
  readonly perRow: 2 | 3;
}
export type ButtonGroup = readonly BotButton[] | ButtonList;

export interface LaidButton {
  readonly role: ButtonRole;
  readonly text: string;
  readonly list: boolean;
}

/**
 * A keyboard laid out by roles. The class is not exported and carries a private member, so the
 * type is nominal (as TelegramHtml's): a grammY InlineKeyboard or a bare `{ inline_keyboard }`
 * does not satisfy it, and only keyboardOf and stackKeyboards construct one. `inline_keyboard` is
 * the wire and the only own enumerable property, so JSON carries nothing else; `rows` is the
 * roles the test gate reads, on the prototype.
 */
class BotKeyboardValue {
  declare private readonly brand: void;
  readonly inline_keyboard: WireButton[][];
  readonly #rows: readonly (readonly LaidButton[])[];

  constructor(inline_keyboard: WireButton[][], rows: readonly (readonly LaidButton[])[]) {
    this.inline_keyboard = inline_keyboard;
    this.#rows = rows;
  }

  get rows(): readonly (readonly LaidButton[])[] {
    return this.#rows;
  }
}
export type { BotKeyboardValue as BotKeyboard };

export const isBotKeyboard = (value: unknown): value is BotKeyboardValue =>
  value instanceof BotKeyboardValue;

function wireOf(button: BotButton): WireButton {
  const { role, ...wire } = button;
  const style = BUTTON_ROLE_STYLES[role];
  return style === null ? wire : { ...wire, style };
}

const isList = (group: ButtonGroup): group is ButtonList => !Array.isArray(group);

function chunk<T>(items: readonly T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
}

// actions in rows of two; an odd run of three or more ends in a row of three, so no action is
// left alone in a row unless it is alone in its run
function actionRows<T>(run: readonly T[]): T[][] {
  const rows = chunk(run, 2);
  const last = rows.at(-1);
  if (rows.length > 1 && last?.length === 1) {
    rows.pop();
    rows.at(-1)?.push(...last);
  }
  return rows;
}

export function keyboardOf(...groups: readonly ButtonGroup[]): BotKeyboardValue {
  const rows: { button: BotButton; list: boolean }[][] = [];
  for (const group of groups) {
    if (isList(group)) {
      for (const row of chunk(group.buttons, group.perRow)) {
        rows.push(row.map((button) => ({ button, list: true })));
      }
      continue;
    }
    let run: BotButton[] = [];
    const flush = () => {
      for (const row of actionRows(run)) rows.push(row.map((button) => ({ button, list: false })));
      run = [];
    };
    for (const button of group) {
      if (FULL_WIDTH_ROLES.has(button.role)) {
        flush();
        rows.push([{ button, list: false }]);
      } else {
        run.push(button);
      }
    }
    flush();
  }
  return new BotKeyboardValue(
    rows.map((row) => row.map(({ button }) => wireOf(button))),
    rows.map((row) =>
      row.map(({ button, list }) => ({ role: button.role, text: button.text, list })),
    ),
  );
}

// `above`'s rows, then `below`'s: an invoice's pay row over its next step, «📤 Поделиться» over the
// summary card's keyboard
export const stackKeyboards = (above: BotKeyboardValue, below: BotKeyboardValue) =>
  new BotKeyboardValue(
    [...above.inline_keyboard, ...below.inline_keyboard],
    [...above.rows, ...below.rows],
  );

// A label's width as a phone shows it, for the row limits: code points without emoji, flags and
// their joiners, spaces collapsed.
const NOT_COUNTED = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\uFE0F|\u200D|\u20E3/gu;
export const buttonLabelWidth = (text: string): number =>
  [...text.replace(NOT_COUNTED, '').replace(/\s+/g, ' ').trim()].length;

// the widest label a row of two or of three shows uncut (owner's decision 4, #475)
export const BUTTON_LABEL_WIDTHS = { 2: 14, 3: 9 } as const;
