import { z } from '@hono/zod-openapi';

// The database is the final check (accounts_validate_time_zone: pg_timezone_names);
// this also requires a zone the API's own Intl date math can use.
export const TimeZoneName = z
  .string()
  .min(1)
  .max(80)
  .refine((zone) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: zone });
      return /^[A-Za-z][A-Za-z0-9_+/-]*$/.test(zone);
    } catch {
      return false;
    }
  }, 'Choose an IANA time zone');

// CONTRACT: as_of_date is today's date in this zone (accounts.time_zone, 'UTC' by default).
export const ClockBasis = z.string().openapi({
  description: "The account's IANA time zone; as_of_date is today's date there.",
  example: 'America/Los_Angeles',
});
