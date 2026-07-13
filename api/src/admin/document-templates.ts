import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const resolvedStaticRoot = [
  // Source mode: api/src/admin/document-templates.ts -> api/src/static.
  resolve(moduleDirectory, '../static'),
  // Bundled mode: api/dist/{document-templates,chunk-*}.js -> api/dist/static.
  resolve(moduleDirectory, 'static'),
].find(existsSync);

if (!resolvedStaticRoot) throw new Error('bundled document asset root is missing');
const STATIC_ROOT: string = resolvedStaticRoot;

export function staticAssetUrl(assetPath: string): URL {
  const candidate = resolve(STATIC_ROOT, assetPath);
  const fromRoot = relative(STATIC_ROOT, candidate);
  if (!assetPath || isAbsolute(assetPath) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
    throw new Error('static asset path escapes the bundled asset root');
  }
  return pathToFileURL(candidate);
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
