// Receipt/due dates select facts; application and reversal timestamps select their later effects.
export function ledgerRowsAt<T extends { voided_at?: unknown; void_reason?: unknown }>(
  rows: readonly T[],
  dateOf: (row: T) => string,
  cutoff?: string | null,
): T[] {
  if (!cutoff) return [...rows];
  return rows
    .filter((row) => dateOf(row).slice(0, 10) <= cutoff)
    .map((row) =>
      row.voided_at && String(row.voided_at).slice(0, 10) > cutoff
        ? { ...row, voided_at: null, void_reason: null }
        : row,
    );
}

export function dayBefore(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}
