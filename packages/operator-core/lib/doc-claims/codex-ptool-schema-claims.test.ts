import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import improvementsCapture from '../agent-tools/improvements/capture';
import locksAcquire from '../agent-tools/locks/acquire';
import {
  CODEX_PTOOL_ARG_CLAIMS,
  judgeCodexPtoolClaims,
  objectShapeKeys,
  type ToolArgClaim,
} from './codex-ptool-schema-claims';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CODEX_PROMPT = join(REPO_ROOT, 'apps/operator/prompts/papercusp-su.codex.md');

const LIVE_TOOLS: ReadonlyArray<readonly [string, unknown]> = [
  ['locks:acquire', (locksAcquire as { args?: unknown }).args],
  ['improvements:capture', (improvementsCapture as { args?: unknown }).args],
];

function liveKeyMap(): Map<string, string[] | null> {
  return new Map(LIVE_TOOLS.map(([name, args]) => [name, objectShapeKeys(args)]));
}

describe('objectShapeKeys — the instrument itself', () => {
  // The judge is only as good as this unwrap. During development it read
  // ZodPreprocess `_def.in` (the transform) instead of `_def.out`, which
  // returned ZERO keys for improvements:capture — a false absence that would
  // have made every `rejected` assertion pass vacuously. These pin both the
  // reachability and the null-vs-empty distinction that catches it.

  it('reaches the real shape of every tool this doc-claim covers', () => {
    for (const [name, args] of LIVE_TOOLS) {
      const keys = objectShapeKeys(args);
      expect(keys, `${name}: shape unreachable — the guard would be unmeasured`).not.toBeNull();
      expect(keys!.length, `${name}: reached an EMPTY shape, which reads as "declares nothing"`).toBeGreaterThan(0);
    }
  });

  it('returns null (not []) when the shape genuinely cannot be reached', () => {
    expect(objectShapeKeys(undefined)).toBeNull();
    expect(objectShapeKeys({})).toBeNull();
    expect(objectShapeKeys({ _def: {} })).toBeNull();
  });

  it('unwraps a ZodPreprocess-shaped wrapper via .out, not .in', () => {
    const wrapped = { _def: { in: { shape: { wrong: 1 } }, out: { shape: { right: 1 } } } };
    expect(objectShapeKeys(wrapped)).toEqual(['right']);
  });
});

describe('judgeCodexPtoolClaims — fixture controls (must fail in BOTH directions)', () => {
  const prose = 'x `locks:acquire` takes `paths` x';
  const claim: ToolArgClaim = {
    tool: 'locks:acquire',
    accepted: ['paths'],
    rejected: ['files'],
    prose: ['`locks:acquire` takes `paths`'],
  };

  it('passes when prose and live schema agree', () => {
    const keys = new Map([['locks:acquire', ['paths', 'intent']]]);
    expect(judgeCodexPtoolClaims(prose, keys, [claim])).toEqual([]);
  });

  it('catches an accepted key that the schema dropped (a rename)', () => {
    const keys = new Map([['locks:acquire', ['file_paths', 'intent']]]);
    const v = judgeCodexPtoolClaims(prose, keys, [claim]);
    expect(v.map((x) => x.kind)).toContain('claimed-accepted-absent');
  });

  it('catches a rejected key that the schema later accepted', () => {
    const keys = new Map([['locks:acquire', ['paths', 'files']]]);
    const v = judgeCodexPtoolClaims(prose, keys, [claim]);
    expect(v.map((x) => x.kind)).toContain('claimed-rejected-present');
  });

  it('catches prose that no longer carries the claim', () => {
    const keys = new Map([['locks:acquire', ['paths']]]);
    const v = judgeCodexPtoolClaims('unrelated text', keys, [claim]);
    expect(v.map((x) => x.kind)).toContain('missing-prose');
  });

  it('reports an unreachable schema as a violation, never as a pass', () => {
    const keys = new Map<string, string[] | null>([['locks:acquire', null]]);
    const v = judgeCodexPtoolClaims(prose, keys, [claim]);
    expect(v.map((x) => x.kind)).toContain('unreachable-schema');
  });
});

describe('Codex ptool fallback prompt: argument claims match the live schemas', () => {
  it('teaches only argument keys the live tools actually declare', () => {
    const promptText = readFileSync(CODEX_PROMPT, 'utf8');
    const violations = judgeCodexPtoolClaims(promptText, liveKeyMap());
    expect(
      violations,
      violations.map((v) => `[${v.kind}] ${v.tool}: ${v.detail}`).join('\n'),
    ).toEqual([]);
  });

  it('still directs the reader to argSchema rather than to guessing', () => {
    const promptText = readFileSync(CODEX_PROMPT, 'utf8');
    // The whole defect was framing tools:find as a NAME lookup, so agents read
    // past the schema and guessed. If this pointer is removed, the key table
    // above still passes while the guidance stops working.
    expect(promptText).toContain('argSchema');
    expect(promptText).toMatch(/Read it before any write call/i);
  });

  it('covers every tool named in the claim table', () => {
    const covered = new Set(LIVE_TOOLS.map(([name]) => name));
    for (const claim of CODEX_PTOOL_ARG_CLAIMS) {
      expect(covered, `${claim.tool} is claimed but has no live schema wired into this test`).toContain(claim.tool);
    }
  });
});
