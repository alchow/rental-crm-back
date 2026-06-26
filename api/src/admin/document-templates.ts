import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export interface DocumentTemplate {
  id: string;
  document_type: 'lead_paint' | 'disclosure';
  title: string;
  requires_ack: boolean;
  source_url: string;
  asset_path: string;
  mime_type: 'application/pdf';
}

const TEMPLATES: readonly DocumentTemplate[] = [
  {
    id: 'epa_lead_pamphlet_2020',
    document_type: 'lead_paint',
    title: 'EPA Protect Your Family From Lead in Your Home',
    requires_ack: true,
    source_url: 'https://www.epa.gov/lead/real-estate-disclosures-about-potential-lead-hazards',
    asset_path: 'document-templates/epa-lead-in-your-home-2020.pdf',
    mime_type: 'application/pdf',
  },
] as const;

export function documentTemplates(): readonly DocumentTemplate[] {
  return TEMPLATES;
}

export function getDocumentTemplate(id: string): DocumentTemplate | null {
  return TEMPLATES.find((t) => t.id === id) ?? null;
}

export function staticAssetUrl(assetPath: string): URL {
  return new URL(`../static/${assetPath}`, import.meta.url);
}

interface StaticAsset {
  bytes: Uint8Array;
  content_hash: string;
  size_bytes: number;
}

// Bundled assets are immutable for the life of the process, so read + hash once
// and serve the cached result. Without this the 1.2 MB EPA PDF was re-read and
// re-sha256'd on every list-templates / from-template / static download.
const assetCache = new Map<string, StaticAsset>();

export async function readStaticDocumentAsset(assetPath: string): Promise<StaticAsset> {
  const cached = assetCache.get(assetPath);
  if (cached) return cached;
  const bytes = await readFile(staticAssetUrl(assetPath));
  const asset: StaticAsset = {
    bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    content_hash: createHash('sha256').update(bytes).digest('hex'),
    size_bytes: bytes.byteLength,
  };
  assetCache.set(assetPath, asset);
  return asset;
}
