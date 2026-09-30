// Compiled by `tsc -b` (include: src) and imported by nothing: the three directives below are
// the oracle that SafeHtml stays nominal and module-local, and that the sink still refuses a
// value that merely looks like one. If any of the three lines starts compiling, tsc reports
// TS2578 (unused directive) and `pnpm check` fails.
import type { FastifyReply } from 'fastify';
import { sendHtml, type SafeHtml } from './html';
// @ts-expect-error the class is module-local (TS2459): exporting it would reopen `new`
import { SafeHtmlValue } from './html';

// @ts-expect-error a structural literal must not pass for SafeHtml (TS2741)
export const viaLiteral: SafeHtml = { value: '<script>', toString: () => '' };
export const viaNew: SafeHtml = new SafeHtmlValue('<script>');

// The sink half. A variable, not a literal, so no excess-property check can make the line fail
// for the wrong reason: only sendHtml's parameter type decides whether this compiles.
declare const reply: FastifyReply;
const looksSafe = { value: '<script>', toString: () => '' };
// @ts-expect-error sendHtml takes SafeHtml, and a value that merely looks like one is not (TS2345)
export const viaSink = sendHtml(reply, 200, looksSafe);
