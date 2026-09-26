/**
 * parseAllowlistedProcessEnv looks up its five keys directly instead of parsing the
 * whole environ block (EI-24342043796392664). These cases pin that it still gives
 * exactly the answer the full parse gives, restricted to the allowlist.
 */
import { describe, expect, it } from 'vitest';
import { parseNulSeparatedEnvironment } from '@papercusp/host-platform/process-environment';
import {
  parseAllowlistedProcessEnv,
  readProcessMetadata,
  readProcessMetadataAsync,
} from './process-metadata';

const ALLOWED = [
  'PAPERCUSP_AGENT',
  'PAPERCUSP_AGENT_ROLE',
  'PAPERCUSP_FLEET_ROLE',
  'PAPERCUSP_BUILD_VERSION',
  'PAPERCUSP_BUILD_SHA',
];

/** The pre-change implementation: full parse, then filter. */
function reference(environ: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parseNulSeparatedEnvironment(environ))) {
    const trimmed = value.trim();
    if (ALLOWED.includes(key) && trimmed && trimmed.length <= 160 && /^[A-Za-z0-9._:/@+~-]+$/.test(trimmed)) {
      out[key] = trimmed;
    }
  }
  return out;
}

const env = (...entries: string[]) => entries.join('\0');

const CASES: Record<string, string> = {
  'key at the very start': env('PAPERCUSP_AGENT=su', 'HOME=/h'),
  'key after other entries': env('HOME=/h', 'PAPERCUSP_BUILD_SHA=abc123', 'PATH=/bin'),
  'duplicate key — first occurrence wins': env('PAPERCUSP_AGENT_ROLE=first', 'PAPERCUSP_AGENT_ROLE=second'),
  'prefix key does not shadow the longer key': env('PAPERCUSP_AGENT_ROLE=role', 'PAPERCUSP_AGENT=agent'),
  'longer key alone does not satisfy the prefix key': env('PAPERCUSP_AGENT_ROLE=role'),
  'value embedded in another value is not a key': env('NOTE=xPAPERCUSP_AGENT=fake', 'HOME=/h'),
  'unsafe value is dropped': env('PAPERCUSP_BUILD_VERSION=has space', 'PAPERCUSP_BUILD_SHA=ok'),
  'empty value is dropped': env('PAPERCUSP_FLEET_ROLE=', 'PAPERCUSP_AGENT=su'),
  'trailing NUL': `${env('PAPERCUSP_BUILD_VERSION=1.2.3', 'PAPERCUSP_BUILD_SHA=deadbeef')}\0`,
  'all five keys': env(
    'PAPERCUSP_AGENT=a',
    'PAPERCUSP_AGENT_ROLE=b',
    'PAPERCUSP_FLEET_ROLE=c',
    'PAPERCUSP_BUILD_VERSION=d',
    'PAPERCUSP_BUILD_SHA=e',
  ),
  'no allowlisted keys': env('HOME=/h', 'PATH=/bin:/usr/bin'),
};

describe('parseAllowlistedProcessEnv — equivalence with the full parse', () => {
  for (const [name, environ] of Object.entries(CASES)) {
    it(name, () => {
      expect(parseAllowlistedProcessEnv(environ)).toEqual(reference(environ));
    });
  }

  it('CALIBRATION: the cases are not vacuous — most of them extract something', () => {
    const nonEmpty = Object.values(CASES).filter((e) => Object.keys(reference(e)).length > 0);
    expect(nonEmpty.length).toBeGreaterThanOrEqual(8);
    expect(parseAllowlistedProcessEnv(CASES['duplicate key — first occurrence wins'])).toEqual({
      PAPERCUSP_AGENT_ROLE: 'first',
    });
  });

  it('null and empty input yield no keys', () => {
    expect(parseAllowlistedProcessEnv(null)).toEqual({});
    expect(parseAllowlistedProcessEnv('')).toEqual({});
  });
});

describe('readProcessMetadataAsync', () => {
  it('reads the same metadata as the synchronous reader for a live process', async () => {
    const sync = readProcessMetadata(process.pid, 'node test');
    const async = await readProcessMetadataAsync(process.pid, 'node test');
    expect(async).toEqual(sync);
    expect(async.executable).not.toBeNull();
  });

  it('falls back to the cmdline projection for a pid that does not exist', async () => {
    await expect(readProcessMetadataAsync(-1, '/usr/bin/worker --x')).resolves.toEqual({
      executable: 'worker',
      role: null,
      build: null,
    });
  });
});
