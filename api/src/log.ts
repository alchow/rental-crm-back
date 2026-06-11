import { pino, type Logger } from 'pino';
import { loadEnv } from './env';

// Process-wide structured logger. JSON lines in production (Render captures
// stdout/stderr); pretty-printed in development. Request-scoped logging adds
// requestId via bindings -- see middleware/request-log.ts.
//
// House rule: prefer `getLogger().<level>({ ...context }, 'message')` over
// console.* so every line is machine-parseable and carries consistent keys.

let cached: Logger | null = null;

export function getLogger(): Logger {
  if (cached) return cached;
  const env = loadEnv();
  cached = pino({
    level: env.LOG_LEVEL,
    // pino-pretty is a devDependency; the transport branch is dev-only so
    // the production bundle never tries to resolve it.
    ...(env.NODE_ENV === 'development'
      ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
      : {}),
  });
  return cached;
}

// Test-only: drop the cached instance so a test can re-init with new env.
export function _resetLoggerForTests(): void {
  cached = null;
}

// Test-only: replace the process logger with one writing into a test sink
// (pino accepts any { write(line: string) } destination). Tests use this to
// assert on structured log lines -- e.g. the audit_chain_broken alert --
// without intercepting process stdio.
export function _setLoggerForTests(logger: Logger): void {
  cached = logger;
}
