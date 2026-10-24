import type { BotTextSource } from './bot-text-template';
import { BOT_TEXT_CATALOG, type BotTextKey } from './bot-texts';

// The client bot's English texts (#508, docs/bot-texts.md → Languages): the same keys, the same
// placeholders and fragments as the Russian catalog, checked by the same validator
// (bot-texts-en.test.ts). Partial until #633: a key not here shows its Russian default to an
// English user, and UNTRANSLATED_BOT_TEXT_KEYS lists those keys, pinned by the test.
export const BOT_TEXT_SOURCES_EN: Partial<Record<BotTextKey, string>> = {
  // ---- start ---------------------------------------------------------------------------------
  welcome: `🚀 <b>Binarius — trading on Binodex right in Telegram</b>

Connect your Binodex account by email, and the bot will open the menu.

<b>The main thing — the auto session</b>
🤖 The bot runs a series of demo trades on a signal by itself, you watch the result. It is a demo: no money needed.

<b>How to connect</b>
1️⃣ Tap “{connectButton}” and send your email address.
2️⃣ Send the code from the email. If you have no account yet, Binodex will create one.
3️⃣ Done — the account is connected, the bot opens the menu.`,
  loginLink: `🌐 <b>Sign in through the Binodex website</b>
Open the sign-in with the button below, then come back to this chat.`,
  unavailable: `⚠️ The service is temporarily unavailable. Please try again later.`,
  blocked: `🔒 Access is restricted. If this is a mistake, contact support: /support`,
  confirmPrompt: `🔐 <b>A new Binodex account link was found</b>
If it was you who signed in — confirm it.`,
  linkedActive: `✅ <b>Binodex account connected!</b>`,
  accountTaken: `❌ This Binodex account is already connected to another Telegram user. If this is a mistake, contact support: /support`,
  oauthLoginFailed: `❌ Could not complete the Binodex sign-in. Connect your account by email: /start`,
  confirmNotFound: `❌ The link was not found. Start connecting again with /start.`,
  confirmAlreadyDone: `❌ This link is already confirmed or no longer waits for confirmation.`,
  emailPrompt: `📧 <b>Send your email address</b>
The one your Binodex account is registered to. If you have no account yet, Binodex will create one for this address.`,
  emailInvalid: `❌ This does not look like an email address. Send an address like name@example.com.`,
  emailRefused: `❌ Binodex did not accept this address. Check it and send it again.`,
  codeSent: `📩 <b>Code sent to {email}</b>
Send it here in one message.`,
  codeInvalid: `❌ The code did not work: it is wrong or expired. Send the code again or request a new one.`,
  tooManyCodeRequests: `⚠️ Too many code requests. Wait a few minutes and start again with /start.`,
  sendCodeBusy: `⚠️ Too many requests right now. Wait a little and send the address again.`,
  loginBusy: `⚠️ Too many requests right now. Wait a little and send the code again.`,
  resendRefused: `⚠️ A new code cannot be requested right now: too many requests. If the email with the code has already arrived — send the code from it.`,
  codeSentUnknown: `⚠️ Could not confirm that the code was sent to {email}.
If the email arrived — send the code from it. If not — tap “{resendButton}”.`,
  tooManyCodeAttempts: `⚠️ Too many attempts to enter the code. Wait a few minutes and start again with /start.`,
  codeRequestStale: `⚠️ This code request is no longer valid. If the account is not connected yet, start again with /start.`,

  // ---- card ----------------------------------------------------------------------------------
  cardGreeting: `🎉 <b>Hi, {firstName}!</b>`,
  cardGreetingNoName: `🎉 <b>Hi!</b>`,
  cardEmail: `📧 Binodex account: {email}`,
  cardBody: `✅ <b>Binodex account connected</b>

<b>What you can do now</b>
{features}
🆘 If something went wrong — contact support: /support`,
  featureLines: `🤖 Auto session for tokens: the bot runs a series of demo trades on a signal by itself, you watch the result.
🎮 Demo with no risk: no money needed, a single trade — if you like.
📊 Balance, tokens and trade history right in this chat.`,
  cardBonusGranted: `<blockquote>🎁 Auto-trading tokens credited: {bonusTokens}</blockquote>`,
  cardBonusNotPartner: `ℹ️ Starting tokens are credited only to accounts registered through Binarius.`,
  cardBonusAlready: `ℹ️ Starting tokens were already credited earlier.`,

  // ---- account -------------------------------------------------------------------------------
  accountNone: `❌ <b>Binodex account not connected</b>
Connect it by email — the button is below.`,
  accountConnected: `✅ <b>Binodex account connected</b>`,
  accountPending: `⏳ <b>The link is waiting for confirmation</b>
If it was you who signed in — confirm it with the button below.`,
  accountRevoked: `⚠️ <b>The Binodex connection was revoked</b>
Sign in again by email: tap the button below and send your address.`,
  accountLineActive: `✅ Connected: {email}`,
  accountLinePending: `⏳ Waiting for confirmation: {email}`,
  accountLineRevoked: `⚠️ Connection revoked: {email}`,
  accountUnknownAddress: 'address unknown',

  // ---- menu ----------------------------------------------------------------------------------
  statusHeader: `🎮 <b>Mode: {mode}</b>`,
  statusReal: `💵 Real balance: {amount}`,
  statusDemo: `🧪 Demo balance: {amount}`,
  statusTokens: `🪙 Tokens: {tokens}`,
  statusReserved: `(reserved: {reservedTokens})`,
  statusStale: `🕒 The Binodex balance was updated {age} ago.`,
  statusNoSnapshot: `⏳ The Binodex balance has not arrived yet — try /menu in a minute.`,
  statusAmbiguous: `⚠️ Several Binodex accounts are connected and no balance is chosen — contact support: /support`,
  statusHint: `💡 Auto session: the bot runs a series of demo trades by itself — no money needed.`,
  statusHintReal: `⚠️ Real mode: trades use real money, {stake} each.`,
  balanceUnavailable: 'no fresh data',
  ageSecondsUnit: 's',
  ageMinutesUnit: 'min',
  languageScreen: `🌐 <b>Bot language</b>
Choose the language the bot writes to you in.`,
  languageNeedsStart: `Tap /start, and I will show the language choice.`,
  languageRuButton: '🇷🇺 Русский',
  languageEnButton: '🇬🇧 English',
  modeHeader: `⚙️ <b>Trading mode</b>`,
  modeCurrent: `Now: <b>{mode}</b>`,
  modeRealBalance: `💵 Real balance: {realBalance}`,
  modeRealStake: `💼 Real trade amount: <b>{stake}</b>`,
  modeWarning: `⚠️ In real mode, trades and sessions use real money. In a session the stake grows after a loss. You can go back to demo right here or with /stop.`,
  modeStopsSession: `⏹ Changing the mode stops the active session.`,
  modePaused: `⏸ Trading is paused right now — trades will go once it reopens.`,
  modeConfirm: `Turn on real mode? Trades will use real money, <b>{stake}</b> each.`,
  modeStakeOutOfBounds: `⚠️ The amount {stake} does not fit the real account right now (available {realAvailable}, minimum {minStake}) — trades will be refused until you change it in /settings → “{settingsStakeRealButton}”.`,
  modeEnabled: `✅ Mode: REAL. Trades and sessions now use real money — the card in /menu will show REAL.`,
  modeDisabled: `✅ Mode: DEMO. The next trades will go to the demo account.`,
  modeSessionStopped: `⏹ The active session was stopped.`,
  modeBelowMinimum: `⚠️ The real account holds less than the broker's minimum stake — top up your Binodex account and try again.`,
  modeOutcomeUnknown: `⚠️ Could not find out whether the mode switched — open the mode screen again.`,
  modeStopReset: `🎮 Mode: DEMO — the next trades will go to demo.`,
  modeNotReset: `⚠️ The mode was not switched — open /menu.`,

  // ---- settings ------------------------------------------------------------------------------
  settings: `🔔 <b>Notifications</b>
This is how the bot sends reminders and tips — for example, when you have not started the demo yet.
Answers to your commands and the results of your trades always arrive.

Selected now: <b>{level}</b>

{levelAll} — every reminder.
{levelReduced} — at most one a day.
{levelOff} — no reminders.`,
  levelAll: '🔔 All',
  levelReduced: '🔕 Fewer',
  levelOff: '❌ Turn off',
  settingsStake: `💵 Demo trade amount: <b>{stake}</b>`,
  settingsStakeReal: `💼 Real trade amount: <b>{stake}</b>`,
  stakeMinimumLabel: "broker's minimum stake",

  // ---- support, help, invite -----------------------------------------------------------------
  support: `🆘 <b>Support</b>
If something went wrong or you have a question — write to us.
👇 Tap the button below to open the chat with support.`,
  helpAbout: `ℹ️ <b>What Binarius can do</b>
{features}`,
  helpConnect: `<b>How to connect a Binodex account</b>
If the account is not connected yet, tap /start, then “{connectButton}”.
📧 Send your email address and the code from the email. If you have no account yet, Binodex will create one.`,
  helpCommands: `<b>Commands</b>`,
  inviteScreen: `👥 <b>Invite a friend</b>
Your link:
{referralLink}
Invited: {count}
Connected an account: {connected}
Tokens received: {earnedTokens}`,
  inviteNeedsStart: `Tap /start, and I will send you an invite link.`,
  inviteShareText: 'I trade in demo with signals in Binarius — join with my link',

  // ---- demo ----------------------------------------------------------------------------------
  demoGroups: `🧭 <b>Choosing a pair</b>
Choose the asset type.`,
  demoPairsHeader: `🧭 <b>Choosing a pair</b> · {group}
Choose an asset. The number on the button is the payout on a correct forecast, not a probability.`,
  demoPage: `Page {page} of {pageCount}`,
  demoGroupClosed: `🔒 <b>{group}: everything is closed by schedule right now</b>
Choose another asset type.`,
  demoAsset: `🎯 Asset: {symbol}`,
  demoPayout: `💰 Payout: {payout}% — the size of the win on a correct forecast, not a probability. Break-even: {breakEven}% of correct forecasts.`,
  demoDurationLine: `⏱ Duration: {label}`,
  demoNext: `Next — the candle analysis: the bot will show the signal and what you can do with it.`,
  demoSignalsHeader: `📡 <b>Signals now</b> · {label}
Choose a pair. A signal lasts one candle ({label}), so the bot checks it again before the trade.`,
  signalsWaiting: `🔎 <b>Analysing the signals</b> · {label}
I check the pairs on every candle. As soon as a signal appears, the list opens here.`,
  signalsExpired: `🚀 <b>Start trading</b>
A signal lasts one candle ({label}), so this list is out of date. Open the fresh signals or pick a pair by hand.`,
  pairWaiting: `⏳ <b>Checking the signal on {symbol}</b>
I look on every candle ({label}). As soon as the signal appears, we continue here.`,
  pairWaitingAlternatives: `Other pairs have a signal already — pick one below instead of waiting 👇`,
  launchHeader: `🎯 <b>{subject}</b>`,
  launchStake: `💵 Stake: {stake}`,
  launchStakeMinimum: `💵 Stake: the broker's minimum`,
  launchCycle: `🤖 The bot will run {cycles} in a row and check the signal before each trade. It is a demo: no money needed.`,
  launchCycleReal: `🤖 The bot will run {cycles} in a row and check the signal before each trade. Real mode: trades use real money.`,
  demoCatalogUnavailable: `⚠️ The asset catalog is unavailable right now. Try again in a minute.`,
  demoNoShortPairs: `There are no assets for short trades right now.`,
  demoCatalogStale: `⏳ The asset catalog is updating. Try again in a minute.`,
  demoPairMissing: `❌ This asset is no longer available. Choose another one.`,
  demoPairClosed: `🔒 {symbol} is closed by schedule right now. Choose another asset.`,
  demoDurationUnsupported: `❌ {symbol} does not accept trades of {label}. Choose another asset.`,
  demoGroupCurrency: '💱 Forex',
  demoGroupCommodity: '🛢 Commodity',
  demoGroupStock: '📈 Stocks',
  demoGroupCryptocurrency: '💠 Crypto',
  demoGroupIndex: '📊 Indices',
  demoGroupOther: '📁 Other',
  demoDuration5: '⏱ 5 s',
  demoDurationSeconds: '⏱ {durationSec} s',
  cycleStakeChoose: `Choose the trade amount 👇`,
  stakeRiskButton: '{amount} · risk',

  // ---- analysis ------------------------------------------------------------------------------
  analyzing: `⏳ Analysing {subject}…`,
  analysisHeader: `📊 <b>Analysis: {subject}</b>`,
  analysisCardUp: `🟢 <b>Strong signal to rise</b>`,
  analysisCardDown: `🔴 <b>Strong signal to fall</b>`,
  analysisChooseAmount: `Choose the trade amount 👇`,
  analysisWaiting: `⏳ <b>Checking the signal…</b> As soon as it appears, the signal card opens here.`,
  analysisTrend: `📐 EMA trend: {value}`,
  analysisMomentum: `⚡ RSI momentum: {value}`,
  analysisVolatility: `🌊 ATR volatility: {value}`,
  analysisCandles: `🕯 Closed candles: {count}`,
  analysisLastPrice: `💲 Last price: {price}`,
  analysisDisclaimer: `⚠️ A signal is not a forecast of the result and not a guarantee. It is a demo: no money needed.`,
  analysisDisclaimerReal: `⚠️ A signal is not a forecast of the result and not a guarantee. Real mode: the trade uses real money.`,
  analysisRateLimited: `⚠️ The broker limited requests. Try again in {seconds} s.`,
  analysisUnavailable: `⚠️ Could not get the candles from the broker. Try again.`,
  actionUp: '⬆️ Up',
  actionDown: '⬇️ Down',
  stakeButton: '🚀 Open a trade: {action}',
  sessionStartButton: '🚀 Session of {cycles}',
  trendUp: 'up',
  trendDown: 'down',
  trendFlat: 'not determined',
  momentumUp: 'up',
  momentumDown: 'down',
  momentumNeutral: 'neutral',
  volatilityNormal: 'normal',
  volatilityLow: 'too low',
  volatilityHigh: 'too high',
  volatilityTickFloor: 'below the threshold in quote steps',
  analysisAtrTicks: '{count} quote steps',
  emaAbove: 'above',
  emaBelow: 'below',
  emaEqual: 'equal to',
  cardRowPair: 'Pair',
  cardRowRsi: 'RSI',
  cardRowMacd: 'MACD',
  cardRowMa50: 'MA50',
  cardRowMa200: 'MA200',
  cardRowTrend: 'EMA trend',
  cardRowVolatility: 'Volatility',
  cardRowDirection: 'Direction',
  rsiOverbought: 'overbought',
  rsiOversold: 'oversold',
  rsiNeutral: 'neutral',
  macdCrossUp: 'crossed up',
  macdCrossDown: 'crossed down',
  macdAbove: 'above the signal',
  macdBelow: 'below the signal',
  macdEqual: 'on the signal',
  maPriceAbove: 'price above',
  maPriceBelow: 'price below',
  maPriceEqual: 'price at MA',
  cardDirectionUp: '⬆️ UP 🟢',
  cardDirectionDown: '⬇️ DOWN 🔴',
  indicatorShortData: 'not enough data ({count} of {required})',

  // ---- trade ---------------------------------------------------------------------------------
  intentHeader: `🎮 <b>Demo trade</b>`,
  intentHeaderReal: `💼 <b>Real trade</b>`,
  intentTrade: `📈 {line}`,
  intentAssetFallback: 'asset #{assetId}',
  intentStake: 'stake {amount}',
  intentQueued: `⏳ The order is created and waits to be sent to the broker…`,
  intentSubmitting: `📤 Sending the order to the broker…`,
  intentAccepted: `✅ The trade is open at the broker.`,
  intentSettled: `🏁 The trade is closed.`,
  intentUnknown: `🔎 The broker is confirming the trade's result. The token stays reserved for now.`,
  intentManualReview: `🛠 The trade is under manual review — contact support: /support`,
  intentRejectedNotConfigured: `⚠️ The trade was not sent: trade execution is not connected yet. Token returned.`,
  intentRejectedExpired: `⚠️ The order was not sent in time. Token returned.`,
  intentRejectedByBroker: `❌ The broker rejected the trade. Token returned.`,
  intentRejectedPublishFailed: `⚠️ The order did not reach the executor. Token returned.`,
  intentRejectedNotFound: `❌ The broker did not open the trade. Token returned.`,
  intentRejectedManual: `❌ The trade was rejected at manual review. Token returned.`,
  intentRejectedPaused: `⏸ Trading is temporarily paused, please try again later. Token returned.`,
  intentRejectedDemoOnly: `⚠️ The trade was rejected: real trades are turned off on this server. Token returned.`,
  intentRejected: `❌ The trade was not opened. Token returned.`,
  intentDeadline: `⏳ The trade is still being processed — tap “{refreshIntentButton}” a bit later.`,
  intentSessionOffer: `🤖 Next, the bot can trade by itself: a session of {cycles} on this pair, checking the signal before each trade.`,
  intentStatusUnavailable: `⚠️ The trade status is unavailable.`,
  stakeBalanceMissing: `⏳ The Binodex balance has not arrived yet — try again in a minute.`,
  stakeActiveIntent: `⏳ The previous trade is not finished yet. Wait for its result.`,
  tradingPaused: `⏸ Trading is temporarily paused, please try again later.`,
  tradingDemoOnly: `⚠️ Real trades are turned off on this server — only demo mode is available.`,
  stakeButtonUsed: `⚠️ This button was already used. Open the analysis again.`,
  stakeInsufficientTokens: `🪙 Not enough tokens for a trade.`,
  stakeAccountNotConfirmed: `⏳ The Binodex link is waiting for confirmation — open /account.`,
  stakeAccountHalted: `⛔ Trading on the account is stopped — contact support: /support`,
  stakeOutcomeUnknown: `⚠️ Could not find out whether the order was accepted. Tap the trade button again — it will not open a second trade.`,
  stakeAmountChanged: `⚠️ The mode or the trade amount changed — open the analysis again.`,
  stakeRealModeOff: `⚠️ Real mode is off — turn it on in the menu and open the analysis again.`,
  stakeBelowMinimum: `⚠️ The broker's minimum stake is {minStake} right now. Choose an amount no lower than that.`,
  stakeBelowBrokerMinimum: `⚠️ The saved amount is below the broker's minimum stake. Choose the amount again.`,
  stakeAboveAvailable: `⚠️ The demo account does not have enough funds for this amount. Choose a smaller amount.`,
  stakeAboveAvailableReal: `⚠️ The real account does not have enough funds for this amount. Choose a smaller amount.`,
  stakeAboveAvailableAmount: `⚠️ The demo account has {demoAvailable} available. Choose a smaller amount.`,
  stakeAboveAvailableAmountReal: `⚠️ The real account has {realAvailable} available. Choose a smaller amount.`,
  stakePrecision: `⚠️ The amount has too many digits after the decimal point. Choose the amount again.`,
  stakePrecisionDigits: `❌ At most {digits} digits after the decimal point.`,
  stakePrecisionDigitsReal: `❌ At most {digits} digits after the decimal point.`,
  stakePickerHeader: `💵 <b>Demo trade amount</b>`,
  stakePickerHeaderReal: `💼 <b>Real trade amount</b>`,
  stakePickerCurrent: `Now: {amount}`,
  stakePickerMinimum: `Broker's minimum: {minStake}`,
  stakePickerAvailable: `Available: {demoAvailable}`,
  stakePickerAvailableReal: `Real balance: {realAvailable}`,
  stakePickerNoPresets: `The demo account does not have enough funds even for the minimum stake.`,
  stakePickerNoPresetsReal: `The real account does not have enough funds even for the minimum stake.`,
  stakeInputPrompt: `✏️ Send the demo trade amount as a number, for example 5 or 2.50.`,
  stakeInputPromptReal: `✏️ Send the real trade amount as a number, for example 5 or 2.50.`,
  stakeInputInvalid: `❌ Send the amount as a number, for example 5 or 2.50.`,
  stakeSaved: `✅ Demo stake: {stake}`,
  stakeSavedReal: `✅ Real stake: {stake}`,
  stakeSavedLine: `✅ Demo stake saved: {stake}`,
  stakeSavedLineReal: `✅ Real stake saved: {stake}`,
  stakeSaveUnknown: `⚠️ Could not save the amount — try again.`,

  // ---- an H1 session from the bot (#745): translated ahead of the Session group ---------------
  sessionAccountChanged: `⚙️ The account settings changed — open the analysis again.`,
  // the session message's wait for a signal (#796)
  sessionSignalWaiting: `📡 Waiting for a signal…`,
  // the cycle words of the demo path's «Session of 5 cycles» (#632); the plural rule is #633's
  sessionCycleOne: 'cycle',
  sessionCycleFew: 'cycles',
  sessionCycleMany: 'cycles',

  // ---- the switch to real after a deposit (#686): translated ahead of the Mailing group --------
  realModeByDeposit: `💳 <b>Deposit received — real mode is on</b>

Mode: REAL. Trades and sessions now use real money.
💵 Trade amount: {stake}
Back to demo: /settings → “{settingsModeButton}”.`,

  // ---- buttons -------------------------------------------------------------------------------
  confirmButton: '✅ Confirm: {email}',
  confirmButtonNoEmail: '✅ Confirm the link',
  connectButton: '🔗 Connect a Binodex account',
  oauthButton: '🌐 Sign in through the Binodex website',
  loginButton: '🌐 Sign in to Binodex',
  resendButton: '🔄 New code',
  changeEmailButton: '✏️ Change email',
  demoButton: '🎮 Demo trading',
  demoSignalsRefreshButton: '🔄 Refresh',
  demoManualButton: '🧭 Manually',
  launchCycleButton: '🚀 Start the cycle',
  stakeChangeButton: '💵 Stake',
  backToListButton: '↩️ To the list',
  stakeBackLaunchButton: '↩️ Launch',
  sessionAgainButton: '🔁 One more session',
  demoAnalysisButton: '📊 Analysis',
  demoRetryButton: '🔄 Retry',
  menuButton: '🏠 Menu',
  newAnalysisButton: '📊 Analysis',
  toSignalsButton: '📡 Signals',
  showSignalsButton: '📡 Show signals',
  otherPairButton: '🔀 Choose another pair',
  demoBackGroupsButton: '↩️ Types',
  demoBackPairsButton: '↩️ Assets',
  demoBackPairButton: '↩️ Pair',
  demoPrevButton: '◀️',
  demoNextButton: '▶️',
  repeatAnalysisButton: '🔄 Again',
  analysisMoreButton: '➕ More',
  refreshIntentButton: '🔄 Refresh',
  supportButton: '💬 Support',
  sessionStopButton: '⏹ Stop the session',
  stakeMenuButton: '💵 Amount',
  stakeCustomButton: '✏️ Enter',
  stakeResetButton: '🔁 Minimum',
  stakeBackAnalysisButton: '↩️ Analysis',
  stakeBackSettingsButton: '↩️ Settings',
  stakeBackButton: '↩️ Back',
  settingsStakeDemoButton: '💵 Demo',
  settingsStakeRealButton: '💼 Real',
  settingsModeButton: '⚙️ Trading mode',
  tradeButton: '🚀 Trade',
  modeBackDemoButton: '🎮 To demo',
  modeEnableButton: '💼 Turn on real mode',
  modeConfirmButton: '✅ I confirm',
  modeCancelButton: '↩️ Cancel',
  modeScreenButton: '⚙️ Mode',
  inviteButton: '👥 Invite',
  inviteShareButton: '📤 Share',
  buyButton: '⭐ Buy',
  depositButton: '💳 Top up',
  sessionShareButton: '📤 Share',

  // ---- commands, profile ---------------------------------------------------------------------
  startCommand: 'Start',
  menuCommand: 'Main menu',
  stopCommand: 'Stop the session',
  accountCommand: 'Binodex account',
  settingsCommand: 'Notification settings',
  languageCommand: 'Bot language',
  inviteCommand: 'Invite a friend',
  buyCommand: 'Buy tokens',
  helpCommand: 'Help',
  supportCommand: 'Support',
  paysupportCommand: 'Stars payment questions and refunds',
  profileDescription: `🚀 Binarius — trading on Binodex right in Telegram.

🤖 Auto session: the bot runs a series of demo trades on a signal by itself, you watch the result.
🎮 Demo with no risk: no money needed, a single trade — if you like.
📊 Balance, tokens and trade history — right in this chat.
📧 Connecting takes a minute: send your email address and the code from the email.

👉 Tap “Start” — and let's begin.`,
  profileShortDescription:
    'Auto sessions on Binodex right in Telegram: the bot trades demo on a signal by itself, you watch the result',
};

// A static source: a key without an English text shows the catalog's Russian default, never an
// override, which apply to Russian only until #634. So every English message is bounded by the
// test on the defaults, with no override to widen it at run time.
export const enBotTextSource: BotTextSource<BotTextKey> = {
  sourceOf: (key) => BOT_TEXT_SOURCES_EN[key] ?? BOT_TEXT_CATALOG[key].source,
};

// The keys of the groups #633 translates that are translated already: the switch to real after a
// deposit (#686) and the H1 session from the bot (#745, #796) were written in both languages from
// the start, and the cycle words are printed by the demo path (#632).
export const TRANSLATED_BEFORE_633 = [
  'realModeByDeposit',
  'sessionAccountChanged',
  'sessionSignalWaiting',
  'sessionCycleOne',
  'sessionCycleFew',
  'sessionCycleMany',
] as const satisfies readonly BotTextKey[];

export const UNTRANSLATED_BOT_TEXT_KEYS: readonly BotTextKey[] = (
  Object.keys(BOT_TEXT_CATALOG) as BotTextKey[]
).filter((key) => BOT_TEXT_SOURCES_EN[key] === undefined);
