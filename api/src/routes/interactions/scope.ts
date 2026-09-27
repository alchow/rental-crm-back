import type { getSb } from '../../supabase/request-client';
import { ApiError } from '../_lib/error';

interface ResolvedInteractionScope {
  areaId: string | null;
  propertyId: string | null;
}

/**
 * Resolve a client-facing property selection to the one canonical place key we
 * store: interactions.area_id.
 *
 * property with one live unit -> that unit
 * property with zero/multiple live units -> typed 422; caller chooses area_id
 * property + area -> validate that they belong together
 */
export async function resolveInteractionScope(
  sb: ReturnType<typeof getSb>,
  accountId: string,
  propertyId: string | undefined,
  explicitAreaId: string | undefined,
  fallback: ResolvedInteractionScope = { areaId: null, propertyId: null },
): Promise<ResolvedInteractionScope> {
  // An explicit area remains the canonical input. We still resolve its
  // property once so POST responses carry the same derived shape as GET/list.
  if (propertyId === undefined && explicitAreaId !== undefined) {
    const { data: area, error } = await sb
      .from('areas')
      .select('id, property_id')
      .eq('account_id', accountId)
      .eq('id', explicitAreaId)
      .is('deleted_at', null)
      .maybeSingle();
    if (error) throw new ApiError(500, 'database_error', error.message);
    if (!area) throw new ApiError(404, 'not_found', 'area_id does not belong to this account');
    return { areaId: area.id, propertyId: area.property_id };
  }

  if (propertyId === undefined) return fallback;

  const { data: property, error: propertyError } = await sb
    .from('properties')
    .select('id')
    .eq('account_id', accountId)
    .eq('id', propertyId)
    .is('deleted_at', null)
    .maybeSingle();
  if (propertyError) throw new ApiError(500, 'database_error', propertyError.message);
  if (!property)
    throw new ApiError(404, 'not_found', 'property_id does not belong to this account');

  // A correction that deliberately changes property must not inherit the old
  // property's area. Resolve the new property from scratch unless its area is
  // also supplied explicitly.
  const candidateAreaId =
    explicitAreaId ?? (fallback.propertyId === propertyId ? fallback.areaId : null);
  if (candidateAreaId !== null && candidateAreaId !== undefined) {
    let query = sb
      .from('areas')
      .select('id, property_id')
      .eq('account_id', accountId)
      .eq('id', candidateAreaId);
    // A newly selected area must be live. A correction may retain the original
    // historical area after that area was soft-deleted.
    if (explicitAreaId !== undefined) query = query.is('deleted_at', null);
    const { data: area, error } = await query.maybeSingle();
    if (error) throw new ApiError(500, 'database_error', error.message);
    if (!area) throw new ApiError(404, 'not_found', 'area_id does not belong to this account');
    if (area.property_id !== propertyId) {
      throw new ApiError(422, 'property_requires_area', 'area_id does not belong to property_id', {
        fieldErrors: {
          property_id: ['does not contain area_id'],
          area_id: ['does not belong to property_id'],
        },
      });
    }
    return { areaId: area.id, propertyId };
  }

  const { data: units, error: unitsError } = await sb
    .from('areas')
    .select('id')
    .eq('account_id', accountId)
    .eq('property_id', propertyId)
    .eq('kind', 'unit')
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .limit(2);
  if (unitsError) throw new ApiError(500, 'database_error', unitsError.message);
  if ((units ?? []).length !== 1) {
    throw new ApiError(
      422,
      'property_requires_area',
      'property_id cannot be resolved to exactly one live unit; supply area_id',
      {
        fieldErrors: {
          property_id: ['property has zero or multiple live units'],
          area_id: ['choose a unit or common area explicitly'],
        },
      },
    );
  }
  return { areaId: units![0]!.id, propertyId };
}
