import { Composer, GrammyError, HttpError, InlineKeyboard, type Context } from 'grammy';
import {
  editRefusal,
  errorLogFields,
  parseStakeInput,
  StakeErrorCode,
  TradeMode,
  type PairsCatalogResponse,
  type TelegramHtml,
  telegramErrorFields,
} from '@binarius/shared';
import {
  BackendError,
  BackendErrorCode,
  backendErrorFields,
  type BackendClient,
  type SetStakeResult,
} from './backend-client';
import {
  appendCycleBack,
  CYCLE_CUSTOM_PATTERN,
  CYCLE_STAKE_PATTERN,
  cycleCustomDataOf,
  cycleStakeDataOf,
  demoLaunchCallbackData,
  type CycleStakeStep,
} from './demo';
import type { LoginDialog } from './login-dialog';
import { answerCallback } from './answer-callback';
import { settle, type Settled } from './settled';
import type { Logger } from './logging';
import { editMessageTextHtml, replyHtml } from './send';
import { refusalText } from './stake-picker';
import { LABELS, TEXTS } from './texts';
import type { StartSession } from './trading-session';

// The amount screen's presses (#476, docs/bot-demo.md → The amount screen): an amount is saved as
// the demo stake through POST /trading/stake, and only once it is saved the cycle starts through
// POST /trading/sessions, which reads the saved stake itself. Two requests, not atomic (accepted
// risk 1 of the plan): a refused start leaves the amount saved, a preference in any mode (Rule 29).
// «✏️ Своя сумма» asks for the amount in place; the typed amount is saved and starts the cycle the
// same way.

export interface CycleStakeDeps {
  backend: Pick<BackendClient, 'setStake' | 'readPairs'>;
  logger: Logger;
  dialog: LoginDialog;
  // trading-session.ts's one start path
  startSession: StartSession;
}

interface Screen {
  text: TelegramHtml;
  keyboard: InlineKeyboard;
}

// «💵 Сумма» under a refusal: the amount screen again, as a new message under the refusal, then
// the way back
const retryKeyboard = (step: CycleStakeStep): InlineKeyboard =>
  appendCycleBack(
    new InlineKeyboard()
      .text(LABELS.stakeMenuButton, demoLaunchCallbackData(step.assetId, step.durationSec, 'n'))
      .row(),
    step,
  );
const backKeyboard = (step: CycleStakeStep): InlineKeyboard =>
  appendCycleBack(new InlineKeyboard(), step);

// A save that did not answer `saved`, by where the answer came from, as the picker's savedScreen
// (stake-picker.ts): `keep` leaves a typed amount's step open, so the user can type again, until
// the next button press or command (bot.ts, #319).
type NotSaved = { keep: boolean; screen: Screen };

export function createCycleStakeComposer<C extends Context>({
  backend,
  logger,
  dialog,
  startSession,
}: CycleStakeDeps): {
  composer: Composer<C>;
  onText: (ctx: Context, step: CycleStakeStep, text: string) => Promise<void>;
} {
  const composer = new Composer<C>();

  // An amount: the save, then the start in one attempt, and the screen deleted once the status
  // is sent (#418). A refusal of the save is a reply: the screen stays to press again.
  composer.callbackQuery(CYCLE_STAKE_PATTERN, async (ctx) => {
    const data = cycleStakeDataOf(ctx.match);
    if (data === undefined) {
      await answerCallback(ctx, logger);
      return;
    }
    const [, saved, catalog] = await Promise.all([
      answerCallback(ctx, logger),
      settle(backend.setStake(String(ctx.from.id), TradeMode.Demo, data.amount)),
      settle(backend.readPairs()),
    ]);
    const refused = notSaved(saved, data);
    if (refused !== undefined) {
      await replyHtml(ctx, refused.screen.text, { reply_markup: refused.screen.keyboard });
      return;
    }
    await start(ctx, data, catalog, { retryUnknown: false, removeScreen: true });
  });

  // The prompt in place of the amount screen; the typed amount comes to onText through bot.ts's
  // text handler. Setting the step replaces a login or a picker step the user had open.
  composer.callbackQuery(CYCLE_CUSTOM_PATTERN, async (ctx) => {
    const step = cycleCustomDataOf(ctx.match);
    if (step === undefined) {
      await answerCallback(ctx, logger);
      return;
    }
    dialog.set(ctx.from.id, { step: 'cycleStake', ...step });
    await answerCallback(ctx, logger);
    await editOrReply(
      ctx,
      TEXTS.stakeInputPrompt,
      new InlineKeyboard().text(
        LABELS.stakeBackButton,
        demoLaunchCallbackData(step.assetId, step.durationSec, step.back),
      ),
    );
  });

  // A typed amount: saved, then the cycle starts with the start's one retry on an unknown outcome;
  // a new reply each time, since the bot keeps no id of the prompt to delete.
  async function onText(ctx: Context, step: CycleStakeStep, text: string): Promise<void> {
    const from = ctx.from;
    if (from === undefined) return;
    const amount = parseStakeInput(text);
    if (amount === undefined) {
      keepStep(from.id);
      await replyHtml(ctx, TEXTS.stakeInputInvalid, {
        reply_markup: new InlineKeyboard().text(
          LABELS.stakeBackButton,
          demoLaunchCallbackData(step.assetId, step.durationSec, step.back),
        ),
      });
      return;
    }
    const [saved, catalog] = await Promise.all([
      settle(backend.setStake(String(from.id), TradeMode.Demo, amount)),
      settle(backend.readPairs()),
    ]);
    const refused = notSaved(saved, step);
    if (refused !== undefined) {
      if (refused.keep) keepStep(from.id);
      else endStep(from.id);
      await replyHtml(ctx, refused.screen.text, { reply_markup: refused.screen.keyboard });
      return;
    }
    await start(ctx, step, catalog, { retryUnknown: true, removeScreen: false });
  }

  async function start(
    ctx: Context,
    { assetId, durationSec, back }: CycleStakeStep,
    catalog: Settled<PairsCatalogResponse>,
    options: { retryUnknown: boolean; removeScreen: boolean },
  ): Promise<void> {
    if (ctx.from !== undefined) endStep(ctx.from.id);
    await startSession(ctx, { mode: TradeMode.Demo, assetId, durationSec, back }, catalog, options);
  }

  // undefined on a save
  function notSaved(saved: Settled<SetStakeResult>, step: CycleStakeStep): NotSaved | undefined {
    if (!saved.ok) {
      const { error } = saved;
      const fields = {
        ...errorLogFields(error),
        ...backendErrorFields(error),
        mode: TradeMode.Demo,
      };
      const http = error instanceof BackendError && error.code === BackendErrorCode.HttpStatus;
      if (http && error.reason === StakeErrorCode.BalanceUnavailable) {
        return {
          keep: true,
          screen: { text: TEXTS.stakeBalanceMissing, keyboard: backKeyboard(step) },
        };
      }
      // no answer, a 5xx or a broken body: the UPDATE may have committed, and saving the same
      // amount again is harmless; nothing starts on an unknown save
      if (error instanceof BackendError && (!http || (error.status ?? 0) >= 500)) {
        logger.warn(fields, 'stake save outcome unknown');
        return {
          keep: true,
          screen: { text: TEXTS.stakeSaveUnknown, keyboard: retryKeyboard(step) },
        };
      }
      // no users row: before the first /start; anything else here is the bot's own bug
      if (http && error.reason === StakeErrorCode.UserNotFound)
        logger.warn(fields, 'stake not saved');
      else logger.error(fields, 'stake not saved');
      return { keep: false, screen: { text: TEXTS.unavailable, keyboard: backKeyboard(step) } };
    }
    const result = saved.value;
    if ('saved' in result) return undefined;
    return {
      keep: true,
      screen: { text: refusalText(TradeMode.Demo, result.refused), keyboard: retryKeyboard(step) },
    };
  }

  // only the cycle's step: a login or a picker step the user has open is left alone
  function endStep(id: number): void {
    if (dialog.get(id)?.step === 'cycleStake') dialog.delete(id);
  }
  // set again, so its TTL starts over
  function keepStep(id: number): void {
    const state = dialog.get(id);
    if (state?.step === 'cycleStake') dialog.set(id, state);
  }

  // Every refusal of an edit is classified as in demo.ts: already shown is done, gone gets the
  // screen anew, a transport failure sends nothing more, anything else goes to bot.catch.
  async function editOrReply(ctx: Context, text: TelegramHtml, reply_markup: InlineKeyboard) {
    try {
      await editMessageTextHtml(ctx, text, { reply_markup });
    } catch (error) {
      const refusal = error instanceof GrammyError ? editRefusal(error) : undefined;
      if (refusal === 'shown') return;
      if (refusal === 'gone') {
        await replyHtml(ctx, text, { reply_markup });
        return;
      }
      if (!(error instanceof HttpError)) throw error;
      logger.error(
        { ...errorLogFields(error), ...telegramErrorFields(error, 'editMessageText') },
        'the amount prompt edit failed in transport, sending nothing more',
      );
    }
  }

  return { composer, onText };
}
