import { z } from '@hono/zod-openapi';

/**
 * Standard cursor-paginated list envelope: `{ data, next_cursor }`. One shape
 * for every collection endpoint so clients never have to special-case which
 * lists paginate. `next_cursor` is the opaque base64url keyset cursor from
 * cursor.ts -- pass it back as `?cursor=` to fetch the next page; `null` on the
 * final page.
 *
 * Usage: `const ListResponse = paginated(Lease).openapi('LeaseListResponse');`
 * The shape is byte-identical to the hand-written `{ data, next_cursor }`
 * schemas the older list endpoints declare inline, so adopting it there is a
 * no-op for the emitted OpenAPI/SDK.
 */
export function paginated<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    data: z.array(item),
    next_cursor: z.string().nullable(),
  });
}
