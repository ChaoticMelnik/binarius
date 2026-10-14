import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { destination, pino } from 'pino';
import * as z from 'zod';
import { createBrokerRestClient } from '@binarius/broker-rest';
import { createDb, createTokenCipher } from '@binarius/db';
import { AccessTokenRefusal, logOptions, readEnv } from '@binarius/shared';
import { ensureFreshAccessToken } from '../auth/token-service';
import { createBrokerOAuthClient } from '../broker/oauth-client';
import {
  depositErrorFor,
  mintDepositWidgetSession,
  type DepositWidgetDeps,
} from '../deposit/widget-session';
import { parseEnv } from '../env';

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
  const outcome = await mintDepositWidgetSession(widget(), { accountId, mayRefresh: false });
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

// The module is imported by its test, so the command only runs when this file is what node was
// started with.
const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  const env = parseEnv(process.env);
  const accountId = z.uuid().parse(readEnv(process.env, 'ACCOUNT_ID'));
  let pool: Pool | undefined;
  const code = await runDepositProbe(
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
    (line) => {
      process.stdout.write(`${line}\n`);
    },
  ).finally(() => pool?.end());
  process.exit(code);
}
