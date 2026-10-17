import pino from 'pino';
import { logOptions } from '@binarius/shared';

// pino's numeric level of `error`
const ERROR_LEVEL = 50;

export interface LogSink {
  name: string;
  lines: Record<string, unknown>[];
  // the destination a pino logger or buildApp's logDestination writes to
  write(line: string): void;
  logger: pino.Logger;
  errorLines(): Record<string, unknown>[];
}

// One process's log, through the production options (logOptions), kept as parsed lines: the
// run's log oracle is that no process wrote a line at `error` (docs/e2e-demo-cycle.md).
export function logSink(name: string): LogSink {
  const lines: Record<string, unknown>[] = [];
  const write = (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>);
  return {
    name,
    lines,
    write,
    logger: pino(logOptions('info'), { write }),
    errorLines: () => lines.filter((line) => Number(line.level) >= ERROR_LEVEL),
  };
}
