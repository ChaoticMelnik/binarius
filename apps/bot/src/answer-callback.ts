import type { Context } from 'grammy';
import { errorLogFields, telegramErrorFields } from '@binarius/shared';
import type { Logger } from './logging';

export async function answerCallback(ctx: Context, logger: Logger): Promise<void> {
  await ctx.answerCallbackQuery().catch((error: unknown) => {
    logger.warn(
      { ...errorLogFields(error), ...telegramErrorFields(error, 'answerCallbackQuery') },
      'answering the callback query failed',
    );
  });
}
