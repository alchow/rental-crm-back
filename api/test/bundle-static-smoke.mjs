import { readStaticDocumentAsset } from '../dist/admin/document-templates.js';

const asset = await readStaticDocumentAsset('document-templates/epa-lead-in-your-home-2020.pdf');
if (
  asset.content_hash !== 'ab606a293bbbb2c4a4abe95f3471bf9d325c2c7a7fd5f336aef120ffe4c6567c' ||
  asset.size_bytes !== 1_292_178
) {
  throw new Error('bundled static document smoke check returned unexpected bytes');
}
