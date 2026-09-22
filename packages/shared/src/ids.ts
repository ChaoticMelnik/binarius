import * as z from 'zod';

// Binodex does not state whether its ids are numeric or strings; both are accepted on the wire
// and normalized to strings losslessly (BinaryPair.id is the exception: confirmed numeric in #8)
export const idWireSchema = z.union([z.int(), z.string().min(1)]);
export type IdWire = z.infer<typeof idWireSchema>;

export const toId = (id: IdWire): string => String(id);
