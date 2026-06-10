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
 * Build a region from a matrix of stringified cells: find the first non-empty
 * row as the header, treat the rest as data. Returns null if there's no header
 * or no data rows.
 */
function regionFromMatrix(sheet: string, matrix: string[][], ref?: string): ParsedRegion | null {
  // Find the header: the first row with at least one non-empty cell.
  let headerIdx = -1;
  for (let i = 0; i < matrix.length; i++) {
    if ((matrix[i] ?? []).some((c) => c !== '')) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return null;

  const headerCells = matrix[headerIdx] ?? [];
  const columns = normalizeHeaders(headerCells).slice(0, MAX_COLUMNS);
  if (columns.length === 0) return null;

  const dataRows: Record<string, string>[] = [];
  let truncated = false;
  for (let i = headerIdx + 1; i < matrix.length; i++) {
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
  };
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

/**
 * The slim, privacy-safe view of a region sent to the LLM: column names + a
 * handful of samples + the row count. NEVER the rows themselves.
 */
export function regionDigest(region: ParsedRegion, index: number): {
  region_index: number;
  sheet: string;
  total_rows: number;
  columns: { name: string; samples: string[] }[];
} {
  return {
    region_index: index,
    sheet: region.sheet,
    total_rows: region.total_rows,
    columns: region.columns.map((c) => ({ name: c.name, samples: c.samples })),
  };
}

/** Region metadata persisted to import_sessions.regions (no full rows). */
export function regionMeta(region: ParsedRegion): Omit<ParsedRegion, 'rows'> {
  const { rows: _rows, ...meta } = region;
  void _rows;
  return meta;
}
