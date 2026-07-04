/**
 * lexicon:active_pack endpoint — returns the active brand pack's full term map,
 * resolved through the server twin so the the-hive flag is respected
 * (pui-hive-lexicon-2026-06-06).
 *
 *   npx vitest run lib/agent-tools/lexicon/active_pack.test.ts
 */
import { afterEach, describe, expect, it } from 'vitest';
import { setFlagOverridesForTest } from '@papercusp/flags/test';

import { refreshLexiconPack } from '../../lexicon/configure';
import activePackTool from './active_pack';

afterEach(() => setFlagOverridesForTest(null));

interface PackResult {
  ok: boolean;
  packId: string;
  label: string;
  terms: Record<string, { one: string; other: string }>;
}

async function callTool(): Promise<PackResult> {
  // The tool ignores args + ctx (reads the cached server pack); pass empties.
  const res = (await activePackTool.handler({} as never, {} as never)) as {
    content: { text: string }[];
  };
  return JSON.parse(res.content[0].text) as PackResult;
}

describe('lexicon:active_pack', () => {
  it('returns the classic map when the-hive is off', async () => {
    setFlagOverridesForTest({ 'papercusp-the-hive': false });
    await refreshLexiconPack();
    const out = await callTool();
    expect(out.ok).toBe(true);
    expect(out.packId).toBe('classic');
    // Owner directive 2026-07-04 (restore-pot-lexicon-public-release): the classic
    // baseline `pot` is "Pot" (Hive now lives only in the the-hive pack). Supersedes
    // the 2026-06-16 "pot is canonically Hive in the baseline" directive.
    expect(out.terms.pot).toEqual({ one: 'Pot', other: 'Pots' });
    expect(out.terms.fleet.one).toBe('Fleet');
    expect(out.terms.operator.one).toBe('Operator');
    expect(out.terms.cupboard.one).toBe('Cupboard');
  });

  it('returns the the-hive (bee) map when the flag is on', async () => {
    setFlagOverridesForTest({ 'papercusp-the-hive': true });
    await refreshLexiconPack();
    const out = await callTool();
    expect(out.packId).toBe('the-hive');
    expect(out.terms.pot).toEqual({ one: 'Hive', other: 'Hives' });
    // D-007: live agents → Colony (Swarm reassigned to the deployment unit).
    expect(out.terms.fleet.one).toBe('Colony');
    expect(out.terms.operator.one).toBe('Sentinel'); // renamed from "Sentinel Bee" (hive-agent-tabs P-003)
    expect(out.terms.brain.one).toBe('Queen');
    expect(out.terms.human.one).toBe('Keeper');
    expect(out.terms.cupboard.one).toBe('Comb');
    expect(out.terms.contributor.one).toBe('Bee');
    // Kept names stay identical across packs.
    expect(out.terms.harness.one).toBe('Harness');
  });

  it('covers every term key (no gaps for the pui to fall through on)', async () => {
    setFlagOverridesForTest({ 'papercusp-the-hive': true });
    await refreshLexiconPack();
    const out = await callTool();
    for (const k of [
      'pot', 'fleet', 'operator', 'brain', 'contributor', 'human', 'chunk',
      'cupboard', 'node', 'substrate', 'blueprint', 'harness', 'signal',
    ]) {
      expect(out.terms[k]?.one, `missing term ${k}`).toBeTruthy();
      expect(out.terms[k]?.other, `missing plural ${k}`).toBeTruthy();
    }
  });
});
