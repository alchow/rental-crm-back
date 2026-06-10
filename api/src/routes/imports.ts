import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { getUserClient } from '../supabase/user-client';
import { ApiError, errorResponses } from './_lib/error';
import { decodeCursor, encodeCursor } from './_lib/cursor';
import {
  parseImportFile,
  extFromFilename,
  mimeForExt,
  regionMeta,
  MAX_FILE_BYTES,
  type ParsedRegion,
} from '../admin/import-parser';
import { recognizeAndSuggest, chat, type ChatTurn } from '../admin/import-llm';
import { uploadImportSource } from '../admin/import-storage';
import { runImport } from '../admin/import-executor';
import { BLOCKER_CODES, computeRequirements, type RegionEntityMapping } from '../admin/import-catalog';

// ============================================================================
// Onboarding import — upload an arbitrary Excel/CSV, recognize it, map it to
// our schema via an interactive LLM-assisted flow, PREVIEW the result, and
// COMMIT it. The LLM only proposes; the deterministic executor writes.
//
// Pipeline / status machine:
//   POST   /imports                      multipart -> parse, recognize, suggest
//   GET    /imports                      list sessions
//   GET    /imports/{sessionId}          one session
//   PATCH  /imports/{sessionId}/mapping  confirm/override column->field mapping
//   PATCH  /imports/{sessionId}/parents  resolve required-parent ambiguity
//   POST   /imports/{sessionId}/chat     LLM-assisted mapping refinement
//   GET    /imports/{sessionId}/rows     parsed rows (raw cell values)
//   PATCH  /imports/{sessionId}/rows     include/exclude rows
//   POST   /imports/{sessionId}/preview  dry-run (rolled back) -> preview_summary
//   POST   /imports/{sessionId}/confirm  commit (409 if blockers remain)
//   DELETE /imports/{sessionId}          soft-delete the session
//
// Ordinary session/row reads + mapping/parent/exclusion writes go through the
// user client under RLS. Only two operations are privileged and routed through
// admin helpers: archiving the source file (service-role storage) and the
// executor's transactional preview/commit (raw pg). Privacy: the LLM only ever
// receives column names + <=5 sample values per column — never full row data.
// ============================================================================

// ----- schemas ---------------------------------------------------------------

// Stable machine-readable blocker cause. The FE switches on `code` (+ the
// structured fields around it); `message` is display-only and may change.
const BlockerCodeSchema = z.enum(BLOCKER_CODES).openapi('ImportBlockerCode');

const ImportBlocker = z
  .object({
    scope: z.enum(['region', 'row']),
    region_index: z.number().int(),
    row_index: z.number().int().nullable(),
    entity_type: z.string().nullable(),
    field: z.string().nullable(),
    code: BlockerCodeSchema,
    message: z.string(),
  })
  .openapi('ImportBlocker');

// Deterministic parent-requirement signal, computed from the same catalog the
// executor enforces -- present on every session response so the FE can stage
// its property-resolution step without parsing messages or running a preview.
const ImportRequirementsSchema = z
  .object({
    property: z.object({
      needed: z.boolean(),
      satisfied: z.boolean(),
      sources: z.array(z.enum(['mapped_column', 'default_property_id', 'property_overrides'])),
    }),
  })
  .openapi('ImportRequirements');

const ImportSession = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    status: z.string(),
    source_filename: z.string(),
    source_mime: z.string().nullable(),
    source_bytes: z.number().int().nullable(),
    source_path: z.string().nullable(),
    regions: z.array(z.any()),
    recognition: z.array(z.any()),
    mapping: z.array(z.any()),
    parent_resolutions: z.record(z.any()),
    chat: z.array(z.any()),
    preview_summary: z.any().nullable(),
    result: z.any().nullable(),
    error: z.string().nullable(),
    requirements: ImportRequirementsSchema,
    created_at: z.string(),
    updated_at: z.string(),
    deleted_at: z.string().nullable(),
  })
  .openapi('ImportSession');

const ImportRow = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    session_id: z.string().uuid(),
    region_index: z.number().int(),
    row_index: z.number().int(),
    raw: z.record(z.any()),
    excluded: z.boolean(),
    blockers: z.array(z.object({ field: z.string().nullable(), code: BlockerCodeSchema, message: z.string() })),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi('ImportRow');

const FieldMappingSchema = z.object({
  target_field: z.string(),
  source_column: z.string().nullable().optional(),
  constant: z.string().nullable().optional(),
  confidence: z.number().optional(),
});
const RegionEntityMappingSchema = z.object({
  region_index: z.number().int().nonnegative(),
  entity_type: z.string(),
  fields: z.array(FieldMappingSchema),
});

const ExecutionResultSchema = z
  .object({
    committed: z.boolean(),
    dry_run: z.boolean(),
    rows_total: z.number().int(),
    rows_excluded: z.number().int(),
    rows_active: z.number().int(),
    rows_blocked: z.number().int(),
    rows_imported: z.number().int(),
    counts: z.record(z.object({ created: z.number().int(), reused: z.number().int() })),
    created_ids: z.record(z.array(z.string())),
    blockers: z.array(ImportBlocker),
    date_interpretations: z.array(
      z.object({
        field: z.string(),
        raw: z.string(),
        iso: z.string(),
        interpreted_as: z.string(),
        ambiguous: z.boolean(),
      }),
    ),
  })
  .openapi('ImportExecutionResult');

const AccountParam = z.object({
  accountId: z.string().uuid().openapi({ param: { name: 'accountId', in: 'path' } }),
});
const SessionParam = z.object({
  accountId: z.string().uuid().openapi({ param: { name: 'accountId', in: 'path' } }),
  sessionId: z.string().uuid().openapi({ param: { name: 'sessionId', in: 'path' } }),
});

const ListQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
});
const RowsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
});

const SessionListResponse = z
  .object({ data: z.array(ImportSession), next_cursor: z.string().nullable() })
  .openapi('ImportSessionListResponse');
const RowsListResponse = z
  .object({ data: z.array(ImportRow), next_cursor: z.string().nullable() })
  .openapi('ImportRowListResponse');

const UploadBody = z
  .object({ file: z.any().describe('binary spreadsheet/CSV file (multipart)') })
  .openapi('ImportUploadBody');
const MappingBody = z.object({ mapping: z.array(RegionEntityMappingSchema) }).openapi('ImportMappingBody');
const ParentsBody = z
  .object({
    parent_resolutions: z.object({
      default_property_id: z.string().uuid().nullable().optional(),
      property_overrides: z
        .record(
          z.object({
            mode: z.enum(['existing', 'create']),
            id: z.string().uuid().nullable().optional(),
          }),
        )
        .optional(),
    }),
  })
  .openapi('ImportParentsBody');
const ChatBody = z.object({ message: z.string().min(1).max(4000) }).openapi('ImportChatBody');
const ChatResponse = z
  .object({
    reply: z.string(),
    proposed_mapping: z.array(RegionEntityMappingSchema).nullable(),
    session: ImportSession,
  })
  .openapi('ImportChatResponse');
const RowsPatchBody = z
  .object({
    updates: z.array(z.object({ id: z.string().uuid(), excluded: z.boolean() })).min(1),
  })
  .openapi('ImportRowsPatchBody');
const RowsPatchResponse = z.object({ updated: z.number().int() }).openapi('ImportRowsPatchResponse');
const RunResponse = z
  .object({ result: ExecutionResultSchema, session: ImportSession })
  .openapi('ImportRunResponse');

// ----- routes ----------------------------------------------------------------

const upload = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/imports',
  tags: ['imports'],
  summary: 'Upload a spreadsheet/CSV; parse, recognize, and suggest a mapping (multipart).',
  request: {
    params: AccountParam,
    body: { content: { 'multipart/form-data': { schema: UploadBody } }, required: true },
  },
  responses: {
    201: { description: 'session created', content: { 'application/json': { schema: ImportSession } } },
    ...errorResponses,
  },
});

const list = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/imports',
  tags: ['imports'],
  summary: 'List import sessions',
  request: { params: AccountParam, query: ListQuery },
  responses: {
    200: { description: 'page', content: { 'application/json': { schema: SessionListResponse } } },
    ...errorResponses,
  },
});

const get = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/imports/{sessionId}',
  tags: ['imports'],
  summary: 'Get one import session',
  request: { params: SessionParam },
  responses: {
    200: { description: 'session', content: { 'application/json': { schema: ImportSession } } },
    ...errorResponses,
  },
});

const patchMapping = createRoute({
  method: 'patch',
  path: '/accounts/{accountId}/imports/{sessionId}/mapping',
  tags: ['imports'],
  summary: 'Confirm or override the column-to-field mapping',
  request: {
    params: SessionParam,
    body: { content: { 'application/json': { schema: MappingBody } }, required: true },
  },
  responses: {
    200: { description: 'updated', content: { 'application/json': { schema: ImportSession } } },
    ...errorResponses,
  },
});

const patchParents = createRoute({
  method: 'patch',
  path: '/accounts/{accountId}/imports/{sessionId}/parents',
  tags: ['imports'],
  summary: 'Resolve required-parent ambiguity (default property / per-name overrides)',
  request: {
    params: SessionParam,
    body: { content: { 'application/json': { schema: ParentsBody } }, required: true },
  },
  responses: {
    200: { description: 'updated', content: { 'application/json': { schema: ImportSession } } },
    ...errorResponses,
  },
});

const postChat = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/imports/{sessionId}/chat',
  tags: ['imports'],
  summary: 'Ask the assistant to explain or revise the mapping',
  request: {
    params: SessionParam,
    body: { content: { 'application/json': { schema: ChatBody } }, required: true },
  },
  responses: {
    200: { description: 'reply', content: { 'application/json': { schema: ChatResponse } } },
    ...errorResponses,
  },
});

const listRows = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/imports/{sessionId}/rows',
  tags: ['imports'],
  summary: 'List parsed rows for a session',
  request: { params: SessionParam, query: RowsQuery },
  responses: {
    200: { description: 'page', content: { 'application/json': { schema: RowsListResponse } } },
    ...errorResponses,
  },
});

const patchRows = createRoute({
  method: 'patch',
  path: '/accounts/{accountId}/imports/{sessionId}/rows',
  tags: ['imports'],
  summary: 'Include/exclude rows from the import',
  request: {
    params: SessionParam,
    body: { content: { 'application/json': { schema: RowsPatchBody } }, required: true },
  },
  responses: {
    200: { description: 'updated', content: { 'application/json': { schema: RowsPatchResponse } } },
    ...errorResponses,
  },
});

const preview = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/imports/{sessionId}/preview',
  tags: ['imports'],
  summary: 'Dry-run the import (transaction rolled back) and return the would-be result',
  request: { params: SessionParam },
  responses: {
    200: { description: 'preview', content: { 'application/json': { schema: RunResponse } } },
    ...errorResponses,
  },
});

const confirm = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/imports/{sessionId}/confirm',
  tags: ['imports'],
  summary: 'Commit the import. Returns 409 if unresolved blockers remain.',
  request: { params: SessionParam },
  responses: {
    200: { description: 'committed', content: { 'application/json': { schema: RunResponse } } },
    ...errorResponses,
  },
});

const remove = createRoute({
  method: 'delete',
  path: '/accounts/{accountId}/imports/{sessionId}',
  tags: ['imports'],
  summary: 'Soft-delete an import session (created records are kept)',
  request: { params: SessionParam },
  responses: {
    204: { description: 'deleted' },
    ...errorResponses,
  },
});

// ----- handlers --------------------------------------------------------------

export const importsApp = new OpenAPIHono();

type Sb = ReturnType<typeof getUserClient>;

async function loadSession(sb: Sb, accountId: string, sessionId: string): Promise<Record<string, unknown>> {
  const { data, error } = await sb
    .from('import_sessions')
    .select('*')
    .eq('account_id', accountId)
    .eq('id', sessionId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'import session not found');
  return data as Record<string, unknown>;
}

/**
 * Attach the computed `requirements` block to a session row on its way out.
 * Derived (never stored) from mapping + parent_resolutions on every response,
 * so it can't go stale when either is PATCHed.
 */
function sessionOut(row: Record<string, unknown>): z.infer<typeof ImportSession> {
  return {
    ...row,
    requirements: computeRequirements(
      (row.mapping ?? []) as RegionEntityMapping[],
      (row.parent_resolutions ?? null) as Parameters<typeof computeRequirements>[1],
    ),
  } as z.infer<typeof ImportSession>;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---- upload -----------------------------------------------------------------
importsApp.openapi(upload, async (c) => {
  const { accountId } = c.req.valid('param');
  const auth = c.get('auth');
  const sb = getUserClient(auth.accessToken);

  type BodyVal = string | File | undefined;
  const form = (await c.req.parseBody()) as Record<string, BodyVal>;
  const file = form.file;
  if (!file || typeof file === 'string' || !('arrayBuffer' in file)) {
    throw new ApiError(400, 'invalid_request', 'file part missing');
  }
  const filename = ((file as File).name || 'upload').slice(0, 400);
  const ext = extFromFilename(filename);
  if (!ext) throw new ApiError(400, 'invalid_request', 'unsupported file type (expected .xlsx, .xls, or .csv)');
  const size = (file as File).size;
  if (size <= 0 || size > MAX_FILE_BYTES) {
    throw new ApiError(400, 'invalid_request', `file size out of range (${size})`);
  }
  const bytes = new Uint8Array(await (file as File).arrayBuffer());
  const mime = mimeForExt(ext);

  // 1. Create the session up front so even a parse/recognition failure is a
  //    resource the client can inspect and delete.
  const { data: created, error: insErr } = await sb
    .from('import_sessions')
    .insert({ account_id: accountId, status: 'parsing', source_filename: filename, source_mime: mime, source_bytes: size })
    .select('*')
    .single();
  if (insErr || !created) throw new ApiError(500, 'database_error', insErr?.message ?? 'could not create import session');
  const sessionId = (created as { id: string }).id;

  const fail = async (message: string) => {
    await sb
      .from('import_sessions')
      .update({ status: 'failed', error: message, updated_at: new Date().toISOString() })
      .eq('account_id', accountId)
      .eq('id', sessionId);
  };

  try {
    // 2. Archive the raw bytes (service-role; audit artifact).
    const sourcePath = await uploadImportSource(accountId, sessionId, bytes, ext, mime);

    // 3. Parse into regions (no assumptions; empty is valid).
    const { regions } = parseImportFile(Buffer.from(bytes), filename);

    if (regions.length === 0) {
      const { data } = await sb
        .from('import_sessions')
        .update({ source_path: sourcePath, regions: [], status: 'no_importable_data', updated_at: new Date().toISOString() })
        .eq('account_id', accountId)
        .eq('id', sessionId)
        .select('*')
        .single();
      return c.json(sessionOut(data as Record<string, unknown>), 201);
    }

    // 4. Persist full rows to our DB (chunked). Raw values stay here.
    const rowsPayload: { account_id: string; session_id: string; region_index: number; row_index: number; raw: Record<string, string> }[] = [];
    regions.forEach((r, ri) =>
      r.rows.forEach((raw, idx) =>
        rowsPayload.push({ account_id: accountId, session_id: sessionId, region_index: ri, row_index: idx, raw }),
      ),
    );
    for (const part of chunk(rowsPayload, 1000)) {
      const { error } = await sb.from('import_rows').insert(part);
      if (error) throw new ApiError(500, 'database_error', `could not store rows: ${error.message}`);
    }

    // 5. Recognize + suggest mapping (LLM, advisory). Column names + <=5
    //    samples only — never the rows we just stored.
    let recognition: unknown[] = [];
    let mapping: unknown[] = [];
    try {
      const out = await recognizeAndSuggest(regions);
      recognition = out.recognition;
      mapping = out.mapping;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const { data } = await sb
        .from('import_sessions')
        .update({
          source_path: sourcePath,
          regions: regions.map(regionMeta),
          status: 'failed',
          error: `recognition failed: ${msg}`,
          updated_at: new Date().toISOString(),
        })
        .eq('account_id', accountId)
        .eq('id', sessionId)
        .select('*')
        .single();
      return c.json(sessionOut(data as Record<string, unknown>), 201);
    }

    const importable = (recognition as { importable?: boolean }[]).some((r) => r.importable);
    const { data, error: updErr } = await sb
      .from('import_sessions')
      .update({
        source_path: sourcePath,
        regions: regions.map(regionMeta),
        recognition,
        mapping,
        status: importable ? 'awaiting_mapping' : 'no_importable_data',
        updated_at: new Date().toISOString(),
      })
      .eq('account_id', accountId)
      .eq('id', sessionId)
      .select('*')
      .single();
    if (updErr || !data) throw new ApiError(500, 'database_error', updErr?.message ?? 'could not finalize session');
    return c.json(sessionOut(data as Record<string, unknown>), 201);
  } catch (e) {
    const msg = e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e);
    await fail(msg);
    if (e instanceof ApiError) throw e;
    throw new ApiError(500, 'internal_error', msg);
  }
});

// ---- list / get -------------------------------------------------------------
importsApp.openapi(list, async (c) => {
  const { accountId } = c.req.valid('param');
  const { cursor, limit } = c.req.valid('query');
  const sb = getUserClient(c.get('auth').accessToken);

  let query = sb
    .from('import_sessions')
    .select('*')
    .eq('account_id', accountId)
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(limit + 1);

  if (cursor) {
    const cur = decodeCursor(cursor);
    if (cur) {
      query = query.or(`created_at.gt.${cur.created_at},and(created_at.eq.${cur.created_at},id.gt.${cur.id})`);
    }
  }
  const { data, error } = await query;
  if (error) throw new ApiError(500, 'database_error', error.message);
  const rows = data ?? [];
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1] as { created_at?: string; id?: string } | undefined;
  const nextCursor =
    hasMore && last ? encodeCursor({ created_at: String(last.created_at), id: String(last.id) }) : null;
  return c.json({ data: (items as Record<string, unknown>[]).map(sessionOut), next_cursor: nextCursor }, 200);
});

importsApp.openapi(get, async (c) => {
  const { accountId, sessionId } = c.req.valid('param');
  const sb = getUserClient(c.get('auth').accessToken);
  const data = await loadSession(sb, accountId, sessionId);
  return c.json(sessionOut(data as Record<string, unknown>), 200);
});

// ---- mapping / parents ------------------------------------------------------
importsApp.openapi(patchMapping, async (c) => {
  const { accountId, sessionId } = c.req.valid('param');
  const { mapping } = c.req.valid('json');
  const sb = getUserClient(c.get('auth').accessToken);
  await loadSession(sb, accountId, sessionId); // 404 if missing/not a member
  const { data, error } = await sb
    .from('import_sessions')
    .update({ mapping, status: 'awaiting_mapping', updated_at: new Date().toISOString() })
    .eq('account_id', accountId)
    .eq('id', sessionId)
    .is('deleted_at', null)
    .select('*')
    .single();
  if (error || !data) throw new ApiError(500, 'database_error', error?.message ?? 'update failed');
  return c.json(sessionOut(data as Record<string, unknown>), 200);
});

importsApp.openapi(patchParents, async (c) => {
  const { accountId, sessionId } = c.req.valid('param');
  const { parent_resolutions } = c.req.valid('json');
  const sb = getUserClient(c.get('auth').accessToken);
  await loadSession(sb, accountId, sessionId);
  const { data, error } = await sb
    .from('import_sessions')
    .update({ parent_resolutions, updated_at: new Date().toISOString() })
    .eq('account_id', accountId)
    .eq('id', sessionId)
    .is('deleted_at', null)
    .select('*')
    .single();
  if (error || !data) throw new ApiError(500, 'database_error', error?.message ?? 'update failed');
  return c.json(sessionOut(data as Record<string, unknown>), 200);
});

// ---- chat -------------------------------------------------------------------
importsApp.openapi(postChat, async (c) => {
  const { accountId, sessionId } = c.req.valid('param');
  const { message } = c.req.valid('json');
  const sb = getUserClient(c.get('auth').accessToken);
  const session = await loadSession(sb, accountId, sessionId);

  // regionMeta carries columns+samples (no rows); the LLM digest never needs
  // the rows, so reconstruct ParsedRegion-shaped values with empty rows.
  const regionsMeta = (session.regions as Omit<ParsedRegion, 'rows'>[]) ?? [];
  const regions: ParsedRegion[] = regionsMeta.map((m) => ({ ...m, rows: [] }));
  const currentMapping = (session.mapping as Parameters<typeof chat>[1]) ?? [];
  const history = (session.chat as ChatTurn[]) ?? [];

  const result = await chat(regions, currentMapping, history, message);

  const newChat: ChatTurn[] = [
    ...history,
    { role: 'user' as const, content: message },
    { role: 'assistant' as const, content: result.reply },
  ].slice(-40);

  const { data, error } = await sb
    .from('import_sessions')
    .update({ chat: newChat, updated_at: new Date().toISOString() })
    .eq('account_id', accountId)
    .eq('id', sessionId)
    .is('deleted_at', null)
    .select('*')
    .single();
  if (error || !data) throw new ApiError(500, 'database_error', error?.message ?? 'update failed');

  return c.json(
    {
      reply: result.reply,
      proposed_mapping: result.proposed_mapping as z.infer<typeof RegionEntityMappingSchema>[] | null,
      session: sessionOut(data as Record<string, unknown>),
    },
    200,
  );
});

// ---- rows -------------------------------------------------------------------
importsApp.openapi(listRows, async (c) => {
  const { accountId, sessionId } = c.req.valid('param');
  const { cursor, limit } = c.req.valid('query');
  const sb = getUserClient(c.get('auth').accessToken);
  await loadSession(sb, accountId, sessionId);

  // Keyset on (region_index, row_index) so the page order matches the file.
  let pos: { region_index: number; row_index: number } | null = null;
  if (cursor) {
    try {
      const obj = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
      if (obj && typeof obj === 'object' && 'region_index' in obj && 'row_index' in obj) {
        pos = { region_index: Number((obj as Record<string, unknown>).region_index), row_index: Number((obj as Record<string, unknown>).row_index) };
      }
    } catch {
      pos = null;
    }
  }

  let query = sb
    .from('import_rows')
    .select('*')
    .eq('account_id', accountId)
    .eq('session_id', sessionId)
    .order('region_index', { ascending: true })
    .order('row_index', { ascending: true })
    .limit(limit + 1);
  if (pos) {
    query = query.or(
      `region_index.gt.${pos.region_index},and(region_index.eq.${pos.region_index},row_index.gt.${pos.row_index})`,
    );
  }
  const { data, error } = await query;
  if (error) throw new ApiError(500, 'database_error', error.message);
  const rows = data ?? [];
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1] as { region_index?: number; row_index?: number } | undefined;
  const nextCursor =
    hasMore && last
      ? Buffer.from(JSON.stringify({ region_index: last.region_index, row_index: last.row_index })).toString('base64url')
      : null;
  return c.json({ data: items as z.infer<typeof ImportRow>[], next_cursor: nextCursor }, 200);
});

importsApp.openapi(patchRows, async (c) => {
  const { accountId, sessionId } = c.req.valid('param');
  const { updates } = c.req.valid('json');
  const sb = getUserClient(c.get('auth').accessToken);
  await loadSession(sb, accountId, sessionId);

  let updated = 0;
  for (const u of updates) {
    const { data, error } = await sb
      .from('import_rows')
      .update({ excluded: u.excluded, updated_at: new Date().toISOString() })
      .eq('account_id', accountId)
      .eq('session_id', sessionId)
      .eq('id', u.id)
      .select('id')
      .maybeSingle();
    if (error) throw new ApiError(500, 'database_error', error.message);
    if (data) updated += 1;
  }
  return c.json({ updated }, 200);
});

// ---- preview / confirm ------------------------------------------------------
importsApp.openapi(preview, async (c) => {
  const { accountId, sessionId } = c.req.valid('param');
  const sb = getUserClient(c.get('auth').accessToken);
  const session = await loadSession(sb, accountId, sessionId);
  if (((session.mapping as unknown[]) ?? []).length === 0) {
    throw new ApiError(409, 'conflict', 'nothing is mapped to import yet');
  }
  const result = await runImport(sessionId, accountId, true);
  const refreshed = await loadSession(sb, accountId, sessionId);
  return c.json({ result, session: sessionOut(refreshed as Record<string, unknown>) }, 200);
});

importsApp.openapi(confirm, async (c) => {
  const { accountId, sessionId } = c.req.valid('param');
  const sb = getUserClient(c.get('auth').accessToken);
  const session = await loadSession(sb, accountId, sessionId);
  if (((session.mapping as unknown[]) ?? []).length === 0) {
    throw new ApiError(409, 'conflict', 'nothing is mapped to import yet');
  }
  if (session.status === 'done') {
    throw new ApiError(409, 'conflict', 'import already committed');
  }

  // Mark in-flight; the executor sets the terminal status inside its txn.
  await sb
    .from('import_sessions')
    .update({ status: 'importing', updated_at: new Date().toISOString() })
    .eq('account_id', accountId)
    .eq('id', sessionId)
    .is('deleted_at', null);

  let result;
  try {
    result = await runImport(sessionId, accountId, false);
  } catch (e) {
    // A hard error (not a blocker) rolls back the executor txn but leaves the
    // session stuck in 'importing' — surface it as 'failed' so the client can
    // retry rather than spin.
    const msg = e instanceof Error ? e.message : String(e);
    await sb
      .from('import_sessions')
      .update({ status: 'failed', error: msg, updated_at: new Date().toISOString() })
      .eq('account_id', accountId)
      .eq('id', sessionId)
      .is('deleted_at', null);
    throw e;
  }
  const refreshed = await loadSession(sb, accountId, sessionId);
  if (!result.committed) {
    throw new ApiError(
      409,
      'conflict',
      'import has unresolved blockers; resolve them and retry',
      { result, session: sessionOut(refreshed as Record<string, unknown>) },
    );
  }
  return c.json({ result, session: sessionOut(refreshed as Record<string, unknown>) }, 200);
});

// ---- delete -----------------------------------------------------------------
importsApp.openapi(remove, async (c) => {
  const { accountId, sessionId } = c.req.valid('param');
  const sb = getUserClient(c.get('auth').accessToken);
  const { data, error } = await sb
    .from('import_sessions')
    .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('account_id', accountId)
    .eq('id', sessionId)
    .is('deleted_at', null)
    .select('id')
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'import session not found');
  return c.body(null, 204);
});
