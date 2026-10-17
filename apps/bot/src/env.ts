import {
  parseInternalTokenEnv,
  parseLogLevelEnv,
  parseNoWhitespaceEnv,
  parseOriginEnv,
  parseUrlEnv,
  readEnv,
  type EnvSource,
  type LogLevel,
  type UrlEnvRules,
} from '@binarius/shared';

// the backend is reached over the compose network, where plain http is what the other services
// already use; an IPv6 literal would have to be bracketed and nothing here needs one
const BACKEND_URL_RULES: UrlEnvRules = { protocols: ['http:', 'https:'], allowIpv6Literal: false };

export interface Env {
  telegramBotToken: string;
  internalApiToken: string;
  backendUrl: string;
  logLevel: LogLevel;
  welcomeVideoFileId?: string;
  // apps/web's origin, the cashier's (#27): the same variable and rule as web's and backend's
  webPublicUrl: string;
  // the private channel the promo card is posted to for its file id (#538); unset, no share button
  shareStorageChatId?: number;
}

// A Telegram chat id: a channel's is negative (-100…), which parseIntegerEnv refuses. An empty
// value is refused here too, so a set but blank variable is a startup error, not "no channel".
export function parseChatIdEnv(raw: string, name: string): number {
  const value = Number(raw);
  if (!/^-?\d{1,19}$/.test(raw) || !Number.isSafeInteger(value)) {
    throw new Error(`Env ${name} must be a Telegram chat id`);
  }
  return value;
}

export function parseEnv(source: EnvSource): Env {
  return {
    // the formats themselves are Telegram's to change, so only whitespace is refused; a file id
    // Telegram always refuses would make every /start pay for a doomed sendVideo before falling back
    telegramBotToken: parseNoWhitespaceEnv(
      readEnv(source, 'TELEGRAM_BOT_TOKEN'),
      'TELEGRAM_BOT_TOKEN',
    ),
    internalApiToken: parseInternalTokenEnv(
      readEnv(source, 'INTERNAL_API_TOKEN'),
      'INTERNAL_API_TOKEN',
    ),
    backendUrl: parseUrlEnv(readEnv(source, 'BACKEND_URL'), 'BACKEND_URL', BACKEND_URL_RULES),
    logLevel: parseLogLevelEnv(readEnv(source, 'LOG_LEVEL', 'info'), 'LOG_LEVEL'),
    // optional, but an explicitly empty value is a misconfiguration rather than "no video":
    // readEnv refuses '', while an absent variable simply leaves the field undefined
    welcomeVideoFileId:
      source.WELCOME_VIDEO_FILE_ID === undefined
        ? undefined
        : parseNoWhitespaceEnv(readEnv(source, 'WELCOME_VIDEO_FILE_ID'), 'WELCOME_VIDEO_FILE_ID'),
    webPublicUrl: parseOriginEnv(readEnv(source, 'WEB_PUBLIC_URL'), 'WEB_PUBLIC_URL'),
    shareStorageChatId:
      source.SHARE_STORAGE_CHAT_ID === undefined
        ? undefined
        : parseChatIdEnv(source.SHARE_STORAGE_CHAT_ID, 'SHARE_STORAGE_CHAT_ID'),
  };
}
