import { z } from '@hono/zod-openapi';

// Schemas shared by HTTP routes and the deterministic onboarding-import
// executor. Keep them out of route modules so admin code never imports a route
// file just to reuse validation.

// Keep unregistered. Registering Address and then using optional/nullable refs
// makes openapi-typescript emit unsatisfiable `Address & Record<string, never>`
// shapes for some bodies.
export const Address = z.object({
  line1: z.string().max(200).optional(),
  line2: z.string().max(200).optional(),
  city: z.string().max(100).optional(),
  state: z.string().max(100).optional(),
  zip: z.string().max(20).optional(),
  country: z.string().max(100).optional(),
});

export const CreatePropertyBody = z
  .object({
    name: z.string().min(1).max(200),
    address: Address.optional(),
  })
  .openapi('CreatePropertyBody');

export const AreaKind = z.enum([
  'unit',
  'entrance',
  'hallway',
  'stairwell',
  'basement_mechanical',
  'laundry',
  'parking',
  'roof',
  'exterior_grounds',
  'common_other',
]);

export const CreateAreaBody = z
  .object({
    property_id: z.string().uuid(),
    kind: AreaKind,
    name: z.string().min(1).max(200),
  })
  .openapi('CreateAreaBody');

export const PutUnitDetailsBody = z
  .object({
    bedrooms: z.number().int().nonnegative().nullable().optional(),
    bathrooms: z.number().nonnegative().nullable().optional(),
    sqft: z.number().int().nonnegative().nullable().optional(),
  })
  .openapi('PutUnitDetailsBody');

export const CreateTenantBody = z
  .object({
    full_name: z.string().min(1).max(200),
    emails: z.array(z.string().email()).optional(),
    phones: z.array(z.string().min(1).max(40)).optional(),
    notes: z.string().optional(),
  })
  .openapi('CreateTenantBody');

export const TenancyStatus = z.enum(['upcoming', 'active', 'ended', 'holdover']);

export const CreateTenancyBody = z
  .object({
    area_id: z.string().uuid(),
    start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    end_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    status: TenancyStatus,
  })
  .openapi('CreateTenancyBody');

export const MemberRole = z.enum(['primary', 'occupant', 'guarantor']);

export const AddMemberBody = z
  .object({
    tenant_id: z.string().uuid(),
    role: MemberRole,
  })
  .openapi('AddTenancyMemberBody');

export const LeaseStatus = z.enum(['draft', 'active', 'expired', 'superseded']);
export const CurrencyCode = z.string().length(3);

export const CreateLeaseBody = z
  .object({
    tenancy_id: z.string().uuid(),
    term_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    term_end: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    rent_amount_cents: z.number().int().nonnegative(),
    rent_currency: CurrencyCode,
    deposit_amount_cents: z.number().int().nonnegative().optional(),
    deposit_currency: CurrencyCode.optional(),
    document: z.record(z.unknown()).optional(),
    status: LeaseStatus,
  })
  .refine((b) => (b.deposit_amount_cents ?? 0) === 0 || b.deposit_currency !== undefined, {
    message: 'deposit_currency is required when deposit_amount_cents > 0',
  })
  .openapi('CreateLeaseBody');

export const ScheduleKind = z.string().min(1).max(50);

export const CreateRentScheduleBody = z
  .object({
    tenancy_id: z.string().uuid(),
    kind: ScheduleKind,
    amount_cents: z.number().int().nonnegative(),
    currency: CurrencyCode,
    due_day: z.number().int().min(1).max(28),
    start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    end_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    source_lease_id: z.string().uuid().optional(),
    source_notice_id: z.string().uuid().optional(),
    change_reason: z.string().min(1).max(2000).optional(),
  })
  .openapi('CreateRentScheduleBody');

export const PartyType = z.enum(['tenant', 'vendor', 'inspector', 'other', 'none', 'unspecified']);
export const Channel = z.enum([
  'in_person',
  'phone',
  'voicemail',
  'sms',
  'email',
  'letter',
  'in_app',
  'import',
  'note',
  'agent_event',
]);
export const Direction = z.enum(['inbound', 'outbound', 'mutual', 'unspecified', 'none']);
export const Kind = z.enum(['communication', 'note', 'agent_event']);
export const CorrectionKind = z.enum(['amend', 'retract', 'classify']);
export const KindOut = z.enum(['communication', 'note', 'agent_event']);
export const ChannelOut = z.enum([
  'in_person',
  'phone',
  'voicemail',
  'sms',
  'email',
  'letter',
  'in_app',
  'import',
  'note',
  'agent_event',
]);
export const EntryType = z.enum([
  'proposal_created',
  'proposal_approved',
  'proposal_rejected',
  'step_executed',
  'proposal_failed',
  'proposal_blocked',
  'resume_target_dead',
  'proposal_superseded',
]);
export const AuthorType = z.enum(['landlord', 'tenant', 'vendor', 'agent', 'system']);
export const ParticipantRole = z.enum(['sender', 'recipient', 'cc', 'attendee']);
export const ParticipantPartyType = z.enum([
  'tenant',
  'landlord_user',
  'vendor',
  'agent',
  'inspector',
  'other',
  'platform',
  'unknown',
]);
export const CreateParticipantPartyType = z.enum([
  'tenant',
  'landlord_user',
  'vendor',
  'agent',
  'inspector',
  'other',
  'unknown',
]);
export const ParticipantSource = z.enum(['capture', 'comms', 'backfill']);
/** Trust tier of a journal row. 'unverified' (20260723000003) marks a persona
 *  inbound whose sender claim failed DMARC but named exactly one known
 *  tenant/vendor — the receipt is journaled (receipt is the operative fact),
 *  the identity is claimed, never asserted. It can be retracted-with-reason or
 *  human-confirmed to 'attested' via the comms endpoints. */
export const Attestation = z.enum(['provider_verified', 'attested', 'imported', 'unverified']);

export const InteractionParticipant = z
  .object({
    role: ParticipantRole,
    party_type: ParticipantPartyType,
    party_id: z.string().uuid().nullable(),
    address: z.string().nullable(),
    label: z.string().nullable(),
    source: ParticipantSource,
  })
  .openapi('InteractionParticipant');

export const Interaction = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    actor: z.string(),
    party_type: PartyType,
    party_id: z.string().uuid().nullable(),
    party_label: z.string().nullable(),
    channel: ChannelOut,
    direction: Direction,
    body: z.string().nullable(),
    occurred_at: z.string(),
    logged_at: z.string(),
    kind: KindOut,
    author_type: AuthorType,
    approved_by: z.string().uuid().nullable(),
    approval_ref: z.string().nullable(),
    entry_type: EntryType.nullable(),
    external_ref: z.string().nullable(),
    rfc822_message_id: z.string().nullable().optional(),
    corrects_id: z.string().uuid().nullable(),
    correction_kind: CorrectionKind.nullable(),
    superseded_by_id: z.string().uuid().nullable(),
    is_head: z.boolean(),
    tenancy_id: z.string().uuid().nullable(),
    maintenance_request_id: z.string().uuid().nullable(),
    area_id: z.string().uuid().nullable(),
    property_id: z.string().uuid().nullable(),
    work_order_id: z.string().uuid().nullable(),
    vendor_id: z.string().uuid().nullable(),
    thread_id: z.string().uuid().nullable().optional(),
    attestation: Attestation.nullable().optional(),
    participants: z.array(InteractionParticipant),
    references_interaction_id: z.string().uuid().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    deleted_at: z.string().nullable(),
  })
  .openapi('Interaction');

export const CreateInteractionBody = z
  .object({
    kind: Kind.optional(),
    party_type: PartyType.optional(),
    party_id: z.string().uuid().optional(),
    party_label: z.string().max(200).optional(),
    channel: Channel.optional(),
    direction: Direction.optional(),
    body: z.string().max(20000).optional(),
    occurred_at: z.string().datetime().optional(),
    corrects_id: z.string().uuid().optional(),
    correction_kind: CorrectionKind.optional(),
    tenancy_id: z.string().uuid().optional(),
    maintenance_request_id: z.string().uuid().optional(),
    area_id: z.string().uuid().optional(),
    property_id: z
      .string()
      .uuid()
      .optional()
      .openapi({
        description:
          'Place-resolution hint. The backend stores only canonical area_id. If omitted area_id ' +
          'and the property has exactly one live unit, that unit is used automatically; otherwise ' +
          'the request returns 422 property_requires_area.',
      }),
    work_order_id: z.string().uuid().optional(),
    vendor_id: z.string().uuid().optional(),
    entry_type: EntryType.optional(),
    approved_by: z.string().uuid().optional(),
    approval_ref: z.string().min(1).max(200).optional(),
    external_ref: z.string().min(1).max(200).optional(),
    references_interaction_id: z.string().uuid().optional().openapi({
      description:
        "Same-account reference to a prior interaction / journal entry this entry follows from (e.g. a step_executed agent_event's anchor).",
    }),
    participants: z
      .array(
        z
          .object({
            role: ParticipantRole,
            party_type: CreateParticipantPartyType,
            party_id: z.string().uuid().optional(),
            address: z.string().min(3).max(320).optional(),
            label: z.string().min(1).max(200).optional(),
          })
          .refine(
            (p) => p.party_id !== undefined || p.address !== undefined || p.label !== undefined,
            { message: 'a participant needs at least one of party_id, address, label' },
          ),
      )
      .min(1)
      .max(20)
      .optional(),
  })
  .superRefine((b, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });

    if ((b.corrects_id === undefined) !== (b.correction_kind === undefined)) {
      issue('correction_kind', 'corrects_id and correction_kind must be provided together');
      return;
    }
    if (b.participants !== undefined) {
      if (b.corrects_id !== undefined) {
        issue(
          'participants',
          'participants are recorded on the original entry; a correction inherits them',
        );
      }
      if ((b.kind ?? 'communication') !== 'communication') {
        issue('participants', "participants are only valid on a new kind='communication' entry");
      }
    }
    if (b.corrects_id !== undefined && b.entry_type !== undefined) {
      issue(
        'entry_type',
        'entry_type is inherited from the corrected entry and cannot be supplied on a correction',
      );
    }
    if (
      b.external_ref !== undefined &&
      (b.corrects_id !== undefined || (b.kind ?? 'communication') !== 'communication')
    ) {
      issue('external_ref', "external_ref is only valid on a new kind='communication' entry");
    }

    if (b.corrects_id !== undefined) {
      if (b.correction_kind === 'classify') {
        if (b.body !== undefined) {
          issue(
            'body',
            "classify cannot change body (it is inherited; use correction_kind='amend' for substantive edits)",
          );
        }
        if (b.occurred_at !== undefined) {
          issue(
            'occurred_at',
            "classify cannot change occurred_at (it is inherited; use correction_kind='amend' to re-date)",
          );
        }
        return;
      }
      if (b.body === undefined) {
        issue('body', 'a correction requires body (amend: corrected content; retract: reason)');
      }
      if (b.correction_kind === 'retract') {
        const forbidden = [
          'kind',
          'party_type',
          'party_id',
          'party_label',
          'channel',
          'direction',
          'occurred_at',
          'tenancy_id',
          'maintenance_request_id',
          'area_id',
          'property_id',
          'work_order_id',
          'vendor_id',
          'references_interaction_id',
        ] as const;
        for (const f of forbidden) {
          if (b[f] !== undefined) {
            issue(
              f,
              'a retraction carries only the reason (body); everything else is inherited from the original',
            );
          }
        }
      }
      return;
    }

    const kind = b.kind ?? 'communication';

    if (kind === 'agent_event') {
      if (b.occurred_at === undefined) issue('occurred_at', 'occurred_at is required');
      if (b.entry_type === undefined)
        issue('entry_type', "entry_type is required for kind='agent_event'");
      if (b.channel !== undefined && b.channel !== 'agent_event') {
        issue('channel', "channel must be 'agent_event' or omitted for kind='agent_event'");
      }
      if (b.direction !== undefined && b.direction !== 'none') {
        issue('direction', "direction must be 'none' or omitted for kind='agent_event'");
      }
      if (b.party_type !== undefined && b.party_type !== 'none') {
        issue('party_type', "party_type must be 'none' or omitted for kind='agent_event'");
      }
      if (b.party_id !== undefined)
        issue('party_id', "party_id is forbidden for kind='agent_event'");
      if (b.party_label !== undefined)
        issue('party_label', "party_label is forbidden for kind='agent_event'");
      return;
    }

    if (b.entry_type !== undefined) {
      issue('entry_type', "entry_type is only valid for kind='agent_event'");
    }
    if (b.occurred_at === undefined) issue('occurred_at', 'occurred_at is required');

    if (kind === 'communication') {
      if (b.channel === undefined) issue('channel', 'channel is required for a communication');
      if (b.party_type === undefined)
        issue('party_type', 'party_type is required for a communication');
      if (b.direction === 'none' && b.channel !== 'import') {
        issue('direction', "direction 'none' is only valid for channel 'import'");
      }
      if (b.channel === 'note') issue('channel', "channel 'note' is reserved for kind='note'");
      if (b.channel === 'agent_event')
        issue('channel', "channel 'agent_event' is reserved for kind='agent_event'");
      if (b.party_type === 'none')
        issue('party_type', "party_type 'none' is reserved for kind='note'");
      if (b.party_type === 'unspecified' && b.party_id !== undefined) {
        issue(
          'party_id',
          "party_type 'unspecified' cannot carry a party_id (resolve the role first, or omit party_id)",
        );
      }
    } else {
      // kind === 'note'. A note MAY name a counterparty (campaign-4 §12) so
      // "a note about Gina" surfaces on Gina's page. channel/direction stay
      // note-shaped; party fields are free under the same coherence a
      // communication uses.
      if (b.channel !== undefined && b.channel !== 'note') {
        issue('channel', "a note has no channel (omit it, or send 'note')");
      }
      if (b.direction !== undefined && b.direction !== 'none') {
        issue('direction', "a note has no direction (omit it, or send 'none')");
      }
      // 'unspecified' is the communication-only capture sentinel (the
      // unresolved-sender queue). A note carries a concrete role or none.
      if (b.party_type === 'unspecified') {
        issue(
          'party_type',
          "party_type 'unspecified' is for communications; a note carries a concrete role (tenant/vendor/inspector/other) or none",
        );
      }
      // id => concrete role (whoToParty coherence, mirrors the communication
      // unspecified+id rejection): a party_id needs a resolved party_type.
      if (b.party_id !== undefined && (b.party_type === undefined || b.party_type === 'none')) {
        issue(
          'party_id',
          'party_id needs a resolved role (set party_type to tenant/vendor/inspector/other)',
        );
      }
    }
  })
  .openapi('CreateInteractionBody');

export type InteractionParticipantRow = z.infer<typeof InteractionParticipant>;
