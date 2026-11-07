/** Focused diagnostic route; production acceptance remains in the native lifecycle proof. */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultEvidenceRoot } from '@papercusp/verification-harness';
import { expect, inject, it } from 'vitest';
import { localPreflight } from '../test/omp-managed-native-lifecycle';

it('passes installed OMP local MCP preflight before private runtime preparation', async () => {
  expect(inject('papercuspTestLayer')).toBe('integration');
  const evidenceRoot = defaultEvidenceRoot('isolated-integration');
  mkdirSync(evidenceRoot, { recursive: true });
  const evidenceDir = mkdtempSync(join(evidenceRoot, 'omp-native-preflight-'));
  console.info('OMP_NATIVE_PREFLIGHT_EVIDENCE ' + evidenceDir);
  const result = await localPreflight(evidenceDir);
  writeFileSync(join(evidenceDir, 'native-mcp-preflight.json'), JSON.stringify(result));
  expect(result.retained[0]!.hasNativeExecution).toBe(true);
  expect(result.lifecycle.map(row => row.surface)).toEqual(['launch', 'resume', 'wake']);
  expect(result.lifecycle.every(row => row.nativeRefused)).toBe(true);
  expect(result.invoked[0]!.nativeRefused).toBe(true);
}, 180_000);
