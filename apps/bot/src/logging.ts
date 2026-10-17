import type pino from 'pino';

export type Logger = Pick<pino.Logger, 'info' | 'warn' | 'error' | 'debug'>;
