import { OpenAPIHono } from '@hono/zod-openapi';
import { validationFailure } from './error';

// THE one place an OpenAPIHono instance is constructed. defaultHook does NOT
// inherit across `.route()` mounts, so a sub-app built with a bare
// `new OpenAPIHono()` answers validation failures in zod-openapi's default
// shape instead of the project envelope. Every app -- root and sub -- comes
// from this factory; an ESLint no-restricted-syntax rule bans direct
// construction anywhere else.
export function newApiApp(): OpenAPIHono {
  return new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) return validationFailure(c, result.error);
    },
  });
}
