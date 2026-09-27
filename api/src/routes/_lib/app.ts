import { OpenAPIHono } from '@hono/zod-openapi';
import { validationFailure } from './error';

// Every app needs this hook: Hono does not inherit defaultHook across route mounts.
// ESLint prevents direct OpenAPIHono construction elsewhere.
export function newApiApp(): OpenAPIHono {
  return new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) return validationFailure(c, result.error);
    },
  });
}
