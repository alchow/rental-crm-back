import * as XLSX from 'xlsx';
import { parse as parseCsvSync } from 'csv-parse/sync';
import { ApiError } from '../routes/_lib/error';

// ----------------------------------------------------------------------------
// File parsing for the onboarding import. Turns an arbitrary Excel/CSV buffer
// into a structured set of REGIONS without assuming anything about the layout.
// "Nothing importable here" is a valid outcome -- an empty `regions` array.
//
// A region is (for v1) one worksheet / the one CSV table: a header row plus its
// data rows. The region abstraction leaves room for future multi-table-per-
// sheet detection without changing the downstream contract.
//
// Privacy boundary lives downstream, not here: this module returns the FULL
// rows (so they can be persisted to import_rows in OUR database). Only the
// per-column `samples` (<=5 values) ever travel to the LLM -- see import-llm.ts.
// ----------------------------------------------------------------------------

export const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MiB
const SAMPLE_LIMIT = 5; // <=5 sample values per column ever leave for the LLM
const MAX_ROWS_PER_REGION = 50_000; // guard against pathological sheets
const MAX_COLUMNS = 200;

export interface ParsedColumn {
  /** Header label (synthesized "Column N" when the header cell is blank). */
  name: string;
  /** Up to SAMPLE_LIMIT distinct, non-empty sample values for the LLM. */
  samples: string[];
}

export interface ParsedRegion {
  sheet: string;
  /** A1-style range, e.g. "A1:F23" (best-effort; informational). */
  range: string;
  columns: ParsedColumn[];
  /** Every data row, keyed by column name. Persisted to import_rows. */
  rows: Record<string, string>[];
  total_rows: number;
  /** True if rows were truncated at MAX_ROWS_PER_REGION. */
  truncated: boolean;
  /**
   * In-memory only (stripped by regionMeta, never persisted): the raw cell
   * matrix and which row was used as the header, kept so the region can be
   * RE-SLICED if recognition advises a different header (banner row above the
   * real header, or no header at all). See resliceRegion.
   */
  matrix?: string[][];
  header_row_index?: number;
}

export interface ParseResult {
  regions: ParsedRegion[];
}

export type ImportExt = 'xlsx' | 'xls' | 'csv';

export function extFromFilename(filename: string): ImportExt | null {
  const m = /\.([a-z0-9]+)$/i.exec(filename.trim());
  if (!m) return null;
  const ext = m[1]!.toLowerCase();
  if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') return ext;
  return null;
}

export function mimeForExt(ext: ImportExt): string {
  switch (ext) {
    case 'xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'xls':  return 'application/vnd.ms-excel';
    case 'csv':  return 'text/csv';
  }
}

/**
 * Parse an uploaded spreadsheet/CSV into regions. Throws ApiError(400) for
 * oversize input or an unparseable file; returns `{ regions: [] }` when the
 * file parsed fine but held nothing tabular.
 */
export function parseImportFile(buffer: Buffer, filename: string): ParseResult {
  if (buffer.byteLength === 0) {
    throw new ApiError(400, 'invalid_request', 'empty upload');
  }
  if (buffer.byteLength > MAX_FILE_BYTES) {
    throw new ApiError(
      400,
      'invalid_request',
      `file exceeds max size (${buffer.byteLength} > ${MAX_FILE_BYTES} bytes)`,
    );
  }
  const ext = extFromFilename(filename);
  if (!ext) {
    throw new ApiError(400, 'invalid_request', 'unsupported file type (expected .xlsx, .xls, or .csv)');
  }

  if (ext === 'csv') {
    return { regions: parseCsv(buffer) };
  }
  return { regions: parseWorkbook(buffer) };
}

// ----- CSV -------------------------------------------------------------------

function parseCsv(buffer: Buffer): ParsedRegion[] {
  let records: string[][];
  try {
    records = parseCsvSync(buffer, {
      bom: true,
      relax_column_count: true,
      skip_empty_lines: true,
      trim: true,
    }) as string[][];
  } catch (e) {
    throw new ApiError(400, 'invalid_request', `could not parse CSV: ${e instanceof Error ? e.message : String(e)}`);
  }
  const region = regionFromMatrix('Sheet1', records);
  return region ? [region] : [];
}

// ----- XLSX / XLS ------------------------------------------------------------

function parseWorkbook(buffer: Buffer): ParsedRegion[] {
  let wb: XLSX.WorkBook;
  try {
    // Deliberately NOT cellDates:true. We read each cell's DISPLAYED text via
    // raw:false (below), i.e. exactly what the user sees in Excel. cellDates
    // converts date serials to JS Dates, which introduces the well-known
    // UTC/local off-by-one (a "2024-02-01" cell rendering as "1/31/24"). The
    // executor's coerceDate handles the displayed strings (ISO + US formats).
    wb = XLSX.read(buffer, { type: 'buffer' });
  } catch (e) {
    throw new ApiError(400, 'invalid_request', `could not parse spreadsheet: ${e instanceof Error ? e.message : String(e)}`);
  }
  const regions: ParsedRegion[] = [];
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(ws, {
      header: 1,
      blankrows: false,
      defval: '',
      raw: false,
    }) as unknown[][];
    const cells = matrix.map((row) => row.map((c) => cellToString(c)));
    const region = regionFromMatrix(sheetName, cells, ws['!ref']);
    if (region) regions.push(region);
  }
  return regions;
}

// ----- shared matrix -> region ----------------------------------------------

function cellToString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    // Normalize to ISO date (drop time) — rent rolls carry dates, not instants.
    return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  }
  return String(v).trim();
}

/**
 * Build a region from a matrix of stringified cells. By default the first
 * non-empty row is the header and the rest is data; `header` overrides that
 * default when recognition advises otherwise:
 *   - { present: true, row_offset: N }  header is N rows BELOW the first
 *     non-empty row (banner/title rows above the real header)
 *   - { present: false }                no header at all: every row from the
 *     first non-empty one is data; column names are synthesized "Column N"
 * Returns null if there's no usable header/data.
 */
function regionFromMatrix(
  sheet: string,
  matrix: string[][],
  ref?: string,
  header: { present: boolean; row_offset: number } = { present: true, row_offset: 0 },
): ParsedRegion | null {
  // Find the first row with at least one non-empty cell.
  let firstIdx = -1;
  for (let i = 0; i < matrix.length; i++) {
    if ((matrix[i] ?? []).some((c) => c !== '')) {
      firstIdx = i;
      break;
    }
  }
  if (firstIdx === -1) return null;

  let headerIdx: number;
  let columns: string[];
  let dataStart: number;
  if (header.present) {
    headerIdx = firstIdx + Math.max(0, header.row_offset);
    const headerCells = matrix[headerIdx] ?? [];
    columns = normalizeHeaders(headerCells).slice(0, MAX_COLUMNS);
    dataStart = headerIdx + 1;
  } else {
    // Headerless: synthesize names wide enough for the widest data row.
    headerIdx = firstIdx;
    const width = Math.min(MAX_COLUMNS, Math.max(...matrix.slice(firstIdx).map((r) => (r ?? []).length), 0));
    columns = normalizeHeaders(new Array<string>(width).fill(''));
    dataStart = firstIdx; // the first row is DATA, not a header
  }
  if (columns.length === 0) return null;

  const dataRows: Record<string, string>[] = [];
  let truncated = false;
  for (let i = dataStart; i < matrix.length; i++) {
    const cells = matrix[i] ?? [];
    if (!cells.some((c) => c !== '')) continue; // skip fully-blank rows
    if (dataRows.length >= MAX_ROWS_PER_REGION) {
      truncated = true;
      break;
    }
    const row: Record<string, string> = {};
    for (let c = 0; c < columns.length; c++) {
      row[columns[c]!] = (cells[c] ?? '').toString();
    }
    dataRows.push(row);
  }
  if (dataRows.length === 0) return null;

  const cols: ParsedColumn[] = columns.map((name) => ({
    name,
    samples: collectSamples(dataRows, name),
  }));

  return {
    sheet,
    range: ref ?? `A1:${colLetter(columns.length)}${dataRows.length + 1}`,
    columns: cols,
    rows: dataRows,
    total_rows: dataRows.length,
    truncated,
    matrix,
    header_row_index: headerIdx,
  };
}

/**
 * Re-slice a region per recognition's header advice. `row_index` is the index
 * within the digest's `first_rows` (offset from the originally-assumed header
 * row). Returns null when the region has no retained matrix, the advice is the
 * identity (nothing to change), or re-slicing yields no usable data -- callers
 * keep the original region in all three cases.
 */
export function resliceRegion(
  region: ParsedRegion,
  advice: { present: boolean; row_index: number },
): ParsedRegion | null {
  if (!region.matrix) return null;
  if (advice.present && advice.row_index === 0) return null; // identity
  return regionFromMatrix(region.sheet, region.matrix, region.range, {
    present: advice.present,
    row_offset: advice.row_index,
  });
}

/** Turn raw header cells into unique, non-empty column names. */
function normalizeHeaders(cells: string[]): string[] {
  const out: string[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i < cells.length; i++) {
    let base = (cells[i] ?? '').trim();
    if (base === '') base = `Column ${i + 1}`;
    let name = base;
    const prior = seen.get(base);
    if (prior !== undefined) {
      const n = prior + 1;
      seen.set(base, n);
      name = `${base} (${n})`;
    } else {
      seen.set(base, 1);
    }
    out.push(name);
  }
  return out;
}

function collectSamples(rows: Record<string, string>[], col: string): string[] {
  const seen = new Set<string>();
  const samples: string[] = [];
  for (const r of rows) {
    const v = (r[col] ?? '').trim();
    if (v === '' || seen.has(v)) continue;
    seen.add(v);
    samples.push(v.length > 120 ? v.slice(0, 117) + '…' : v);
    if (samples.length >= SAMPLE_LIMIT) break;
  }
  return samples;
}

function colLetter(n: number): string {
  // 1 -> A, 26 -> Z, 27 -> AA …
  let s = '';
  let x = n;
  while (x > 0) {
    const rem = (x - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s || 'A';
}

/** Rows/cell caps for the digest's first_rows (header-detection context). */
const FIRST_ROWS_LIMIT = 5;
const FIRST_ROWS_CELL_CHARS = 120;

/**
 * The slim, privacy-bounded view of a region sent to the LLM: column names, a
 * handful of samples per column, the row count, and the first few raw rows
 * starting at the assumed header (so recognition can advise when the header
 * assumption is wrong -- banner row above the real header, or headerless
 * data). Bounded to FIRST_ROWS_LIMIT rows x MAX_COLUMNS cells x
 * FIRST_ROWS_CELL_CHARS chars; the full row set never leaves our DB.
 */
export function regionDigest(region: ParsedRegion, index: number): {
  region_index: number;
  sheet: string;
  total_rows: number;
  columns: { name: string; samples: string[] }[];
  first_rows: string[][];
} {
  const start = region.header_row_index ?? 0;
  const first_rows = (region.matrix ?? [])
    .slice(start, start + FIRST_ROWS_LIMIT)
    .map((r) => r.slice(0, MAX_COLUMNS).map((c) => c.slice(0, FIRST_ROWS_CELL_CHARS)));
  return {
    region_index: index,
    sheet: region.sheet,
    total_rows: region.total_rows,
    columns: region.columns.map((c) => ({ name: c.name, samples: c.samples })),
    first_rows,
  };
}

/** Region metadata persisted to import_sessions.regions (no full rows, and no
 *  in-memory matrix/header bookkeeping). */
export function regionMeta(
  region: ParsedRegion,
): Omit<ParsedRegion, 'rows' | 'matrix' | 'header_row_index'> {
  const { rows: _rows, matrix: _matrix, header_row_index: _hdr, ...meta } = region;
  void _rows; void _matrix; void _hdr;
  return meta;
}
