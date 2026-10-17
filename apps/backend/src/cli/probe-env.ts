import * as z from 'zod';
import { readEnv, type EnvSource } from '@binarius/shared';
import { parseEnv, type Env } from '../env';

// The ACCOUNT_ID rule of both broker probes, checked before the rest of the env. The message
// names the variable, never its value, like every other env message.
export function readProbeEnv(source: EnvSource): { env: Env; accountId: string } {
  const accountId = readEnv(source, 'ACCOUNT_ID');
  if (!z.uuid().safeParse(accountId).success) throw new Error('Env ACCOUNT_ID must be a uuid');
  return { env: parseEnv(source), accountId };
}
