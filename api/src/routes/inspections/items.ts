import type { z } from '@hono/zod-openapi';
import { createRoute } from '@hono/zod-openapi';
import { newApiApp } from '../_lib/app';
import { getSb } from '../../supabase/request-client';
import { type DbTableUpdate } from '../../supabase/db-types';
import { ApiError, errorResponses } from '../_lib/error';
import { softDeleteStamp } from '../_lib/soft-delete';
import {
  InspectionItem,
  CreateItemBody,
  PatchItemBody,
  BatchItemsBody,
  rpcError,
  InspectionAndItemParam,
  InspectionParam,
  ItemListResponse,
} from './shared';

const itemList = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/inspections/{inspectionId}/items',
  tags: ['inspection_items'],
  request: { params: InspectionParam },
  responses: {
    200: { description: 'items', content: { 'application/json': { schema: ItemListResponse } } },
    ...errorResponses,
  },
});
const itemCreate = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/inspections/{inspectionId}/items',
  tags: ['inspection_items'],
  request: {
    params: InspectionParam,
    body: { content: { 'application/json': { schema: CreateItemBody } }, required: true },
  },
  responses: {
    201: { description: 'created', content: { 'application/json': { schema: InspectionItem } } },
    ...errorResponses,
  },
});
const itemPatch = createRoute({
  method: 'patch',
  path: '/accounts/{accountId}/inspections/{inspectionId}/items/{id}',
  tags: ['inspection_items'],
  request: {
    params: InspectionAndItemParam,
    body: { content: { 'application/json': { schema: PatchItemBody } }, required: true },
  },
  responses: {
    200: { description: 'updated', content: { 'application/json': { schema: InspectionItem } } },
    ...errorResponses,
  },
});
const itemRemove = createRoute({
  method: 'delete',
  path: '/accounts/{accountId}/inspections/{inspectionId}/items/{id}',
  tags: ['inspection_items'],
  summary:
    'Soft-delete an inspection item (rejected with 409 if the parent inspection is completed)',
  request: { params: InspectionAndItemParam },
  responses: {
    204: { description: 'deleted' },
    ...errorResponses,
  },
});

export const inspectionItemsApp = newApiApp();

inspectionItemsApp.openapi(itemList, async (c) => {
  const { accountId, inspectionId } = c.req.valid('param');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('inspection_items')
    .select('*')
    .eq('account_id', accountId)
    .eq('inspection_id', inspectionId)
    .is('deleted_at', null)
    .order('created_at', { ascending: true });
  if (error) throw new ApiError(500, 'database_error', error.message);
  return c.json({ data: (data ?? []) as z.infer<typeof InspectionItem>[] }, 200);
});

inspectionItemsApp.openapi(itemCreate, async (c) => {
  const { accountId, inspectionId } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('inspection_items')
    .insert({
      account_id: accountId,
      inspection_id: inspectionId,
      label: body.label,
      condition: body.condition ?? null,
      notes: body.notes ?? null,
      item_key: body.item_key ?? null,
      group_label: body.group_label ?? null,
      change_type: body.change_type ?? null,
      sort_order: body.sort_order ?? null,
    })
    .select('*')
    .single();
  if (error) {
    if (/parent inspection .* is completed/i.test(error.message)) {
      throw new ApiError(409, 'conflict', 'parent inspection is completed; items are immutable');
    }
    if (error.code === '23505')
      throw new ApiError(
        409,
        'conflict',
        'an item with this item_key already exists for this inspection',
      );
    if (error.code === '23503')
      throw new ApiError(404, 'not_found', 'inspection not found in this account');
    throw new ApiError(500, 'database_error', error.message);
  }
  return c.json(data as z.infer<typeof InspectionItem>, 201);
});

inspectionItemsApp.openapi(itemPatch, async (c) => {
  const { accountId, inspectionId, id } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);
  const update: DbTableUpdate<'inspection_items'> = { updated_at: new Date().toISOString() };
  if (body.label !== undefined) update.label = body.label;
  if (body.condition !== undefined) update.condition = body.condition;
  if (body.notes !== undefined) update.notes = body.notes;
  if (body.item_key !== undefined) update.item_key = body.item_key;
  if (body.group_label !== undefined) update.group_label = body.group_label;
  if (body.change_type !== undefined) update.change_type = body.change_type;
  if (body.sort_order !== undefined) update.sort_order = body.sort_order;
  const { data, error } = await sb
    .from('inspection_items')
    .update(update)
    .eq('account_id', accountId)
    .eq('inspection_id', inspectionId)
    .eq('id', id)
    .is('deleted_at', null)
    .select('*')
    .maybeSingle();
  if (error) {
    if (/parent inspection .* is completed/i.test(error.message)) {
      throw new ApiError(409, 'conflict', 'parent inspection is completed; items are immutable');
    }
    if (error.code === '23505')
      throw new ApiError(
        409,
        'conflict',
        'an item with this item_key already exists for this inspection',
      );
    throw new ApiError(500, 'database_error', error.message);
  }
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.json(data as z.infer<typeof InspectionItem>, 200);
});

inspectionItemsApp.openapi(itemRemove, async (c) => {
  const { accountId, inspectionId, id } = c.req.valid('param');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('inspection_items')
    .update(softDeleteStamp())
    .eq('account_id', accountId)
    .eq('inspection_id', inspectionId)
    .eq('id', id)
    .is('deleted_at', null)
    .select('id')
    .maybeSingle();
  if (error) {
    if (/parent inspection .* is completed/i.test(error.message)) {
      throw new ApiError(409, 'conflict', 'parent inspection is completed; items are immutable');
    }
    throw new ApiError(500, 'database_error', error.message);
  }
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.body(null, 204);
});

// Batch upsert items by item_key (offline / field re-sync). Convergent on
// item_key so a retried sync doesn't double-insert.
const itemsBatchRoute = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/inspections/{inspectionId}/items/batch',
  tags: ['inspection_items'],
  summary: 'Batch upsert inspection items by item_key',
  request: {
    params: InspectionParam,
    body: { content: { 'application/json': { schema: BatchItemsBody } }, required: true },
  },
  responses: {
    200: { description: 'upserted', content: { 'application/json': { schema: ItemListResponse } } },
    ...errorResponses,
  },
});
inspectionItemsApp.openapi(itemsBatchRoute, async (c) => {
  const { accountId, inspectionId } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);
  const { data, error } = await sb.rpc('upsert_inspection_items', {
    p_account_id: accountId,
    p_inspection_id: inspectionId,
    p_items: body.items,
  });
  if (error) throw rpcError(error);
  return c.json({ data: (data ?? []) as z.infer<typeof InspectionItem>[] }, 200);
});
