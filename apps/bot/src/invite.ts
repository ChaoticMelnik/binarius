import type { Context } from 'grammy';
import type { User } from 'grammy/types';
import {
  commandRetryCallbackData,
  errorLogFields,
  referralLinkOf,
  UserErrorCode,
  UserStatus,
} from '@binarius/shared';
import { BackendError, backendErrorFields, type BackendClient } from './backend-client';
import { inviteKeyboard, menuKeyboard, retryKeyboard, supportKeyboard } from './keyboards';
import type { Logger } from './logging';
import { replyHtml } from './send';
import { TEXTS } from './texts';

export interface InviteDeps {
  backend: Pick<BackendClient, 'readReferral'>;
  logger: Logger;
}

// The /invite screen (#115, docs/referrals.md → The screen): the user's personal link and how many
// users it brought. Reached by /invite, «👥 Пригласить друга» and its «🔄 Повторить»; always a new
// message, since the card and the summary card it is pressed under are photos.
export async function showInvite(
  ctx: Context,
  from: User,
  { backend, logger }: InviteDeps,
): Promise<void> {
  let user;
  try {
    user = await backend.readReferral(String(from.id));
  } catch (error) {
    // no users row yet: /start creates it, and the menu button runs /start's path. Decided by the
    // code, not the status, as /account
    if (error instanceof BackendError && error.reason === UserErrorCode.UserNotFound) {
      await replyHtml(ctx, TEXTS.inviteNeedsStart, { reply_markup: menuKeyboard() });
      return;
    }
    logger.warn({ ...errorLogFields(error), ...backendErrorFields(error) }, '/invite not read');
    await replyHtml(ctx, TEXTS.unavailable, {
      reply_markup: retryKeyboard(commandRetryCallbackData('invite')),
    });
    return;
  }
  if (user.status === UserStatus.Blocked) {
    await replyHtml(ctx, TEXTS.blocked, { reply_markup: supportKeyboard() });
    return;
  }
  const referralLink = referralLinkOf(ctx.me.username, user.code);
  await replyHtml(ctx, TEXTS.inviteScreen({ referralLink, count: String(user.invited) }), {
    reply_markup: inviteKeyboard(referralLink),
  });
}
