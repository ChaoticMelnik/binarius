import * as z from 'zod';
import { idWireSchema, toId } from './ids';
import { decimalStringSchema, type DecimalString } from './money';

// Partner API (api.binopartner.com/v1). Only the fields issue #6 names are typed; responses are
// loose objects so unknown keys survive parsing. Fields whose shape #6 does not give stay
// `unknown` until a consumer sees real responses (#14).

// `code` type is not documented; both are accepted, nothing is normalized
const envelopeCodeWireSchema = z.union([z.int(), z.string()]);

export function partnerEnvelopeWireSchema<T extends z.ZodType>(data: T) {
  return z.looseObject({ code: envelopeCodeWireSchema, message: z.string(), data });
}

export const partnerErrorWireSchema = z.looseObject({
  code: envelopeCodeWireSchema,
  message: z.string(),
  reason: z.string(),
});
export type PartnerErrorWire = z.infer<typeof partnerErrorWireSchema>;

// --- /stats/overall, /stats/today ------------------------------------------------------------

export const partnerStatsWireSchema = z.looseObject({
  clicks: z.int(),
  registrations: z.int(),
  FTD: z.int(),
  depositsCount: z.int(),
  depositsCryptoCount: z.int(),
  depositsCardCount: z.int(),
  depositsCardRuCount: z.int(),
});
export type PartnerStatsWire = z.infer<typeof partnerStatsWireSchema>;

export interface PartnerStats {
  clicks: number;
  registrations: number;
  ftd: number;
  depositsCount: number;
  depositsCryptoCount: number;
  depositsCardCount: number;
  depositsCardRuCount: number;
}

export function toPartnerStats(wire: PartnerStatsWire): PartnerStats {
  return {
    clicks: wire.clicks,
    registrations: wire.registrations,
    ftd: wire.FTD,
    depositsCount: wire.depositsCount,
    depositsCryptoCount: wire.depositsCryptoCount,
    depositsCardCount: wire.depositsCardCount,
    depositsCardRuCount: wire.depositsCardRuCount,
  };
}

// --- /stats/trader/{id} -----------------------------------------------------------------------

export const partnerDepositMarkWireSchema = z.looseObject({ type: z.string(), at: z.unknown() });
export type PartnerDepositMarkWire = z.infer<typeof partnerDepositMarkWireSchema>;

export const partnerTraderStatsWireSchema = z.looseObject({
  uid: idWireSchema,
  balance: decimalStringSchema,
  firstDeposit: partnerDepositMarkWireSchema.nullable().optional(),
  lastDeposit: partnerDepositMarkWireSchema.nullable().optional(),
  // counter names are taken from /stats/overall, not confirmed for the trader endpoint (#14)
  depositsCount: z.int().optional(),
  depositsCryptoCount: z.int().optional(),
  depositsCardCount: z.int().optional(),
  depositsCardRuCount: z.int().optional(),
  regRate: z.unknown().optional(),
  lastActive: z.unknown().optional(),
  deals: z.unknown().optional(),
  country: z.unknown().optional(),
  links: z.unknown().optional(),
});
export type PartnerTraderStatsWire = z.infer<typeof partnerTraderStatsWireSchema>;

export interface PartnerDepositMark {
  type: string;
  at: unknown;
}

export interface PartnerTraderStats {
  uid: string;
  balance: DecimalString;
  firstDeposit?: PartnerDepositMark | null;
  lastDeposit?: PartnerDepositMark | null;
  depositsCount?: number;
  depositsCryptoCount?: number;
  depositsCardCount?: number;
  depositsCardRuCount?: number;
  regRate?: unknown;
  lastActive?: unknown;
  deals?: unknown;
  country?: unknown;
  links?: unknown;
}

function toDepositMark(wire: PartnerDepositMarkWire | null): PartnerDepositMark | null {
  return wire === null ? null : { type: wire.type, at: wire.at };
}

export function toPartnerTraderStats(wire: PartnerTraderStatsWire): PartnerTraderStats {
  return {
    uid: toId(wire.uid),
    balance: wire.balance,
    ...(wire.firstDeposit === undefined ? {} : { firstDeposit: toDepositMark(wire.firstDeposit) }),
    ...(wire.lastDeposit === undefined ? {} : { lastDeposit: toDepositMark(wire.lastDeposit) }),
    ...(wire.depositsCount === undefined ? {} : { depositsCount: wire.depositsCount }),
    ...(wire.depositsCryptoCount === undefined
      ? {}
      : { depositsCryptoCount: wire.depositsCryptoCount }),
    ...(wire.depositsCardCount === undefined ? {} : { depositsCardCount: wire.depositsCardCount }),
    ...(wire.depositsCardRuCount === undefined
      ? {}
      : { depositsCardRuCount: wire.depositsCardRuCount }),
    ...(wire.regRate === undefined ? {} : { regRate: wire.regRate }),
    ...(wire.lastActive === undefined ? {} : { lastActive: wire.lastActive }),
    ...(wire.deals === undefined ? {} : { deals: wire.deals }),
    ...(wire.country === undefined ? {} : { country: wire.country }),
    ...(wire.links === undefined ? {} : { links: wire.links }),
  };
}

// --- /ref -------------------------------------------------------------------------------------

export const partnerRefLinkWireSchema = z.looseObject({
  type: z.string(),
  region: z.string(),
  name: z.string(),
  url: z.string(),
});
export const partnerRefLinksWireSchema = z.array(partnerRefLinkWireSchema);
export type PartnerRefLinkWire = z.infer<typeof partnerRefLinkWireSchema>;

export interface PartnerRefLink {
  type: string;
  region: string;
  name: string;
  url: string;
}

export function toPartnerRefLink(wire: PartnerRefLinkWire): PartnerRefLink {
  return { type: wire.type, region: wire.region, name: wire.name, url: wire.url };
}

// --- /trader/{id}/positions -------------------------------------------------------------------

export const PartnerBinaryPositionSource = {
  Manual: 'manual',
  Ai: 'ai',
  Copy: 'copy',
  Broker: 'broker',
} as const;
export type PartnerBinaryPositionSource =
  (typeof PartnerBinaryPositionSource)[keyof typeof PartnerBinaryPositionSource];

export const PartnerFuturesPositionSource = { Manual: 'manual', Ai: 'ai', Copy: 'copy' } as const;
export type PartnerFuturesPositionSource =
  (typeof PartnerFuturesPositionSource)[keyof typeof PartnerFuturesPositionSource];

export const partnerPositionsWireSchema = z.looseObject({
  binary: z.array(z.looseObject({ source: z.enum(PartnerBinaryPositionSource) })),
  futures: z.array(z.looseObject({ source: z.enum(PartnerFuturesPositionSource) })),
});
export type PartnerPositionsWire = z.infer<typeof partnerPositionsWireSchema>;

export interface PartnerPositions {
  binary: { source: PartnerBinaryPositionSource }[];
  futures: { source: PartnerFuturesPositionSource }[];
}

export function toPartnerPositions(wire: PartnerPositionsWire): PartnerPositions {
  return {
    binary: wire.binary.map((position) => ({ source: position.source })),
    futures: wire.futures.map((position) => ({ source: position.source })),
  };
}

// --- Envelopes and parsers (each parser takes the full envelope) ------------------------------

export const partnerStatsEnvelopeWireSchema = partnerEnvelopeWireSchema(partnerStatsWireSchema);
export const partnerTraderStatsEnvelopeWireSchema = partnerEnvelopeWireSchema(
  partnerTraderStatsWireSchema,
);
export const partnerRefLinksEnvelopeWireSchema =
  partnerEnvelopeWireSchema(partnerRefLinksWireSchema);
export const partnerPositionsEnvelopeWireSchema = partnerEnvelopeWireSchema(
  partnerPositionsWireSchema,
);

export const parsePartnerStats = (input: unknown): PartnerStats =>
  toPartnerStats(partnerStatsEnvelopeWireSchema.parse(input).data);
export const safeParsePartnerStats = (input: unknown) =>
  partnerStatsEnvelopeWireSchema.safeParse(input);

export const parsePartnerTraderStats = (input: unknown): PartnerTraderStats =>
  toPartnerTraderStats(partnerTraderStatsEnvelopeWireSchema.parse(input).data);
export const safeParsePartnerTraderStats = (input: unknown) =>
  partnerTraderStatsEnvelopeWireSchema.safeParse(input);

export const parsePartnerRefLinks = (input: unknown): PartnerRefLink[] =>
  partnerRefLinksEnvelopeWireSchema.parse(input).data.map(toPartnerRefLink);
export const safeParsePartnerRefLinks = (input: unknown) =>
  partnerRefLinksEnvelopeWireSchema.safeParse(input);

export const parsePartnerPositions = (input: unknown): PartnerPositions =>
  toPartnerPositions(partnerPositionsEnvelopeWireSchema.parse(input).data);
export const safeParsePartnerPositions = (input: unknown) =>
  partnerPositionsEnvelopeWireSchema.safeParse(input);

export const parsePartnerError = (input: unknown): PartnerErrorWire =>
  partnerErrorWireSchema.parse(input);
export const safeParsePartnerError = (input: unknown) => partnerErrorWireSchema.safeParse(input);
