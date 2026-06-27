import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { requireAuth } from '../middleware/auth';
import { getSb } from '../supabase/request-client';
import { ApiError, errorResponses } from './_lib/error';
import { normalizePhone } from './_lib/phone';

// GET/PATCH /v1/profile -- the landlord's own profile (public.users mirror).
//
// Authenticated but NOT account-scoped (like /me): the row is keyed off the
// verified JWT's auth.uid(), never a path param or body id. RLS on
// public.users (users_self_select / users_self_update) is the backstop -- a
// caller can only ever read or write their own row, so the handlers don't
// need an explicit ownership filter beyond `id = auth.userId`.
//
// phone is stored in E.164. PATCH normalises whatever the client sends via
// normalizePhone() so the stored value matches the DB CHECK; a number that
// can't be normalised is a 422, never a silent drop.

const Profile = z
  .object({
    id: z.string().uuid(),
    display_name: z.string().nullable(),
    phone: z.string().nullable(),
    // Non-null only when `phone` was confirmed via the SMS OTP flow
    // (landlord-agent issues the code; the verified result is written here).
    // Editing phone via PATCH below clears this back to null.
    phone_verified_at: z.string().nullable(),
  })
  .openapi('Profile');

const PatchProfileBody = z
  .object({
    display_name: z.string().min(1).max(200).nullable().optional(),
    // Accept a loosely-formatted number (e.g. "(555) 123-4567"); the handler
    // normalises to E.164. null clears the stored number.
    phone: z.string().min(1).max(40).nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, {
    message: 'at least one field is required',
  })
  .openapi('PatchProfileBody');

const getRoute = createRoute({
  method: 'get',
  path: '/profile',
  tags: ['profile'],
  summary: 'Get the caller’s profile',
  middleware: [requireAuth()] as const,
  responses: {
    200: { description: 'profile', content: { 'application/json': { schema: Profile } } },
    ...errorResponses,
  },
});

const patchRoute = createRoute({
  method: 'patch',
  path: '/profile',
  tags: ['profile'],
  summary: 'Update the caller’s profile (partial)',
  middleware: [requireAuth()] as const,
  request: {
    body: { content: { 'application/json': { schema: PatchProfileBody } }, required: true },
  },
  responses: {
    200: { description: 'updated', content: { 'application/json': { schema: Profile } } },
    ...errorResponses,
  },
});

const profile = newApiApp();

profile.openapi(getRoute, async (c) => {
  const auth = c.get('auth');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('users')
    .select('id, display_name, phone, phone_verified_at')
    .eq('id', auth.userId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'profile not found');
  return c.json(data as z.infer<typeof Profile>, 200);
});

profile.openapi(patchRoute, async (c) => {
  const auth = c.get('auth');
  const body = c.req.valid('json');
  const sb = getSb(c);

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.display_name !== undefined) update.display_name = body.display_name;
  if (body.phone !== undefined) {
    // Any change to the number (set or clear) invalidates a prior verification:
    // phone_verified_at must only ever describe the number currently on file.
    // Re-verification goes back through the agent's SMS OTP flow.
    update.phone_verified_at = null;
    if (body.phone === null) {
      update.phone = null;
    } else {
      const normalized = normalizePhone(body.phone);
      if (!normalized) {
        throw new ApiError(
          422,
          'invalid_phone',
          `could not resolve '${body.phone}' to a valid E.164 number; store the number in E.164 format (+[country][number]) and retry`,
        );
      }
      update.phone = normalized;
    }
  }

  const { data, error } = await sb
    .from('users')
    .update(update)
    .eq('id', auth.userId)
    .is('deleted_at', null)
    .select('id, display_name, phone, phone_verified_at')
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'profile not found');
  return c.json(data as z.infer<typeof Profile>, 200);
});

export default profile;
