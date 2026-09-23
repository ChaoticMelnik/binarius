import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

const SCHEME = 'Bearer ';

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

// Server-to-server auth for the bot: one shared secret. Hashing both sides first keeps the
// comparison constant-time whatever the length of the presented token.
export function internalBearerAuth(token: string) {
  const expected = digest(token);
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization;
    const presented = header?.startsWith(SCHEME) === true ? header.slice(SCHEME.length) : undefined;
    if (presented === undefined || !timingSafeEqual(digest(presented), expected)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    return undefined;
  };
}
