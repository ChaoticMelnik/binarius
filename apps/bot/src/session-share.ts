import { Composer, InlineKeyboard, type Api, type Context } from 'grammy';
import type { Message } from 'grammy/types';
import {
  errorLogFields,
  type PairsCatalogResponse,
  type TradingSessionView,
} from '@binarius/shared';
import {
  BackendError,
  BackendErrorCode,
  backendErrorFields,
  type BackendClient,
} from './backend-client';
import { telegramErrorFields, type Logger } from './logging';
import { answerInlineQueryEmpty, answerInlineQueryPhotoHtml } from './send';
import { SESSION_NOT_FOUND, sessionTrackingDone } from './session-tracker';
import { LABELS, sessionShareCaption } from './texts';

// «📤 Поделиться» under the session's summary card (#321, docs/bot-session.md → Sharing the
// card): the button opens Telegram's chat picker with the inline query `share:<sessionId>:<fileId>`,
// and the handler below answers it with the card itself, cached by Telegram under that file id.
// Nothing is stored: the query carries the card, and the backend's owner-scoped read of the
// session is the proof that the one asking may share it.

// InlineQuery.query, and so the button's query, is at most 256 characters (Bot API)
export const INLINE_QUERY_LIMIT = 256;
const SHARE_PREFIX = 'share:';
// spelled here, not imported: trading-session.ts imports this file
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
// 256 - 'share:' - the uuid - ':' = 213 characters left for the file id
export const SHARE_PATTERN = new RegExp(`^${SHARE_PREFIX}(${UUID}):(\\S{1,213})$`);

export const shareQuery = (sessionId: string, fileId: string): string =>
  `${SHARE_PREFIX}${sessionId}:${fileId}`;

// the picker lists people, groups and channels; a chat with a bot would show the card to no one
export const shareButton = (query: string) =>
  InlineKeyboard.switchInlineChosen(LABELS.sessionShareButton, {
    query,
    allow_user_chats: true,
    allow_group_chats: true,
    allow_channel_chats: true,
  });

type SentCard = Pick<Message.PhotoMessage, 'chat' | 'message_id' | 'photo'>;

// After the card is sent, since its file id exists only then: the share row on top of the
// card's own keyboard, which the edit replaces whole. Every failure is a warning and nothing
// more — the card is already there with its #318 keyboard, and a done session sends no card
// again, so there is no later moment to retry at.
export async function attachShareButton(
  api: Pick<Api, 'editMessageReplyMarkup'>,
  logger: Logger,
  sessionId: string,
  sent: SentCard,
  cardKeyboard: InlineKeyboard,
): Promise<void> {
  const notAttached = 'trading session share button not attached';
  try {
    // the largest size is last; any size names the same photo to Telegram
    const fileId = sent.photo.at(-1)?.file_id;
    if (fileId === undefined) {
      logger.warn({ sessionId, reason: 'no_file_id' }, notAttached);
      return;
    }
    const query = shareQuery(sessionId, fileId);
    if (query.length > INLINE_QUERY_LIMIT) {
      logger.warn({ sessionId, reason: 'query_too_long' }, notAttached);
      return;
    }
    await api.editMessageReplyMarkup(sent.chat.id, sent.message_id, {
      reply_markup: InlineKeyboard.from([[shareButton(query)], ...cardKeyboard.inline_keyboard]),
    });
  } catch (error) {
    logger.warn(
      {
        ...errorLogFields(error),
        ...telegramErrorFields(error, 'editMessageReplyMarkup'),
        sessionId,
      },
      notAttached,
    );
  }
}

export interface SessionShareDeps {
  backend: Pick<BackendClient, 'readSession' | 'readPairs'>;
  logger: Logger;
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };
const settle = <T>(promise: Promise<T>): Promise<Settled<T>> =>
  promise.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  );

const isNotFound = (error: unknown): boolean =>
  error instanceof BackendError &&
  error.code === BackendErrorCode.HttpStatus &&
  error.reason === SESSION_NOT_FOUND;

// the asset as the card names it (trading-session.ts → sendCard): the settings', or the last
// trade's when the settings could not be read (#321 clarify, manager's decision of 2026-10-11)
const assetIdOf = (view: TradingSessionView): number | undefined =>
  view.settings?.assetId ?? view.lastIntent?.assetId;

const symbolOf = (catalog: Settled<PairsCatalogResponse>, assetId: number): string | null =>
  catalog.ok ? (catalog.value.pairs.find((pair) => pair.id === assetId)?.symbol ?? null) : null;

// Mounted on the bot itself, not under the private-chat filter: inline updates carry no chat.
// Inline mode makes `@bot …` available to anyone in any chat, so every query is answered, and
// everything but the owner's query for a finished session gets the empty answer.
export function createSessionShareComposer<C extends Context>({
  backend,
  logger,
}: SessionShareDeps): Composer<C> {
  const composer = new Composer<C>();

  composer.inlineQuery(SHARE_PATTERN, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    const fileId = ctx.match[2] ?? '';
    const [read, catalog] = await Promise.all([
      settle(backend.readSession(sessionId, String(ctx.inlineQuery.from.id))),
      settle(backend.readPairs()),
    ]);
    if (!read.ok) {
      // another user's session is the same 404 as a missing one (Rule 13): nothing to say
      if (!isNotFound(read.error)) {
        logger.warn(
          { ...errorLogFields(read.error), ...backendErrorFields(read.error), sessionId },
          'trading session not shared',
        );
      }
      await answer(ctx, sessionId, null);
      return;
    }
    const view = read.value;
    const assetId = assetIdOf(view);
    // the counts are final only once the session is done; the same button works when it is
    if (!sessionTrackingDone(view) || assetId === undefined) {
      await answer(ctx, sessionId, null);
      return;
    }
    await answer(ctx, sessionId, {
      fileId,
      caption: sessionShareCaption(
        symbolOf(catalog, assetId),
        assetId,
        view.trades,
        ctx.me.username,
      ),
    });
  });

  composer.on('inline_query', (ctx) => answer(ctx, undefined, null));

  // /setinlinefeedback: the result's id is the session's (answerInlineQueryPhotoHtml's `id`)
  composer.on('chosen_inline_result', (ctx) => {
    logger.info({ sessionId: ctx.chosenInlineResult.result_id }, 'trading session card shared');
  });

  async function answer(
    ctx: Context,
    sessionId: string | undefined,
    card: { fileId: string; caption: ReturnType<typeof sessionShareCaption> } | null,
  ): Promise<void> {
    try {
      if (card === null || sessionId === undefined) {
        await answerInlineQueryEmpty(ctx);
      } else {
        await answerInlineQueryPhotoHtml(ctx, { id: sessionId, fileId: card.fileId }, card.caption);
      }
    } catch (error) {
      // a forged or foreign file id is refused here too (400): Telegram is its validator
      logger.warn(
        {
          ...errorLogFields(error),
          ...telegramErrorFields(error, 'answerInlineQuery'),
          ...(sessionId === undefined ? {} : { sessionId }),
        },
        'inline query not answered',
      );
    }
  }

  return composer;
}
