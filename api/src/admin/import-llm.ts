import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { loadEnv } from '../env';
import { ApiError } from '../routes/_lib/error';
import {
  ENTITY_CATALOG,
  ENTITY_ORDER,
  MIN_CONFIDENCE,
  type EntityType,
  type RecognitionResult,
  type RegionEntityMapping,
  type FieldMapping,
} from './import-catalog';
import { regionDigest, resliceRegion, type ParsedRegion } from './import-parser';

// ----------------------------------------------------------------------------
// The LLM half of the import pipeline. STRICTLY advisory: it only proposes a
// recognition + a column->field mapping. The deterministic executor
// (import-executor.ts) is the sole write path; the model is NEVER in it.
//
// Privacy: every request sends ONLY column names + <=5 sample values per
// column, the first <=5 raw rows per region (bounded; for header detection),
// and aggregate row counts (via regionDigest). The full row set never leaves
// our process.
//
// Model + knobs follow the Anthropic guidance for Opus 4.8: structured
// extraction goes through forced tool-use; the conversational `chat` turn uses
// adaptive thinking. No temperature/top_p (removed on 4.8).
// ----------------------------------------------------------------------------

const MODEL = 'claude-opus-4-8';

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (client) return client;
  const key = loadEnv().ANTHROPIC_API_KEY;
  if (!key) {
    throw new ApiError(
      502,
      'internal_error',
      'onboarding import is not configured: ANTHROPIC_API_KEY is unset',
    );
  }
  client = new Anthropic({ apiKey: key });
  return client;
}

// --- test seam ---------------------------------------------------------------
// Lets integration tests inject canned tool-use responses so the full pipeline
// (recognize -> map -> resolve -> preview -> confirm) and every decline/blocker
// branch are deterministically CI-tested with NO Anthropic key. import-llm's
// own validation/filtering still runs over the canned input. Never used in any
// production path.
export interface FakeAnthropic {
  messages: { create: (params: Record<string, unknown>) => Promise<{ content: unknown[] }> };
}
let testClient: FakeAnthropic | null = null;
export function __setAnthropicForTests(c: FakeAnthropic | null): void {
  testClient = c;
  client = null;
}

// Casting helper: the request surface (thinking, output_config) is wider than
// the pinned SDK's static param type in places; build the object freely and
// hand it to the SDK as its param type. Keeps us off `any`.
type CreateParams = Record<string, unknown>;
async function createMessage(params: CreateParams): Promise<Anthropic.Messages.Message> {
  if (testClient) {
    const r = await testClient.messages.create(params as Record<string, unknown>);
    return r as unknown as Anthropic.Messages.Message;
  }
  return getClient().messages.create(
    params as unknown as Anthropic.Messages.MessageCreateParamsNonStreaming,
  );
}

function textOf(msg: Anthropic.Messages.Message): string {
  return msg.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

function toolInput(msg: Anthropic.Messages.Message, name: string): unknown | null {
  for (const b of msg.content) {
    if (b.type === 'tool_use' && b.name === name) return b.input;
  }
  return null;
}

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);

// ----- entity catalog rendered for the prompt -------------------------------

function catalogForPrompt(): string {
  return ENTITY_ORDER.map((et) => {
    const spec = ENTITY_CATALOG[et];
    const fields = spec.fields
      .map((f) => `      - ${f.field}${f.required ? ' (required)' : ''}: ${f.description}`)
      .join('\n');
    return `  • ${et} — ${spec.description}\n    fields:\n${fields}`;
  }).join('\n');
}

const SCOPE_NOTE =
  'Scope: property, area (a rentable unit or a shared/common space; kind defaults to "unit"), ' +
  'unit_details, tenant, tenancy, tenancy_member, lease (optional), rent_schedule, and ' +
  'interaction (a free-text note/comment/log column; one entry per non-empty cell). ' +
  'Money history (individual charges and payments) is OUT OF SCOPE and must never be ' +
  'proposed. rent_schedule captures the recurring rent amount, which is structural, not a charge.';

// ============================================================================
// 1. Recognition — what entities does each region contain?
// ============================================================================

const zEntity = z.enum(ENTITY_ORDER);

// Validation is SALVAGE, not all-or-nothing: the outer shape must hold, but a
// single bad region (or a single bad entity_types entry) is dropped with a log
// line instead of failing the whole recognition. A hallucinated enum value in
// one entry must not kill the import -- that exact failure shipped to prod as
// "recognition: malformed LLM response" on an otherwise-fine response.
const RecognitionOuter = z.object({ regions: z.array(z.unknown()).default([]) });
const IDENTITY_HEADER = { present: true, row_index: 0 } as const;
const RecognitionRegion = z.object({
  region_index: z.number().int().nonnegative(),
  importable: z.boolean(),
  summary: z.string().default(''),
  entity_types: z.array(z.unknown()).default([]),
  // Header advice; malformed or missing degrades to the identity (keep the
  // parser's first-non-empty-row assumption) rather than dropping the region.
  header: z
    .object({ present: z.boolean(), row_index: z.number().int().nonnegative() })
    .catch({ ...IDENTITY_HEADER }),
});
const RecognitionEntity = z.object({
  entity_type: zEntity,
  confidence: z.number(),
});

// strict: true makes the API enforce the schema (incl. the entity enum) at
// generation time instead of merely guiding the model with it. Strict mode
// requires additionalProperties: false on every object.
const recognitionTool = {
  name: 'report_recognition',
  description:
    'Report, for every region, whether it holds importable structural data and which entity types its columns map to.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      regions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            region_index: { type: 'integer' },
            importable: {
              type: 'boolean',
              description: 'True if at least one in-scope entity can be built from this region.',
            },
            summary: { type: 'string', description: 'One sentence on what this region appears to be.' },
            header: {
              type: 'object',
              description:
                'Header verdict for first_rows. Row 0 of first_rows is the row currently ASSUMED to be the header.',
              properties: {
                present: {
                  type: 'boolean',
                  description: 'False when the sheet has no header row at all (row 0 of first_rows is already data).',
                },
                row_index: {
                  type: 'integer',
                  description:
                    '0-based index into first_rows of the REAL header row. 0 when the assumption is correct; >0 when title/banner rows sit above the real header. Ignored when present=false.',
                },
              },
              required: ['present', 'row_index'],
              additionalProperties: false,
            },
            entity_types: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  entity_type: { type: 'string', enum: ENTITY_ORDER },
                  confidence: { type: 'number', description: '0..1' },
                },
                required: ['entity_type', 'confidence'],
                additionalProperties: false,
              },
            },
          },
          required: ['region_index', 'importable', 'summary', 'header', 'entity_types'],
          additionalProperties: false,
        },
      },
    },
    required: ['regions'],
    additionalProperties: false,
  },
};

export async function recognizeRegions(regions: ParsedRegion[]): Promise<RecognitionResult[]> {
  if (regions.length === 0) return [];
  const digests = regions.map((r, i) => regionDigest(r, i));

  // Two attempts: strict mode makes a malformed response rare, but a response
  // truncated at max_tokens (or any other transient deviation) can still lose
  // the tool block. The model is stochastic, so one retry is cheap insurance.
  let lastFailure = 'no attempt made';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const msg = await createMessage({
      model: MODEL,
      max_tokens: 4096,
      output_config: { effort: 'high' },
      system:
        'You classify columns of a landlord/property spreadsheet against a fixed schema. ' +
        SCOPE_NOTE +
        ' You are advisory only — a deterministic engine does the importing. ' +
        'SALVAGE structural data from ANY row-per-record sheet, even an operational or status ' +
        'tracker: a region is importable if at least one column can populate the required fields ' +
        'of at least one entity. A column of unit/area labels alone is importable as area. ' +
        'Mark importable=false only when NO column can populate any in-scope entity — e.g. pure ' +
        'totals, legends, or prose. ' +
        'HEADER CHECK: each digest includes first_rows, the first raw rows as parsed; row 0 is ' +
        'the row currently ASSUMED to be the header (it produced the column names). Verify that ' +
        'assumption. If the column names look like data values (person names, unit labels, dates, ' +
        'amounts) and resemble the rows below, the sheet is headerless: report ' +
        'header={present:false,row_index:0}. If a title/banner row sits above the real header, ' +
        'report header={present:true,row_index:N} pointing at the real header row within ' +
        'first_rows. Otherwise report header={present:true,row_index:0}. Classify entity types ' +
        'per the CORRECTED reading.',
      tools: [recognitionTool],
      tool_choice: { type: 'tool', name: 'report_recognition' },
      messages: [
        {
          role: 'user',
          content:
            `Target schema:\n${catalogForPrompt()}\n\n` +
            `Regions (column names + up to 5 samples per column + first_rows for the header check):\n` +
            JSON.stringify(digests, null, 2) +
            `\n\nCall report_recognition for ALL ${regions.length} region(s).`,
        },
      ],
    });

    const raw = toolInput(msg, 'report_recognition');
    const outer = RecognitionOuter.safeParse(raw);
    if (!outer.success) {
      // Log enough to root-cause from prod: stop_reason distinguishes a
      // max_tokens truncation from a schema deviation. The raw input is
      // model-generated (entity types + one-line summaries) -- no row data.
      const stopReason = (msg as { stop_reason?: string }).stop_reason ?? 'unknown';
      lastFailure =
        `attempt ${attempt}: stop_reason=${stopReason} ` +
        `issues=${JSON.stringify(outer.error.issues)} ` +
        `raw=${JSON.stringify(raw)?.slice(0, 2000) ?? 'null'}`;
      console.error(`[import-llm] recognition: malformed response (${lastFailure})`);
      continue;
    }

    // Index by region so we always return one result per input region.
    // Salvage granularity: drop a bad region entry, drop a bad entity entry --
    // never the whole response.
    const byRegion = new Map<number, RecognitionResult>();
    for (const rawRegion of outer.data.regions) {
      const parsedRegion = RecognitionRegion.safeParse(rawRegion);
      if (!parsedRegion.success) {
        console.error(
          `[import-llm] recognition: dropping malformed region entry ` +
            `issues=${JSON.stringify(parsedRegion.error.issues)} raw=${JSON.stringify(rawRegion)?.slice(0, 500)}`,
        );
        continue;
      }
      const r = parsedRegion.data;
      if (r.region_index < 0 || r.region_index >= regions.length) continue;
      const entity_types = r.entity_types
        .flatMap((rawEntity) => {
          const e = RecognitionEntity.safeParse(rawEntity);
          if (!e.success) {
            console.error(
              `[import-llm] recognition: dropping malformed entity entry ` +
                `raw=${JSON.stringify(rawEntity)?.slice(0, 200)}`,
            );
            return [];
          }
          return [{ entity_type: e.data.entity_type, confidence: clamp01(e.data.confidence) }];
        })
        .filter((e) => e.confidence >= MIN_CONFIDENCE)
        .sort((a, b) => b.confidence - a.confidence);
      byRegion.set(r.region_index, {
        region_index: r.region_index,
        importable: r.importable && entity_types.length > 0,
        entity_types,
        summary: r.summary,
        header: { present: r.header.present, row_index: Math.max(0, r.header.row_index) },
      });
    }
    return regions.map(
      (_r, i) =>
        byRegion.get(i) ?? {
          region_index: i,
          importable: false,
          entity_types: [],
          summary: 'Not recognized as importable structural data.',
          header: { ...IDENTITY_HEADER },
        },
    );
  }

  throw new ApiError(502, 'internal_error', `recognition: malformed LLM response (${lastFailure})`);
}

// ============================================================================
// 2. Mapping — for one (region, entity), map each target field to a column.
// ============================================================================

function mappingTool(entityType: EntityType) {
  const fieldNames = ENTITY_CATALOG[entityType].fields.map((f) => f.field);
  return {
    name: 'report_mapping',
    description: `Map each ${entityType} target field to a source column (or a constant, or leave unmapped).`,
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              target_field: { type: 'string', enum: fieldNames },
              source_column: {
                type: ['string', 'null'],
                description: 'Exact source column name to read this field from, or null.',
              },
              constant: {
                type: ['string', 'null'],
                description: 'A literal value to use for every row instead of a column, or null.',
              },
              confidence: { type: 'number', description: '0..1' },
            },
            required: ['target_field', 'source_column', 'constant', 'confidence'],
            additionalProperties: false,
          },
        },
      },
      required: ['fields'],
      additionalProperties: false,
    },
  };
}

const MappingInput = z.object({
  fields: z
    .array(
      z.object({
        target_field: z.string(),
        source_column: z.string().nullable().optional(),
        constant: z.string().nullable().optional(),
        confidence: z.number().optional(),
      }),
    )
    .default([]),
});

export async function suggestMapping(
  region: ParsedRegion,
  entityType: EntityType,
  regionIndex: number,
): Promise<RegionEntityMapping> {
  const spec = ENTITY_CATALOG[entityType];
  const digest = regionDigest(region, regionIndex);
  const validFields = new Set(spec.fields.map((f) => f.field));

  const msg = await createMessage({
    model: MODEL,
    max_tokens: 4096,
    output_config: { effort: 'high' },
    system:
      'You align spreadsheet columns to a fixed target schema for a landlord CRM import. ' +
      SCOPE_NOTE +
      ' Map a field only when a column clearly supplies it; otherwise leave source_column null. ' +
      'Never invent data. Prefer an exact column over a constant. Use a constant only for an ' +
      'obvious fixed value (e.g. a single currency for the whole sheet).',
    tools: [mappingTool(entityType)],
    tool_choice: { type: 'tool', name: 'report_mapping' },
    messages: [
      {
        role: 'user',
        content:
          `Entity: ${entityType} — ${spec.description}\n` +
          `Target fields:\n` +
          spec.fields
            .map((f) => `  - ${f.field}${f.required ? ' (required)' : ''}: ${f.description}`)
            .join('\n') +
          `\n\nSource region (columns + up to 5 samples each):\n` +
          JSON.stringify(digest, null, 2) +
          `\n\nCall report_mapping with one entry per target field you can confidently map.`,
      },
    ],
  });

  const rawMapping = toolInput(msg, 'report_mapping');
  const parsed = MappingInput.safeParse(rawMapping);
  const columnNames = new Set(region.columns.map((c) => c.name));
  const fields: FieldMapping[] = [];
  if (!parsed.success) {
    // Degrades to an empty mapping (user maps manually) -- but leave a trace.
    console.error(
      `[import-llm] mapping(${entityType}): malformed response ` +
        `issues=${JSON.stringify(parsed.error.issues)} raw=${JSON.stringify(rawMapping)?.slice(0, 1000) ?? 'null'}`,
    );
  }
  if (parsed.success) {
    for (const f of parsed.data.fields) {
      if (!validFields.has(f.target_field)) continue;
      // Drop hallucinated columns: a mapping must reference a real column.
      const source_column = f.source_column && columnNames.has(f.source_column) ? f.source_column : null;
      const constant = f.constant ?? null;
      if (!source_column && (constant === null || constant === '')) continue;
      const confidence = clamp01(f.confidence ?? 0);
      // Leave a low-confidence COLUMN guess unmapped rather than guessing -- the
      // user maps it explicitly (a required field left unmapped surfaces as a
      // blocker in preview). Constants are deliberate, so they're kept.
      if (source_column && confidence < MIN_CONFIDENCE) continue;
      fields.push({
        target_field: f.target_field,
        source_column,
        constant: source_column ? null : constant,
        confidence,
      });
    }
  }
  return { region_index: regionIndex, entity_type: entityType, fields };
}

/**
 * Convenience used by the upload route: recognize, then for every region's
 * recognized entity types (>= MIN_CONFIDENCE) produce a suggested mapping.
 */
export async function recognizeAndSuggest(
  regions: ParsedRegion[],
): Promise<{ regions: ParsedRegion[]; recognition: RecognitionResult[]; mapping: RegionEntityMapping[] }> {
  let working = regions;
  let recognition = await recognizeRegions(working);

  // Header advice: re-slice the affected regions deterministically and run
  // recognition ONCE more on the corrected digests. Bounded to a single pass
  // (second-pass advice is forced to identity) so a flip-flopping model can't
  // loop us; a region that re-slices to nothing keeps its original slice.
  const wantsReslice = recognition.some((r) => !(r.header.present && r.header.row_index === 0));
  if (wantsReslice) {
    let changed = false;
    working = working.map((region, i) => {
      const resliced = resliceRegion(region, recognition[i]!.header);
      if (resliced) changed = true;
      return resliced ?? region;
    });
    if (changed) {
      recognition = (await recognizeRegions(working)).map((r) => ({
        ...r,
        header: { present: true, row_index: 0 },
      }));
    }
  }

  const mapping: RegionEntityMapping[] = [];
  for (const rec of recognition) {
    if (!rec.importable) continue;
    const region = working[rec.region_index];
    if (!region) continue;
    // Order entities topologically so the stored mapping reads naturally.
    const wanted = ENTITY_ORDER.filter((et) => rec.entity_types.some((e) => e.entity_type === et));
    for (const et of wanted) {
      mapping.push(await suggestMapping(region, et, rec.region_index));
    }
  }
  return { regions: working, recognition, mapping };
}

// ============================================================================
// 3. Chat — conversational refinement. May talk, and may propose a mapping
//    revision the user can accept via PATCH /mapping.
// ============================================================================

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

const proposeMappingTool = {
  name: 'propose_mapping',
  description:
    'Propose a revised mapping for one or more (region, entity) pairs. The user reviews and accepts it separately.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      mapping: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            region_index: { type: 'integer' },
            entity_type: { type: 'string', enum: ENTITY_ORDER },
            fields: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  target_field: { type: 'string' },
                  source_column: { type: ['string', 'null'] },
                  constant: { type: ['string', 'null'] },
                  confidence: { type: 'number' },
                },
                required: ['target_field', 'source_column', 'constant', 'confidence'],
                additionalProperties: false,
              },
            },
          },
          required: ['region_index', 'entity_type', 'fields'],
          additionalProperties: false,
        },
      },
    },
    required: ['mapping'],
    additionalProperties: false,
  },
};

const ProposeInput = z.object({
  mapping: z
    .array(
      z.object({
        region_index: z.number().int().nonnegative(),
        entity_type: zEntity,
        fields: z
          .array(
            z.object({
              target_field: z.string(),
              source_column: z.string().nullable().optional(),
              constant: z.string().nullable().optional(),
              confidence: z.number().optional(),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
});

export interface ChatResult {
  reply: string;
  proposed_mapping: RegionEntityMapping[] | null;
}

export async function chat(
  regions: ParsedRegion[],
  currentMapping: RegionEntityMapping[],
  history: ChatTurn[],
  userMessage: string,
): Promise<ChatResult> {
  const digests = regions.map((r, i) => regionDigest(r, i));
  const priorTurns: Anthropic.Messages.MessageParam[] = history
    .slice(-12)
    .map((t) => ({ role: t.role, content: t.content }));

  const msg = await createMessage({
    model: MODEL,
    max_tokens: 4096,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
    system:
      'You help a landlord map an uploaded spreadsheet to a fixed import schema. ' +
      SCOPE_NOTE +
      ' You may answer questions and, when the user asks for a change, call propose_mapping with ' +
      'a revised mapping. Only reference columns that exist. Never fabricate data. ' +
      `Target schema:\n${catalogForPrompt()}\n\n` +
      `Regions (columns + <=5 samples; rows withheld):\n${JSON.stringify(digests)}\n\n` +
      `Current mapping:\n${JSON.stringify(currentMapping)}`,
    tools: [proposeMappingTool],
    tool_choice: { type: 'auto' },
    messages: [...priorTurns, { role: 'user', content: userMessage }],
  });

  let proposed: RegionEntityMapping[] | null = null;
  const raw = toolInput(msg, 'propose_mapping');
  if (raw !== null) {
    const parsed = ProposeInput.safeParse(raw);
    if (parsed.success) {
      proposed = parsed.data.mapping.map((m) => ({
        region_index: m.region_index,
        entity_type: m.entity_type,
        fields: m.fields.map((f) => ({
          target_field: f.target_field,
          source_column: f.source_column ?? null,
          constant: f.constant ?? null,
          confidence: clamp01(f.confidence ?? 1),
        })),
      }));
    }
  }

  const reply = textOf(msg) || (proposed ? 'I proposed a revised mapping for your review.' : '');
  return { reply, proposed_mapping: proposed };
}
