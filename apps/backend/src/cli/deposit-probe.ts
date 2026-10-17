import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { destination, pino } from 'pino';
import { createBrokerRestClient } from '@binarius/broker-rest';
import { createDb, createTokenCipher } from '@binarius/db';
import { AccessTokenRefusal, logOptions, type EnvSource } from '@binarius/shared';
import { ensureFreshAccessToken } from '../auth/token-service';
import { createBrokerOAuthClient } from '../broker/oauth-client';
import {
  depositErrorFor,
  mintDepositWidgetSession,
  type DepositWidgetDeps,
} from '../deposit/widget-session';
import { formatFailure } from './kill-switch';
import { readProbeEnv } from './probe-env';

// The owner's check of the cashier widget before the page is built (#11, docs/deposit.md -> The
// probe): one widget session for one account, through the same path as POST /deposit/widget-session,
// printing the outcome, its lifetime and which widget fields the broker sent, by origin. The session
// itself is never printed: it opens the account's deposit form while it lives. The token is taken
// with mayRefresh: false, as rate-limit-probe does, so the probe never exchanges one. A DEMO_ONLY
// process refuses before anything is read (#396).
// Run inside the backend container, with REPLACE_WITH_ID substituted by the broker_accounts.id
// uuid: ACCOUNT_ID=REPLACE_WITH_ID pnpm --filter @binarius/backend deposit-probe
const EXIT_OK = 0;
const EXIT_FAILED = 1;

export interface DepositProbeInput {
  demoOnly: boolean;
  accountId: string;
  // built only past the DEMO_ONLY check, so a refused probe opens no pool
  widget: () => DepositWidgetDeps;
}

function originOf(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return 'unparseable';
  }
}

export async function runDepositProbe(
  { demoOnly, accountId, widget }: DepositProbeInput,
  print: (line: string) => void,
): Promise<number> {
  if (demoOnly) {
    print('refused: demo_only (this process runs DEMO_ONLY=true; docs/deposit.md -> The probe)');
    return EXIT_FAILED;
  }
  let outcome;
  try {
    outcome = await mintDepositWidgetSession(widget(), { accountId, mayRefresh: false });
  } catch (error) {
    // name and code only (Rule 8); whether the broker minted a session is not known here
    print(`failed: ${formatFailure(error)}`);
    return EXIT_FAILED;
  }
  if (outcome.ok) {
    const { reported, session } = outcome;
    print('ok');
    print(`expiresInSec ${session.expiresInSec}`);
    print(
      `widget_url ${reported.widgetUrl === undefined ? 'absent' : `present, origin ${originOf(reported.widgetUrl)}`}`,
    );
    print(
      `widget_origin ${reported.widgetOrigin === undefined ? 'absent' : `present, ${originOf(reported.widgetOrigin)}`}`,
    );
    print(`region ${reported.region ?? 'absent'}`);
    print(`widget served from ${session.widgetOrigin}`);
    return EXIT_OK;
  }
  const answer = depositErrorFor(outcome);
  switch (outcome.kind) {
    case 'token': {
      const hint =
        outcome.reason === AccessTokenRefusal.RefreshNeeded
          ? ' (open the bot balance once, then retry)'
          : '';
      print(`refused: ${outcome.reason}${hint}`);
      break;
    }
    case 'broker':
      print(
        `${answer}: broker ${outcome.code}${outcome.status === undefined ? '' : ` HTTP ${outcome.status}`}`,
      );
      break;
    case 'origin':
      print(`${answer}: widget origin ${outcome.origin} is not in DEPOSIT_WIDGET_ORIGINS`);
      break;
  }
  return EXIT_FAILED;
}

export async function depositProbeMain(
  source: EnvSource,
  print: (line: string) => void,
): Promise<number> {
  let probeEnv: ReturnType<typeof readProbeEnv>;
  try {
    probeEnv = readProbeEnv(source);
  } catch (error) {
    // our own env messages name the variable, never its value
    print(`failed: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_FAILED;
  }
  const { env, accountId } = probeEnv;
  let pool: Pool | undefined;
  try {
    return await runDepositProbe(
      {
        demoOnly: env.demoOnly,
        accountId,
        widget: () => {
          pool = new Pool({ connectionString: env.databaseUrl });
          const logger = pino(logOptions(env.logLevel), destination(2));
          const tokenDeps = {
            db: createDb(pool),
            broker: createBrokerOAuthClient({
              baseUrl: env.brokerApiBaseUrl,
              clientId: env.brokerClientId,
              clientSecret: env.brokerClientSecret,
            }),
            cipher: createTokenCipher({
              keyId: env.tokenEncryptionKeyId,
              key: env.tokenEncryptionKey,
            }),
            logger,
          };
          return {
            accessToken: (id, options) => ensureFreshAccessToken(tokenDeps, id, options),
            rest: createBrokerRestClient({ baseUrl: env.brokerApiBaseUrl }),
            logger,
            webOrigin: env.webPublicUrl,
            platformOrigin: new URL(env.brokerOauthAuthorizeUrl).origin,
            clientId: env.brokerClientId,
            widgetOrigins: env.depositWidgetOrigins,
          };
        },
      },
      print,
    );
  } finally {
    await pool?.end().catch(() => undefined);
  }
}

// The module is imported by its test, so the command only runs when this file is what node was
// started with.
const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  process.exit(
    await depositProbeMain(process.env, (line) => {
      process.stdout.write(`${line}\n`);
    }),
  );
}
