import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { getSb } from '../supabase/request-client';
import { ApiError, errorResponses } from './_lib/error';

// The full set of entity kinds the search RPC understands. Used both at
// runtime (validation) and in the OpenAPI schema (enum).
const SEARCHABLE_TYPES = ['tenant', 'vendor', 'property', 'area', 'maintenance_request'] as const;

// Structured disambiguation context, returned as a TAGGED discriminated union
// keyed on `context.kind` so consumers (dashboard + agent) narrow cleanly in a
// generated client instead of casting on the sibling `entity_type`. Each entity
// kind that carries context emits its own object; `context` is null for kinds
// without one yet, and for tenants with no resolvable tenancy.

// `tenant`: the tenant's current unit + property via their most relevant tenancy
// (unchanged fields from the original SearchContext; now tagged kind='tenant').
const TenantContext = z
  .object({
    kind: z.literal('tenant'),
    unit_name: z.string().nullable(),
    property_name: z.string().nullable(),
    area_id: z.string().uuid().nullable(),
    tenancy_id: z.string().uuid().nullable(),
    tenancy_status: z.string().nullable(),
  })
  .openapi('TenantContext');

// `area`: the unit's property (the disambiguator) + its current occupancy. The
// area's own unit/common kind is `area_kind` (the discriminator already owns
// `kind`). `active_tenancy_id` is the relational handoff — "the tenant of this
// unit" — so the caller can address the occupant with no second fetch.
const AreaContext = z
  .object({
    kind: z.literal('area'),
    property_id: z.string().uuid(),
    property_name: z.string(),
    address: z.string().nullable(),
    area_kind: z.string(),
    active_tenancy_id: z.string().uuid().nullable(),
    tenant_names: z.array(z.string()),
    occupancy_status: z.enum(['occupied', 'vacant']),
  })
  .openapi('AreaContext');

const SearchContext = z
  .discriminatedUnion('kind', [TenantContext, AreaContext])
  .openapi('SearchContext');

const SearchResult = z
  .object({
    entity_type: z.enum(SEARCHABLE_TYPES),
    entity_id: z.string().uuid(),
    title: z.string(),
    subtitle: z.string().nullable(),
    score: z.number(),
    context: SearchContext.nullable(),
  })
  .openapi('SearchResult');

// Non-paginated: results are ranked by score (higher = better match) and
// capped by `limit`. There is no next_cursor — callers narrow the result
// set via `types`/`exclude` and `limit` rather than paging through it.
const SearchResponse = z
  .object({ data: z.array(SearchResult) })
  .openapi('SearchResponse');

const AccountParam = z.object({
  accountId: z.string().uuid().openapi({ param: { name: 'accountId', in: 'path' } }),
});

const SearchQuery = z.object({
  q: z.string().trim().min(2).max(100),
  types: z.string().optional(),
  exclude: z.string().optional(),
  limit: z.coerce.number().int().positive().max(25).default(10),
});

const search = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/search',
  tags: ['search'],
  summary: 'Ranked entity search',
  description:
    'Search across all entity kinds within an account and return results ranked by relevance. ' +
    '`q` is the search text (minimum 2 characters). `types` narrows results to specific entity kinds ' +
    '(comma-separated subset of tenant, vendor, property, area, maintenance_request); omitting it ' +
    'searches all kinds. `exclude` removes kinds from results (same format); omitting it excludes ' +
    'nothing. Results are ordered by score (higher = better match) and capped at `limit` (max 25, ' +
    'default 10) — the response is not paginated because search is ranked rather than sequentially ' +
    'ordered. Serves both the dashboard typeahead and agent entity disambiguation; branch on ' +
    '`entity_type` to render or resolve the match. `tenant` results include a structured ' +
    '`context` (current unit + property) so two same-named tenants can be told apart without a ' +
    'follow-up fetch; `context` is null for other kinds.',
  request: { params: AccountParam, query: SearchQuery },
  responses: {
    200: { description: 'ranked results', content: { 'application/json': { schema: SearchResponse } } },
    ...errorResponses,
  },
});

export const searchApp = newApiApp();

searchApp.openapi(search, async (c) => {
  const { accountId } = c.req.valid('param');
  const { q, types: typesRaw, exclude: excludeRaw, limit } = c.req.valid('query');

  // Parse and validate the comma-separated filter strings.
  const parseKinds = (raw: string | undefined, field: 'types' | 'exclude'): string[] | null => {
    if (!raw) return null;
    const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) return null;
    const bad = parts.filter((p) => !(SEARCHABLE_TYPES as readonly string[]).includes(p));
    if (bad.length > 0) {
      throw new ApiError(400, 'invalid_request', `unknown entity type(s): ${bad.join(', ')}`, {
        fieldErrors: { [field]: bad },
      });
    }
    return parts;
  };

  const typesArr = parseKinds(typesRaw, 'types');
  const excludeArr = parseKinds(excludeRaw, 'exclude');

  const sb = getSb(c);
  const { data, error } = await sb.rpc('search_entities', {
    p_account_id: accountId,
    p_q: q,
    p_types: typesArr,
    p_exclude: excludeArr,
    p_limit: limit,
  });
  if (error) throw new ApiError(500, 'database_error', error.message);
  return c.json({ data: (data ?? []) } as z.infer<typeof SearchResponse>, 200);
});
