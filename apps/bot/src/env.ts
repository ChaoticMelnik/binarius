import {
  parseInternalTokenEnv,
  parseLogLevelEnv,
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
}

export function parseEnv(source: EnvSource): Env {
  return {
    telegramBotToken: parseBotToken(readEnv(source, 'TELEGRAM_BOT_TOKEN'), 'TELEGRAM_BOT_TOKEN'),
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
        : readEnv(source, 'WELCOME_VIDEO_FILE_ID'),
  };
}

// The token goes into the Bot API URL, where a stray space or newline would produce a 404 from
// api.telegram.org rather than anything that names the real problem. The format itself is
// Telegram's to change, so only whitespace is refused here.
function parseBotToken(raw: string, name: string): string {
  if (/\s/.test(raw)) throw new Error(`Env ${name} must not contain whitespace`);
  return raw;
}
