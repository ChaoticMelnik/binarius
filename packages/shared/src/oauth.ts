import * as z from 'zod';
import { tradeModeSchema, type TradeMode } from './trading';

const idWireSchema = z.union([z.int(), z.string().min(1)]);

// --- Token response (POST /v1/broker/oauth/token) ---------------------------------------------

export const oauthTokenResponseWireSchema = z.looseObject({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  token_type: z.string(),
  expires_in: z.int().nonnegative(),
  user: z.looseObject({
    id: idWireSchema,
    email: z.string(),
    is_partner_client: z.boolean(),
  }),
});
export type OAuthTokenResponseWire = z.infer<typeof oauthTokenResponseWireSchema>;

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresInSec: number;
  user: { id: string; email: string; isPartnerClient: boolean };
}

export function toOAuthTokens(wire: OAuthTokenResponseWire): OAuthTokens {
  return {
    accessToken: wire.access_token,
    refreshToken: wire.refresh_token,
    tokenType: wire.token_type,
    expiresInSec: wire.expires_in,
    user: {
      id: String(wire.user.id),
      email: wire.user.email,
      isPartnerClient: wire.user.is_partner_client,
    },
  };
}

export const parseOAuthTokenResponse = (input: unknown): OAuthTokens =>
  toOAuthTokens(oauthTokenResponseWireSchema.parse(input));
export const safeParseOAuthTokenResponse = (input: unknown) =>
  oauthTokenResponseWireSchema.safeParse(input);

// --- Widget session (POST /v1/broker/widget-sessions) -----------------------------------------

export interface WidgetSessionRequest {
  origin: string;
  mode: TradeMode;
}

export const widgetSessionRequestWireSchema = z.object({
  origin: z.string().min(1),
  mode: tradeModeSchema,
});
export type WidgetSessionRequestWire = z.infer<typeof widgetSessionRequestWireSchema>;

export function toWidgetSessionRequestWire(
  request: WidgetSessionRequest,
): WidgetSessionRequestWire {
  return { origin: request.origin, mode: request.mode };
}

export const widgetSessionResponseWireSchema = z.looseObject({
  session: z.string().min(1),
  expires_in: z.int().nonnegative(),
});
export type WidgetSessionResponseWire = z.infer<typeof widgetSessionResponseWireSchema>;

export interface WidgetSession {
  session: string;
  expiresInSec: number;
}

export function toWidgetSession(wire: WidgetSessionResponseWire): WidgetSession {
  return { session: wire.session, expiresInSec: wire.expires_in };
}

export const parseWidgetSessionResponse = (input: unknown): WidgetSession =>
  toWidgetSession(widgetSessionResponseWireSchema.parse(input));
export const safeParseWidgetSessionResponse = (input: unknown) =>
  widgetSessionResponseWireSchema.safeParse(input);
