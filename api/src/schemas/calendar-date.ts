import { z } from '@hono/zod-openapi';

// Shape-only YYYY-MM-DD regexes accept impossible dates such as 2026-99-99,
// which PostgreSQL then turns into a 500. Zod's date check validates both the
// wire format and the actual Gregorian calendar date at the API boundary.
export const CalendarDate = z.string().date();
