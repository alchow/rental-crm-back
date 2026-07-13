import { cp, rm } from 'node:fs/promises';
import { URL } from 'node:url';

const source = new URL('../src/static/', import.meta.url);
const target = new URL('../dist/static/', import.meta.url);

// tsup cleans emitted JS but can preserve copied directories. Replace the
// static tree so repeated local/CI builds cannot produce dist/static/static.
await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });
