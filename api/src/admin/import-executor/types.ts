import type { BlockerCode, EntityType } from '../import-catalog';

export interface ExecutionBlocker {
  scope: 'region' | 'row';
  region_index: number;
  row_index: number | null;
  entity_type: EntityType | null;
  field: string | null;
  /** Stable machine-readable cause; the FE switches on this, never on message. */
  code: BlockerCode;
  message: string;
}

export interface EntityCounts {
  created: number;
  reused: number;
}

export interface ExecutionResult {
  /** True only when a confirm actually wrote rows. */
  committed: boolean;
  dry_run: boolean;
  rows_total: number;
  rows_excluded: number;
  rows_active: number;
  rows_blocked: number;
  rows_imported: number;
  counts: Record<string, EntityCounts>;
  created_ids: Record<string, string[]>;
  blockers: ExecutionBlocker[];
  /** raw->ISO date interpretations (deduped) so a locale misread is visible in
   *  the preview. `ambiguous` flags values like "01/02/2024" that are valid
   *  under both M/D/Y and D/M/Y; the importer reads them as M/D/Y. */
  date_interpretations: {
    field: string;
    raw: string;
    iso: string;
    interpreted_as: string;
    ambiguous: boolean;
  }[];
}

export interface ParentResolutions {
  default_property_id?: string | null;
  property_overrides?: Record<string, { mode: 'existing' | 'create'; id?: string | null }>;
}

export interface RawImportRow {
  id: string;
  region_index: number;
  row_index: number;
  raw: Record<string, string>;
  excluded: boolean;
}
