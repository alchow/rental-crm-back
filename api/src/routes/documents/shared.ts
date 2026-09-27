import { z } from '@hono/zod-openapi';

export const DocumentType = z.enum([
  'lease',
  'move_in',
  'move_out',
  'lead_paint',
  'disclosure',
  'other',
]);
export const VersionSource = z.enum(['landlord_upload', 'bundled_static']);

export const DocumentVersion = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    document_id: z.string().uuid(),
    version_no: z.number().int(),
    source: VersionSource,
    attachment_id: z.string().uuid().nullable(),
    static_template_id: z.string().nullable(),
    static_asset_path: z.string().nullable(),
    content_hash: z.string(),
    mime_type: z.string(),
    size_bytes: z.number().int(),
    created_by: z.string().uuid().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    deleted_at: z.string().nullable(),
    original_attachment_id: z
      .string()
      .uuid()
      .nullable()
      .openapi({
        description:
          'The landlord-uploaded original. For image uploads this differs from attachment_id, ' +
          'which points to the derived PDF rendition.',
      }),
    original_content_hash: z.string().nullable(),
    original_mime_type: z.string().nullable(),
  })
  .openapi('DocumentVersion');

export const DocumentRow = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    tenancy_id: z.string().uuid(),
    document_type: DocumentType,
    title: z.string(),
    requires_ack: z.boolean(),
    published_at: z.string().nullable(),
    created_by: z.string().uuid().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    deleted_at: z.string().nullable(),
    latest_version: DocumentVersion.nullable(),
  })
  .openapi('Document');

export const AccountParam = z.object({
  accountId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'accountId', in: 'path' } }),
});
export const AccountAndIdParam = z.object({
  accountId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'accountId', in: 'path' } }),
  id: z
    .string()
    .uuid()
    .openapi({ param: { name: 'id', in: 'path' } }),
});

export function binaryResponse(
  bytes: Uint8Array,
  opts: {
    mimeType: string;
    filename: string;
    contentHash: string;
  },
): Response {
  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': opts.mimeType,
      'content-disposition': `attachment; filename="${opts.filename}"`,
      'content-length': String(bytes.byteLength),
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'x-content-sha256': opts.contentHash,
    },
  });
}
