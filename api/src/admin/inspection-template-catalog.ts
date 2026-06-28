// ============================================================================
// Bundled inspection-template catalog (starter forms).
// ============================================================================
//
// Ready-made, account-clonable condition-form templates so a landlord doesn't
// start from a blank page. Labels are GENERIC standard home components (purely
// functional descriptors) -- deliberately NOT copied from any copyrighted form.
// A landlord clones one into their account (POST .../inspection-templates/
// from-catalog), which becomes an editable inspection_templates row; from there
// the normal create-inspection + seed-from-template flow applies.
//
// schema shape matches seed_inspection_items_from_template:
//   { form_code, sections: [{ key, label, items?, checks? }] }
// item_key seeded as "<section.key>/<item.key>"; group_label = section.label.

export interface CatalogField {
  key: string;
  label: string;
  input_kind?: string; // condition_text | boolean | count
  sort?: number;
}
export interface CatalogSection {
  key: string;
  label: string;
  items?: CatalogField[];
  checks?: CatalogField[];
}
export interface CatalogTemplate {
  id: string;
  name: string;
  jurisdiction: string | null;
  version: string;
  schema: { form_code: string; sections: CatalogSection[] };
}

// Standard per-room condition lines; `extra` appends room-specific items.
function room(extra: Array<[string, string]> = []): CatalogField[] {
  const base: Array<[string, string]> = [
    ['ceiling_walls', 'Ceiling & walls'],
    ['paint', 'Paint & finish'],
    ['flooring', 'Flooring'],
    ['doors_locks', 'Doors, locks & stops'],
    ['windows_screens', 'Windows & screens'],
    ['window_coverings', 'Window coverings'],
    ['lights_fans', 'Lights & ceiling fans'],
    ['outlets_switches', 'Outlets & switches'],
    ['closet', 'Closet shelves & rods'],
  ];
  return [...base, ...extra].map(([key, label], i) => ({
    key,
    label,
    input_kind: 'condition_text',
    sort: (i + 1) * 10,
  }));
}

function items(pairs: Array<[string, string]>): CatalogField[] {
  return pairs.map(([key, label], i) => ({ key, label, input_kind: 'condition_text', sort: (i + 1) * 10 }));
}
function checks(triples: Array<[string, string, string]>): CatalogField[] {
  return triples.map(([key, label, kind], i) => ({ key, label, input_kind: kind, sort: (i + 1) * 10 }));
}

const RESIDENTIAL_V1: CatalogTemplate = {
  id: 'residential-generic-v1',
  name: 'Residential move-in / move-out (generic)',
  jurisdiction: 'US',
  version: '1',
  schema: {
    form_code: 'residential-generic-v1',
    sections: [
      {
        key: 'exterior',
        label: 'Exterior',
        items: items([
          ['mailbox', 'Mailbox'],
          ['fences_gates', 'Fences & gates'],
          ['lawn', 'Lawn, trees & shrubs'],
          ['exterior_faucets', 'Exterior faucets'],
          ['roof_gutters', 'Roof & gutters'],
          ['siding_paint', 'Siding & paint'],
          ['driveway', 'Driveway'],
          ['front_door', 'Front door, knob & lock'],
          ['back_door', 'Back door, knob & lock'],
          ['patio_deck', 'Patio or deck'],
        ]),
        checks: checks([
          ['water_shutoff_located', 'Water shut-off valve located?', 'boolean'],
          ['breakers_located', 'Electrical breakers located?', 'boolean'],
        ]),
      },
      {
        key: 'garage',
        label: 'Garage',
        items: items([
          ['ceiling_walls', 'Ceiling & walls'],
          ['floor', 'Floor'],
          ['auto_door_opener', 'Auto door opener & safety reversal'],
          ['garage_doors', 'Garage doors'],
          ['storage', 'Storage area'],
        ]),
        checks: checks([['door_remotes', 'Garage door remotes', 'count']]),
      },
      { key: 'entry', label: 'Entry', items: room() },
      { key: 'living_room', label: 'Living room', items: room([['fireplace', 'Fireplace'], ['cabinets', 'Cabinets']]) },
      { key: 'dining_room', label: 'Dining room', items: room([['cabinets', 'Cabinets']]) },
      {
        key: 'kitchen',
        label: 'Kitchen',
        items: room([
          ['countertops', 'Countertops'],
          ['cabinets', 'Cabinets & drawers'],
          ['range', 'Range / cooktop'],
          ['oven', 'Oven'],
          ['microwave', 'Microwave'],
          ['dishwasher', 'Dishwasher'],
          ['disposal', 'Garbage disposal'],
          ['sink_faucet', 'Sink & faucet'],
          ['refrigerator', 'Refrigerator'],
          ['vent_hood', 'Vent hood & filter'],
        ]),
      },
      { key: 'hallway', label: 'Hallway', items: room() },
      { key: 'primary_bedroom', label: 'Primary bedroom', items: room() },
      {
        key: 'primary_bathroom',
        label: 'Primary bathroom',
        items: room([
          ['countertops', 'Countertops'],
          ['sink_faucet', 'Sink & faucet'],
          ['tub_shower', 'Tub / shower & faucets'],
          ['toilet', 'Toilet, lid, seat & paper holder'],
          ['exhaust_fan', 'Heater & exhaust fan'],
          ['towel_fixtures', 'Towel fixtures'],
        ]),
      },
      { key: 'bedroom_2', label: 'Bedroom 2', items: room() },
      { key: 'bedroom_3', label: 'Bedroom 3', items: room() },
      {
        key: 'bathroom_2',
        label: 'Bathroom 2',
        items: room([
          ['countertops', 'Countertops'],
          ['sink_faucet', 'Sink & faucet'],
          ['tub_shower', 'Tub / shower & faucets'],
          ['toilet', 'Toilet, lid, seat & paper holder'],
          ['exhaust_fan', 'Heater & exhaust fan'],
        ]),
      },
      {
        key: 'utility_room',
        label: 'Utility room',
        items: items([
          ['ceiling_walls', 'Ceiling & walls'],
          ['flooring', 'Flooring'],
          ['sink_faucet', 'Sink & faucet'],
          ['washer_dryer_connections', 'Washer & dryer connections'],
        ]),
      },
      {
        key: 'systems',
        label: 'Systems',
        items: items([
          ['hvac', 'Central A/C & heat'],
          ['thermostat', 'Thermostat'],
          ['water_heater', 'Water heater'],
        ]),
        checks: checks([
          ['smoke_alarms_count', 'Number of smoke alarms', 'count'],
          ['smoke_alarms_tested', 'Smoke alarms tested?', 'boolean'],
          ['smoke_alarms_working', 'Smoke alarms working?', 'boolean'],
          ['exterior_locks_tested', 'All exterior door locks tested & working?', 'boolean'],
        ]),
      },
      {
        key: 'keys',
        label: 'Keys & access',
        checks: checks([
          ['door_keys', 'Door keys', 'count'],
          ['mailbox_keys', 'Mailbox keys', 'count'],
          ['gate_keys', 'Gate keys', 'count'],
          ['garage_remotes', 'Garage door remotes', 'count'],
          ['fobs_cards', 'Security fobs / cards', 'count'],
        ]),
      },
    ],
  },
};

const BUNDLED: CatalogTemplate[] = [RESIDENTIAL_V1];

export interface CatalogSummary {
  id: string;
  name: string;
  jurisdiction: string | null;
  version: string;
  section_count: number;
}

export function listInspectionTemplateCatalog(): CatalogSummary[] {
  return BUNDLED.map((t) => ({
    id: t.id,
    name: t.name,
    jurisdiction: t.jurisdiction,
    version: t.version,
    section_count: t.schema.sections.length,
  }));
}

export function getInspectionTemplateCatalog(id: string): CatalogTemplate | undefined {
  return BUNDLED.find((t) => t.id === id);
}
