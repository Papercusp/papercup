/** P026: authored, preregistered controls through the exposed graph handler.
 * These are calibration cases, not real-task or backend-cost certification.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn().mockResolvedValue(true) }));
import graphQuery from '../agent-tools/gitnexus/query';
import type { CodeIntelAnswer } from './contracts';
import { nativeLanguageControls } from './fair-comparison-corpus';

const controls = nativeLanguageControls();
const operations = { callers: 'callers', callees: 'callees', definition: 'symbol', impact: 'impact' } as const;
const cases = controls.cases.filter(kase => kase.intent in operations);
const keys = new Map(controls.keys.map(key => [key.caseId, key]));

describe('native P026 multilingual authored graph acceptance', () => {
  it.each(cases)('$id', async kase => {
    const root = mkdtempSync(join(tmpdir(), 'native-language-acceptance-'));
    const path = kase.anchorFile!;
    const source = controls.files[path]!;
    const configured = kase.configuration === 'configured';
    try {
      for (const [file, text] of Object.entries(controls.files)) {
        if (dirname(file) !== dirname(path) || (!configured && file !== path)) continue;
        mkdirSync(dirname(join(root, file)), { recursive: true });
        writeFileSync(join(root, file), text);
      }
      if (kase.sourceState === 'stale') writeFileSync(join(root, path),
        source.replace('return target()', 'return 0').replace('{ target() }', '{ 0 }'));
      if (kase.sourceState === 'deleted') rmSync(join(root, path));
      const op = operations[kase.intent as keyof typeof operations];
      const answer = (await graphQuery.handler(graphQuery.args.parse({
        op, name: kase.subject, paths: [path],
        ...(op === 'callers' ? {} : { file_path: path }),
        ...(op === 'impact' ? { max_depth: kase.depth } : {}),
      }), { projectDir: root } as never) as { data: CodeIntelAnswer }).data;
      const unsupported = !['javascript', 'typescript'].includes(kase.language!);
      // The tool emits call sites for callees; the preregistered answer unit is
      // its measured callee declaration. Retain raw sites as well as scored units.
      const sites = (op === 'callees' ? answer.evidence?.relationships.map(edge => edge.target?.site)
        .filter((site): site is NonNullable<typeof site> => Boolean(site)) ?? [] : answer.sites)
        .map(site => `${site.path}:${site.line1}`).sort();
      console.log('NATIVE_LANGUAGE_ACCEPTANCE=' + JSON.stringify({ caseId: kase.id,
        source: kase.source, language: kase.language, configuration: kase.configuration,
        sourceState: kase.sourceState, fixtureHash: kase.sourceFingerprint,
        currentSourceHash: kase.sourceState === 'deleted' ? null : createHash('sha256').update(
          kase.sourceState === 'stale' ? source.replace('return target()', 'return 0').replace('{ target() }', '{ 0 }') : source).digest('hex'),
        tool: 'graph:query', op, sites, rawSites: answer.sites, expectedSites: keys.get(kase.id)!.sites,
        error: answer.error, latencyMs: answer.latencyMs,
        evidence: answer.evidence, authoredControlOnly: true }));
      if (unsupported) {
        expect(answer.error, kase.id).toMatch(/unsupported/i);
        expect(sites).toEqual([]);
        expect(answer.freshness.health).not.toBe('healthy');
        expect(answer.evidence?.languageCapabilities).toContainEqual(expect.objectContaining({
          language: kase.language, status: 'unsupported' }));
      } else if (kase.sourceState === 'deleted' || (kase.tags.includes('absence') && op !== 'callers')) {
        // No declaration or a missing file is an explicit unavailable answer;
        // preserve it instead of scoring it as certified semantic absence.
        expect(answer.error, kase.id).not.toBeNull();
        expect(sites).toEqual([]);
      } else {
        expect(answer.error, kase.id).toBeNull();
        expect(sites).toEqual([...keys.get(kase.id)!.sites].sort());
        expect(answer.evidence?.sourceScope.repositoryId).toBeTruthy();
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 60_000);
});
