import { z } from '@hono/zod-openapi';

export const CommAttachment = z
  .object({
    id: z.string().uuid(),
    /** Sender-supplied display name ("lease.pdf"). */
    filename: z.string().nullable(),
    mime_type: z.string().nullable(),
    size_bytes: z.number().int().nullable(),
    /** sha256 (lowercase hex) of the stored bytes. */
    content_hash: z.string(),
    created_at: z.string(),
  })
  .openapi('CommAttachment');

// header-injection-adjacent: `filename` and `content_type` are rendered into
// the download response's content-disposition / content-type headers, and
// undici THROWS on a header value containing C0 controls or DEL — so a stored
// CR/LF/NUL would make the attachment permanently un-downloadable (500).
// Reject those bytes at ingest: `[ -~]` accepts only printable ASCII (0x20
// space … 0x7e tilde), which excludes every C0 control and DEL. (A literal
// control-char range would trip eslint no-control-regex.)
export const UploadCommAttachmentBody = z
  .object({
    filename: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[ -~]+$/, 'must not contain control characters'),
    content_type: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[ -~]+$/, 'must not contain control characters'),
    /** The attachment bytes, base64. Max 10 MiB decoded; at most 10
     *  attachments per message. */
    data_b64: z
      .string()
      .min(1)
      .max(14_400_000)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  })
  .openapi('UploadCommAttachmentBody');

export const CommAttachmentListResponse = z
  .object({ data: z.array(CommAttachment) })
  .openapi('CommAttachmentListResponse');

export const InteractionAttachmentParams = z.object({
  accountId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'accountId', in: 'path' } }),
  interactionId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'interactionId', in: 'path' } }),
});
