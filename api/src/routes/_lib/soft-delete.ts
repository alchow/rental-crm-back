export function softDeleteStamp(now = new Date().toISOString()): { deleted_at: string; updated_at: string } {
  return { deleted_at: now, updated_at: now };
}
