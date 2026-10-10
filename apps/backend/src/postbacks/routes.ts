import type { FastifyPluginAsync } from 'fastify';
import {
  POSTBACK_PATH_PREFIX,
  PostbackResponseOutcome,
  PostbackSource,
  postbackQuerySchema,
  type PostbackResponse,
} from '@binarius/shared';
import { recordPostback, type Db } from '@binarius/db';
import { secretDigest, secretMatches } from '../auth/internal';
import { createWindow } from '../auth/rate-window';

// The ceiling on deliveries past the secret. The broker's are a few a day at pilot volume; this
// only ever catches a leaked secret.
export const POSTBACK_MAX_PER_MINUTE = 600;

export interface PostbackRoutesDeps {
  db: Db;
  // POSTBACK_URL_SECRET; the route is registered only while it is set (app.ts)
  secret: string;
  maxPerMinute?: number;
}

// The broker's postbacks (#141, docs/postbacks.md). Public: Caddy forwards /postbacks/* here, and
// the secret path segment is the whole gate until #142. The route never credits and never calls
// anyone; past the secret every answer is 200 so the broker has nothing to retry but a
// duplicate. The secret is never logged by us, and withoutSecrets masks it in Fastify's lines.
export const postbackRoutes: FastifyPluginAsync<PostbackRoutesDeps> = async (scope, deps) => {
  const expected = secretDigest(deps.secret);
  // Taken only past the secret: it bounds the writes a holder of the secret can cause, and a
  // probe without it can neither fill it nor reach the database.
  const window = createWindow(deps.maxPerMinute ?? POSTBACK_MAX_PER_MINUTE);

  scope.get<{ Params: { secret: string } }>(
    `${POSTBACK_PATH_PREFIX}:secret`,
    // HEAD would run this handler and journal the delivery; it falls to the not-found handler
    { exposeHeadRoute: false },
    async (request, reply) => {
      // the not-found body: a probe cannot tell a wrong secret from a route that is off
      if (!secretMatches(request.params.secret, expected)) {
        request.log.warn('postback refused');
        return reply.code(404).send({ error: 'not_found' });
      }
      if (window.take().over) return reply.code(429).send({ error: 'too_many_requests' });
      // not journaled: a repeated key, an oversized value, too many keys or a NUL is not a
      // delivery the cabinet's template can produce
      const query = postbackQuerySchema.safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: 'validation' });

      const result = await recordPostback(deps.db, {
        source: PostbackSource.Binodex,
        query: query.data,
      });
      request.log.info(
        {
          outcome: result.outcome,
          reason: result.outcome === PostbackResponseOutcome.Rejected ? result.reason : undefined,
          event: result.event,
          postbackId: result.postbackId,
        },
        'postback received',
      );
      if (result.outcome === PostbackResponseOutcome.Repeated && result.mismatch !== undefined) {
        // field names only: no amount, no trader id, no payload
        request.log.warn(
          {
            depositEventId: result.depositEventId,
            postbackId: result.postbackId,
            mismatch: Object.keys(result.mismatch),
          },
          'postback repeated with different fields',
        );
      }
      const body: PostbackResponse =
        result.outcome === PostbackResponseOutcome.Rejected
          ? { outcome: result.outcome, reason: result.reason }
          : { outcome: result.outcome };
      return reply.code(200).send(body);
    },
  );
};
