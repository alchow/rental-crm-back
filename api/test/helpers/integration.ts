import { execSync } from 'node:child_process';

export interface SupabaseStatus {
  API_URL: string;
  DB_URL: string;
  ANON_KEY: string;
  SERVICE_ROLE_KEY: string;
}

export function readSupabaseStatus(): SupabaseStatus {
  const output = execSync('supabase status --output env --workdir db', {
    cwd: process.cwd().endsWith('/api') ? '..' : '.',
    encoding: 'utf8',
  });
  const values = new Map<string, string>();
  for (const line of output.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match) values.set(match[1]!, match[2]!.replace(/^"|"$/g, ''));
  }
  const get = (key: string): string => {
    const value = values.get(key);
    if (!value) throw new Error(`supabase status missing: ${key}`);
    return value;
  };
  return {
    API_URL: get('API_URL'),
    DB_URL: get('DB_URL'),
    ANON_KEY: get('ANON_KEY'),
    SERVICE_ROLE_KEY: get('SERVICE_ROLE_KEY'),
  };
}

export function configureIntegrationEnv(
  port: string,
  overrides: Record<string, string> = {},
): SupabaseStatus {
  const status = readSupabaseStatus();
  Object.assign(process.env, {
    NODE_ENV: 'test',
    PORT: port,
    SUPABASE_URL: status.API_URL,
    SUPABASE_ANON_KEY: status.ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
    SUPABASE_JWKS_URL: `${status.API_URL}/auth/v1/.well-known/jwks.json`,
    SUPABASE_JWT_ISSUER: `${status.API_URL}/auth/v1`,
    SUPABASE_JWT_AUDIENCE: 'authenticated',
    ...overrides,
  });
  return status;
}

export interface ApiResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

export interface ApiRequestOptions {
  token?: string;
  body?: unknown;
  multipart?: FormData;
  idempotencyKey?: string;
  headers?: Record<string, string>;
}

interface FetchApp {
  fetch(request: Request): Response | Promise<Response>;
}

export function createApiClient(app: FetchApp) {
  return async function api(
    method: string,
    path: string,
    options: ApiRequestOptions = {},
  ): Promise<ApiResponse> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...options.headers,
    };
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    const mutating = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method.toUpperCase());
    if (mutating && path.startsWith('/v1/accounts/')) {
      headers['idempotency-key'] = options.idempotencyKey ?? `t-${crypto.randomUUID()}`;
    }

    let init: RequestInit = { method, headers };
    if (options.multipart) {
      init = { ...init, body: options.multipart };
    } else if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      init = { ...init, body: JSON.stringify(options.body) };
    }

    const response = await app.fetch(new Request(`http://test${path}`, init));
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: response.status, body, headers: responseHeaders };
  };
}

export interface Failure {
  name: string;
  detail: string;
}

export function createCheckHarness(): {
  failures: Failure[];
  check: (name: string, run: () => Promise<void>) => Promise<void>;
} {
  const failures: Failure[] = [];
  return {
    failures,
    async check(name, run) {
      try {
        await run();
        console.info(`  PASS  ${name}`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        failures.push({ name, detail });
        console.error(`  FAIL  ${name}: ${detail}`);
      }
    },
  };
}

export function assertStatus(response: ApiResponse, expected: number, context: string): unknown {
  if (response.status !== expected) {
    throw new Error(
      `${context}: expected ${expected}, got ${response.status} body=${JSON.stringify(response.body)}`,
    );
  }
  return response.body;
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function randomToken(): string {
  return Math.random().toString(36).slice(2, 10);
}
