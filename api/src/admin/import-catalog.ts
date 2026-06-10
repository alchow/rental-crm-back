// ----------------------------------------------------------------------------
// Onboarding-import target catalog: the SHARED vocabulary the LLM proposes
// against and the deterministic executor writes against. Defining it once here
// keeps the two halves of the pipeline in lockstep -- the model can only
// suggest a target that the executor knows how to coerce + insert, and the
// executor never has to guess what a mapped field means.
//
// Phase 1 scope is structural only:
//   property -> area(kind=unit) -> unit_details -> tenant -> tenancy ->
//   tenancy_member -> lease (optional) -> rent_schedule
// Money (charges/payments) is Phase 2 and deliberately ABSENT from this
// catalog so it cannot be imported by accident.
// ----------------------------------------------------------------------------

export type EntityType =
  | 'property'
  | 'area'
  | 'unit_details'
  | 'tenant'
  | 'tenancy'
  | 'tenancy_member'
  | 'lease'
  | 'rent_schedule';

// Topological order: a parent always precedes anything that references it.
// The executor resolves/creates entities per row in exactly this order.
export const ENTITY_ORDER: EntityType[] = [
  'property',
  'area',
  'unit_details',
  'tenant',
  'tenancy',
  'tenancy_member',
  'lease',
  'rent_schedule',
];

export type FieldType =
  | 'string'
  | 'date'
  | 'int'
  | 'decimal'
  | 'money' // a currency-ish amount; coerced to integer minor units (cents)
  | 'currency'; // a 3-letter ISO code or a symbol we can normalize

export interface FieldSpec {
  field: string;
  label: string;
  type: FieldType;
  required: boolean;
  description: string;
}

export interface EntitySpec {
  entity_type: EntityType;
  label: string;
  description: string;
  fields: FieldSpec[];
}

export const ENTITY_CATALOG: Record<EntityType, EntitySpec> = {
  property: {
    entity_type: 'property',
    label: 'Property',
    description: 'A building or parcel the landlord manages.',
    fields: [
      { field: 'name', label: 'Property name', type: 'string', required: true, description: 'Building/property name or street address used as its label.' },
      { field: 'address_line1', label: 'Address line 1', type: 'string', required: false, description: 'Street address line 1.' },
      { field: 'address_line2', label: 'Address line 2', type: 'string', required: false, description: 'Unit/suite/floor line, if separate from the unit number.' },
      { field: 'address_city', label: 'City', type: 'string', required: false, description: 'City.' },
      { field: 'address_state', label: 'State/region', type: 'string', required: false, description: 'State, province, or region.' },
      { field: 'address_zip', label: 'Postal code', type: 'string', required: false, description: 'ZIP / postal code.' },
    ],
  },
  area: {
    entity_type: 'area',
    label: 'Unit / common area',
    description: 'A rentable unit or a shared/common space within a property.',
    fields: [
      { field: 'name', label: 'Area label', type: 'string', required: true, description: 'Unit number/label or area name, e.g. "1A", "Apt 203", "Front lawn", "Laundry room".' },
      {
        field: 'kind',
        label: 'Area kind',
        type: 'string',
        required: false,
        description:
          'What the area is. One of: "unit", "entrance", "hallway", "stairwell", "basement_mechanical", ' +
          '"laundry", "parking", "roof", "exterior_grounds", "common_other". Defaults to "unit" when unmapped. ' +
          'Use a constant when every row in the region is the same kind.',
      },
    ],
  },
  unit_details: {
    entity_type: 'unit_details',
    label: 'Unit details',
    description: 'Optional physical attributes of a unit.',
    fields: [
      { field: 'bedrooms', label: 'Bedrooms', type: 'int', required: false, description: 'Number of bedrooms.' },
      { field: 'bathrooms', label: 'Bathrooms', type: 'decimal', required: false, description: 'Number of bathrooms (may be fractional, e.g. 1.5).' },
      { field: 'sqft', label: 'Square feet', type: 'int', required: false, description: 'Interior area in square feet.' },
    ],
  },
  tenant: {
    entity_type: 'tenant',
    label: 'Tenant',
    description: 'A person on the tenancy.',
    fields: [
      { field: 'full_name', label: 'Full name', type: 'string', required: true, description: "Tenant's full name." },
      { field: 'email', label: 'Email', type: 'string', required: false, description: 'Primary email address.' },
      { field: 'phone', label: 'Phone', type: 'string', required: false, description: 'Primary phone number.' },
    ],
  },
  tenancy: {
    entity_type: 'tenancy',
    label: 'Tenancy',
    description: 'An occupancy of a unit over a date range.',
    fields: [
      { field: 'start_date', label: 'Start date', type: 'date', required: true, description: 'Move-in / lease start date.' },
      { field: 'end_date', label: 'End date', type: 'date', required: false, description: 'Move-out / lease end date, if any.' },
    ],
  },
  tenancy_member: {
    entity_type: 'tenancy_member',
    label: 'Tenancy member',
    description: 'Links a tenant to a tenancy with a role.',
    fields: [
      { field: 'role', label: 'Role', type: 'string', required: false, description: "One of 'primary', 'occupant', 'guarantor'. Defaults to 'primary'." },
    ],
  },
  lease: {
    entity_type: 'lease',
    label: 'Lease',
    description: 'An optional lease document/term for a tenancy.',
    fields: [
      { field: 'term_start', label: 'Lease term start', type: 'date', required: false, description: 'Lease term start date.' },
      { field: 'term_end', label: 'Lease term end', type: 'date', required: false, description: 'Lease term end date.' },
      { field: 'rent_amount', label: 'Lease rent', type: 'money', required: false, description: 'Contractual rent amount on the lease.' },
      { field: 'rent_currency', label: 'Lease rent currency', type: 'currency', required: false, description: '3-letter currency code; defaults to USD.' },
      { field: 'deposit_amount', label: 'Security deposit', type: 'money', required: false, description: 'Security deposit amount held.' },
    ],
  },
  rent_schedule: {
    entity_type: 'rent_schedule',
    label: 'Rent schedule',
    description: 'The recurring rent owed for a tenancy (structural — NOT a charge or payment).',
    fields: [
      { field: 'amount', label: 'Monthly rent', type: 'money', required: true, description: 'Recurring rent amount per period.' },
      { field: 'currency', label: 'Currency', type: 'currency', required: false, description: '3-letter currency code; defaults to USD.' },
      { field: 'due_day', label: 'Due day of month', type: 'int', required: false, description: 'Day of month rent is due (1–28); defaults to 1.' },
      { field: 'start_date', label: 'Effective from', type: 'date', required: false, description: 'When this rent amount took effect; defaults to the tenancy start date.' },
    ],
  },
};

export function requiredFields(entity: EntityType): string[] {
  return ENTITY_CATALOG[entity].fields.filter((f) => f.required).map((f) => f.field);
}

export function fieldSpec(entity: EntityType, field: string): FieldSpec | undefined {
  return ENTITY_CATALOG[entity].fields.find((f) => f.field === field);
}

// ----- mapping shapes shared by the LLM module, the executor, and the routes.

export interface FieldMapping {
  /** A target field name from the catalog for this entity. */
  target_field: string;
  /** Source column name (from the parsed region) to read this field from. */
  source_column: string | null;
  /** A literal constant to use instead of a column (mutually exclusive). */
  constant: string | null;
  /** 0..1 confidence the LLM assigned (1 for a user override). */
  confidence: number;
}

export interface RegionEntityMapping {
  region_index: number;
  entity_type: EntityType;
  fields: FieldMapping[];
}

export interface RecognizedEntity {
  entity_type: EntityType;
  confidence: number;
}

export interface RecognitionResult {
  region_index: number;
  importable: boolean;
  entity_types: RecognizedEntity[];
  summary: string;
}

// Floor below which a recognition/mapping suggestion is treated as noise and
// not surfaced as a default. Shared by the LLM module and the routes.
export const MIN_CONFIDENCE = 0.5;

// ----------------------------------------------------------------------------
// Machine-readable blocker codes. The FE switches on `code` (a closed enum in
// the OpenAPI spec / generated SDK); `message` is for humans only. Adding a
// blocker call site with a new failure class means adding a code here -- the
// contract-drift CI gate keeps spec/SDK in lockstep.
// ----------------------------------------------------------------------------

export const BLOCKER_CODES = [
  'missing_parent_property', // physical row has no property source (map a column or set a default)
  'missing_parent_area', // tenancy row has no unit/area
  'parent_not_found', // a bound parent id does not resolve in this account
  'ambiguous_match', // name matches more than one existing entity
  'unmapped_required_field', // region-level: a required field has no column/constant mapped
  'missing_required_field', // row-level: the mapped cell is empty
  'unparseable_value', // cell present but not coercible (date, money, ...)
  'date_order', // end date precedes start date
  'invalid_value', // failed the same Zod validation an HTTP POST would
  'details_on_non_unit', // unit_details mapped onto a non-unit area kind
] as const;
export type BlockerCode = (typeof BLOCKER_CODES)[number];

// ----------------------------------------------------------------------------
// Parent requirements -- the deterministic "property needed / satisfied"
// signal the FE drives its resolution UI from (no message parsing, no LLM).
// Computed from the same catalog the executor enforces, so the two cannot
// disagree: every entity below `area` transitively requires a property.
// ----------------------------------------------------------------------------

const PROPERTY_DEPENDENT: ReadonlySet<EntityType> = new Set([
  'area',
  'unit_details',
  'tenancy',
  'tenancy_member',
  'lease',
  'rent_schedule',
]);

export type PropertySource = 'mapped_column' | 'default_property_id' | 'property_overrides';

export interface ImportRequirements {
  property: {
    /** True when the current mapping contains an entity that needs a property. */
    needed: boolean;
    /** True when the requirement is met (or vacuously, when not needed). */
    satisfied: boolean;
    /** Which mechanisms currently supply the property. */
    sources: PropertySource[];
  };
}

export function computeRequirements(
  mapping: RegionEntityMapping[],
  parents: {
    default_property_id?: string | null;
    property_overrides?: Record<string, unknown> | null;
  } | null,
): ImportRequirements {
  const needed = mapping.some(
    (m) =>
      PROPERTY_DEPENDENT.has(m.entity_type) &&
      m.fields.some((f) => f.source_column || (f.constant != null && f.constant !== '')),
  );
  const sources: PropertySource[] = [];
  const propertyMapped = mapping.some(
    (m) =>
      m.entity_type === 'property' &&
      m.fields.some(
        (f) => f.target_field === 'name' && (f.source_column || (f.constant != null && f.constant !== '')),
      ),
  );
  if (propertyMapped) sources.push('mapped_column');
  if (parents?.default_property_id) sources.push('default_property_id');
  if (parents?.property_overrides && Object.keys(parents.property_overrides).length > 0) {
    sources.push('property_overrides');
  }
  return { property: { needed, satisfied: !needed || sources.length > 0, sources } };
}
