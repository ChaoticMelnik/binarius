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

  // ---- the wait for a signal (#664): translated ahead of the Demo and Analysis groups ----------
  signalsWaiting: `🔎 <b>Analysing the signals</b> · {label}
I check the pairs on every candle. As soon as a signal appears, the list opens here.`,
  signalsExpired: `🚀 <b>Start trading</b>
A signal lasts one candle ({label}), so this list is out of date. Open the fresh signals or pick a pair by hand.`,
  pairWaiting: `⏳ <b>Checking the signal on {symbol}</b>
I look on every candle ({label}). As soon as the signal appears, we continue here.`,
  pairWaitingAlternatives: `Other pairs have a signal already — pick one below instead of waiting 👇`,
  analysisWaiting: `⏳ <b>Checking the signal…</b> As soon as it appears, the signal card opens here.`,

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
  tradeButton: '🚀 Trade',
  modeButton: '💼 Real mode',
  modeBackDemoButton: '🎮 To demo',
  modeEnableButton: '💼 Turn on real mode',
  modeConfirmButton: '✅ I confirm',
  modeCancelButton: '↩️ Cancel',
  modeScreenButton: '⚙️ Mode',
  inviteButton: '👥 Invite friends',
  inviteShareButton: '📤 Share',
  buyButton: '⭐ Buy',
  depositButton: '💳 Top up',
  sessionShareButton: '📤 Share',
  languageButton: '🌐 Язык/Language',

  // ---- commands, profile ---------------------------------------------------------------------
  startCommand: 'Start',
  menuCommand: 'Main menu',
  stopCommand: 'Stop the session',
  accountCommand: 'Binodex account',
  settingsCommand: 'Notification settings',
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

// The keys of the groups #632 and #633 translate that are translated already: the wait for a
// signal (#664) was written in both languages from the start.
export const TRANSLATED_BEFORE_633 = [
  'signalsWaiting',
  'signalsExpired',
  'pairWaiting',
  'pairWaitingAlternatives',
  'analysisWaiting',
] as const satisfies readonly BotTextKey[];

export const UNTRANSLATED_BOT_TEXT_KEYS: readonly BotTextKey[] = (
  Object.keys(BOT_TEXT_CATALOG) as BotTextKey[]
).filter((key) => BOT_TEXT_SOURCES_EN[key] === undefined);
