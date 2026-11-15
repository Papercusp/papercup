import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setImmediate as immediate } from 'node:timers/promises';

const synchronousIo = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  return Object.fromEntries(Object.entries(actual).map(([name, value]) => [name,
    ['openSync', 'fstatSync', 'readFileSync', 'mkdtempSync', 'writeFileSync'].includes(name)
      ? (...args: unknown[]) => {
        synchronousIo.calls.push(name);
        return (value as (...args: unknown[]) => unknown)(...args);
      }
      : value,
  ]));
});

import { buildDetachedTestRunRequest } from './run';
import { testRunDeadline } from './run-artifacts';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

const chunkBytes = 4 * 1024 * 1024;
it.each([chunkBytes - 1, chunkBytes, chunkBytes + 1, chunkBytes * 9 + 1])(
  'retains all %i compiled bytes without synchronous filesystem IO or starving a ready callback',
  async size => {
    const root = await mkdtemp(join(tmpdir(), 'testing-core-async-'));
    directories.push(root);
    // Distinct bytes after every boundary expose accidental prefixes/reordering.
    const source = Buffer.alloc(size);
    for (let offset = 0; offset < size; offset += 65_536) {
      source.fill((offset / 65_536) % 251, offset, Math.min(size, offset + 65_536));
    }
    source[size - 1] = 255;
    const core = join(root, 'core.mjs');
    await writeFile(core, source);
    const expected = { schemaVersion: 1, sourceSha256: 'a'.repeat(64),
      artifactSha256: createHash('sha256').update(source).digest('hex') };

    // Positive control: prove the tripwire actually observes native sync IO.
    synchronousIo.calls.length = 0;
    fs.readFileSync(core);
    expect(synchronousIo.calls).toContain('readFileSync');
    synchronousIo.calls.length = 0;
    let callbackRan = false;
    const callback = immediate().then(() => { callbackRan = true; });
    const request = await buildDetachedTestRunRequest({ root, files: ['feature.test.ts'],
      deadline: testRunDeadline(120_000), compiledCore: { moduleUrl: pathToFileURL(core).href, expected } });
    const reportDirectory = dirname(request.detachedReportArtifacts![0]!.reportPath);
    directories.push(reportDirectory);
    const calls = [...synchronousIo.calls];
    const progressed = callbackRan;
    await callback;

    expect(calls).toEqual([]);
    expect(progressed).toBe(true);
    const retained = await readFile(join(reportDirectory, 'testing-core.retained.mjs'));
    expect(retained.equals(source)).toBe(true);
    expect(createHash('sha256').update(retained).digest('hex')).toBe(expected.artifactSha256);
  },
);
