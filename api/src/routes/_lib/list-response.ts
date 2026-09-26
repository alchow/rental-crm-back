import { z } from '@hono/zod-openapi';

/** Cursor-paginated list envelope; next_cursor is null on the final page. */
export function paginated<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    data: z.array(item),
    next_cursor: z.string().nullable(),
  });
}
