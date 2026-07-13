import { describe, expect, it } from 'vitest';
import { readStaticDocumentAsset, staticAssetUrl } from '../src/admin/document-templates';

describe('bundled document assets', () => {
  it('reads the shipped template from the static root', async () => {
    const asset = await readStaticDocumentAsset(
      'document-templates/epa-lead-in-your-home-2020.pdf',
    );
    expect(asset.content_hash).toBe(
      'ab606a293bbbb2c4a4abe95f3471bf9d325c2c7a7fd5f336aef120ffe4c6567c',
    );
    expect(asset.size_bytes).toBe(1_292_178);
  });

  it.each(['../../../../etc/passwd', '/etc/passwd', ''])('rejects escaped path %j', (path) => {
    expect(() => staticAssetUrl(path)).toThrow('escapes the bundled asset root');
  });
});
