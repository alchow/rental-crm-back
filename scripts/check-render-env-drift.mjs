#!/usr/bin/env node
/* global console, process */
// Render blueprint env drift gate.
//
// The API env schema is the runtime source of truth, but operators provision
// production from render.yaml. This guard checks the web service advertises the
// env vars an operator must consciously set for current production features.
// Defaults-only knobs (PORT, LOG_LEVEL, CORS, retention horizon, JWT overrides)
// stay out of this list on purpose.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDER = path.join(ROOT, 'render.yaml');

const REQUIRED_WEB_KEYS = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_DB_URL',
  'ANTHROPIC_API_KEY',
  'UNSUBSCRIBE_HMAC_SECRET',
  'EMAIL_REPLY_DOMAIN',
  'EMAIL_PLATFORM_PARENT_DOMAIN',
];

const text = readFileSync(RENDER, 'utf8');
const webService = text.match(/(?:^|\n)[ ]{2}- type: web\n([\s\S]*?)(?=\n[ ]{2}- type: |\n\S|$)/);

if (!webService || !webService[1]?.includes('name: rental-crm-api')) {
  console.error('FAIL: render.yaml does not contain the rental-crm-api web service.');
  process.exit(1);
}

const webBlock = webService[1];
const actual = new Set([...webBlock.matchAll(/^\s+- key: ([A-Z0-9_]+)\s*$/gm)].map((match) => match[1]));
const missing = REQUIRED_WEB_KEYS.filter((key) => !actual.has(key));

if (missing.length > 0) {
  console.error('FAIL: render.yaml web service is missing env var(s):');
  for (const key of missing) {
    console.error(`  - ${key}`);
  }
  console.error(
    '\nData flow example: api/src/env.ts reads EMAIL_PLATFORM_PARENT_DOMAIN, ' +
      'so render.yaml must expose EMAIL_PLATFORM_PARENT_DOMAIN for production setup.',
  );
  process.exit(1);
}

console.info(`OK: render.yaml web service exposes ${REQUIRED_WEB_KEYS.length} production env vars.`);
