import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

const SCHEME = 'Bearer ';

export const secretDigest = (value: string): Buffer => createHash('sha256').update(value).digest();

// Hashing both sides first keeps the comparison constant-time whatever the length of the
// presented value. Used by the bearer below and by the postback route's URL secret (#141).
export function secretMatches(presented: string, expected: Buffer): boolean {
  return timingSafeEqual(secretDigest(presented), expected);
}

// Server-to-server auth: one shared secret per caller class — the bot's fully trusted internal
// token, and the web process's narrow admin token, which opens /admin/* and nothing else.
export function internalBearerAuth(token: string) {
  const expected = secretDigest(token);
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization;
    const presented = header?.startsWith(SCHEME) === true ? header.slice(SCHEME.length) : undefined;
    if (presented === undefined || !secretMatches(presented, expected)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    return undefined;
  };
}
