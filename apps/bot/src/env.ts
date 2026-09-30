import {
  parseInternalTokenEnv,
  parseLogLevelEnv,
  parseNoWhitespaceEnv,
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
  };
}
