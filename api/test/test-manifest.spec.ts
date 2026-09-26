import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const guard = readFileSync(
  new URL('../../scripts/check-test-manifest.mjs', import.meta.url),
  'utf8',
);
let root: string;
let scripts: Record<string, string>;
let manifest: Record<string, Array<{ script: string; description: string }>>;

function write(file: string, contents = '') {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function runGuard() {
  write('api/package.json', JSON.stringify({ scripts }));
  write('api/test/test-manifest.json', JSON.stringify(manifest));
  return spawnSync(process.execPath, [path.join(root, 'scripts/check-test-manifest.mjs')], {
    encoding: 'utf8',
  });
}

describe('test discovery guard', () => {
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'rental-test-manifest-'));
    scripts = {
      'test:unit': 'vitest run',
      'test:integration': 'tsx test/nested/registered.test.ts',
      'test:live': 'tsx test/live.test.ts',
    };
    manifest = {
      unit: [{ script: 'test:unit', description: 'Unit specs' }],
      integration: [{ script: 'test:integration', description: 'Integration suite' }],
      manual: [{ script: 'test:live', description: 'Live provider suite' }],
    };
    write('scripts/check-test-manifest.mjs', guard);
    write('api/test/nested/registered.test.ts');
    write('api/test/live.test.ts');
    write('api/test/unit.spec.ts');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('accepts classified integration/manual files and automatically discovered unit specs', () => {
    const result = runGuard();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('rejects a new test file even when no package script was added', () => {
    write('api/test/nested/forgotten.test.ts');
    const result = runGuard();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'API test files without package scripts: test/nested/forgotten.test.ts',
    );
  });

  it('rejects a package script whose test file was deleted', () => {
    rmSync(path.join(root, 'api/test/live.test.ts'));
    const result = runGuard();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'package scripts reference missing test files: test/live.test.ts',
    );
  });

  it('rejects an existing script omitted from the manifest', () => {
    manifest.integration = [];
    const result = runGuard();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unclassified API test scripts: test:integration');
  });
});
