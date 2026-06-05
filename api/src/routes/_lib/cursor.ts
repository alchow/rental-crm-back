// Opaque cursor for keyset pagination on (created_at, id). created_at gives
// us creation-order; id breaks ties (uuid v4 is uniform-random but stable per
// row). The cursor is base64url-encoded JSON so it's URL-safe and trivially
// debug-printable in dev.
//
// We don't sign or encrypt the cursor: the only things it contains are the
// last row's created_at + id, which the client already saw in the previous
// page. There's no information disclosure to bind to a secret.

export interface CursorPosition {
  created_at: string;
  id: string;
}

export function encodeCursor(p: CursorPosition): string {
  return Buffer.from(JSON.stringify(p)).toString('base64url');
}

export function decodeCursor(s: string): CursorPosition | null {
  try {
    const obj = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as unknown;
    if (
      typeof obj === 'object' &&
      obj !== null &&
      'created_at' in obj &&
      'id' in obj &&
      typeof (obj as { created_at: unknown }).created_at === 'string' &&
      typeof (obj as { id: unknown }).id === 'string'
    ) {
      return obj as CursorPosition;
    }
    return null;
  } catch {
    return null;
  }
}
