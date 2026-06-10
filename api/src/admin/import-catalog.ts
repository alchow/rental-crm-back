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
    label: 'Unit',
    description: 'A rentable unit within a property (kind is fixed to "unit").',
    fields: [
      { field: 'name', label: 'Unit label', type: 'string', required: true, description: 'Unit number/label, e.g. "1A", "Apt 203", "Rear".' },
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
