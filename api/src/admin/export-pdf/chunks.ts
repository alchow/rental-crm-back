// Leaf module for the PostgREST IN-filter chunking helper, so the sibling
// export modules (export-pdf.ts, export-pdf/incidents.ts, ...) can share it
// without importing each other -- the export-pdf <-> incidents value cycle was
// runtime-safe only because both directions were hoisted function declarations
// used at call time; this makes the safety structural.

const IN_FILTER_CHUNK_SIZE = 100;

export function idChunks(ids: Iterable<string>, size = IN_FILTER_CHUNK_SIZE): string[][] {
  const unique = [...new Set(ids)].filter((id) => id.length > 0);
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += size) {
    chunks.push(unique.slice(i, i + size));
  }
  return chunks;
}
