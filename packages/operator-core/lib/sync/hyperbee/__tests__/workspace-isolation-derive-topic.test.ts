/**
 * workspace-isolation-derive-topic.test.ts — Brief AD (workspace/tenancy
 * isolation), the PG-free GAP layer over `derive-swarm-topic`.
 *
 * The basics are ALREADY covered and are NOT duplicated here:
 *   - determinism, 32-byte length, gh/local/hive domain separation, explicit-
 *     topic verbatim → derive-swarm-topic.test.ts
 *   - ALS workspace context isolation incl. "isolates concurrent scopes (no
 *     cross-talk)" + nested/wildcard/undefined → workspace-als.test.ts
 *
 * This file adds the two genuine gaps AD calls for:
 *   1. CROSS-WORKSPACE distinctness as a fuzzed property — the tenancy boundary:
 *      distinct workspace_id (same slug) → distinct swarm topics, and the
 *      (ws,slug)→topic mapping is injective over the live slash-free id domain.
 *      (The existing test differs gh-from-local, never ws-A-from-ws-B.)
 *   2. The `local:<ws>/<slug>` DELIMITER AMBIGUITY (EI-1690), pinned as a
 *      characterization: an unescaped `/` lets a slashful workspace_id collide
 *      two DISTINCT tenancy pairs onto ONE topic. Latent today (harness_slug is
 *      slash-free by pattern + no slashful ws ids in use), but unguarded.
 *
 * PG-free + deterministic (seeded fast-check). The S0/S1 routing MEAT of AD
 * (the EI-126 default-mis-route guard, write-routing-to-correct-workspace E2E,
 * cross-workspace PG-row isolation, multi-ws-per-box) is INTEGRATION and is
 * deferred — see findings-AD.md.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { deriveSwarmTopic } from '../derive-swarm-topic';

// Live id domain: non-empty, lowercase-alnum, SLASH-FREE (matches how ids are
// used today; harness_slug is slash-free by its ^[a-z0-9][a-z0-9-]*$ pattern).
// Built from a fixed alphabet to avoid any fast-check string-API version drift.
const ALPHA = 'abcdefghijklmnopqrstuvwxyz0123456789';
const slugId = fc
  .array(fc.integer({ min: 0, max: ALPHA.length - 1 }), { minLength: 1, maxLength: 10 })
  .map((idx) => idx.map((i) => ALPHA[i]).join(''));

describe('AD workspace isolation — derive-swarm-topic cross-workspace distinctness (gap layer)', () => {
  it('distinct workspace_id (same slug) → DISTINCT topics (the tenancy boundary)', () => {
    fc.assert(
      fc.property(slugId, slugId, slugId, (wsA, wsB, slug) => {
        fc.pre(wsA !== wsB);
        const a = deriveSwarmTopic({ kind: 'local', workspace_id: wsA, harness_slug: slug });
        const b = deriveSwarmTopic({ kind: 'local', workspace_id: wsB, harness_slug: slug });
        expect(a.equals(b)).toBe(false);
      }),
      { numRuns: 200, seed: 0xad1 },
    );
  });

  it('distinct harness_slug (same workspace) → DISTINCT topics', () => {
    fc.assert(
      fc.property(slugId, slugId, slugId, (ws, sA, sB) => {
        fc.pre(sA !== sB);
        const a = deriveSwarmTopic({ kind: 'local', workspace_id: ws, harness_slug: sA });
        const b = deriveSwarmTopic({ kind: 'local', workspace_id: ws, harness_slug: sB });
        expect(a.equals(b)).toBe(false);
      }),
      { numRuns: 200, seed: 0xad2 },
    );
  });

  it('(ws,slug) → topic is INJECTIVE over the slash-free id domain (no distinct pair collides)', () => {
    fc.assert(
      fc.property(slugId, slugId, slugId, slugId, (wsA, sA, wsB, sB) => {
        fc.pre(wsA !== wsB || sA !== sB);
        const a = deriveSwarmTopic({ kind: 'local', workspace_id: wsA, harness_slug: sA });
        const b = deriveSwarmTopic({ kind: 'local', workspace_id: wsB, harness_slug: sB });
        expect(a.equals(b)).toBe(false);
      }),
      { numRuns: 300, seed: 0xad3 },
    );
  });
});

describe('AD workspace isolation — local:<ws>/<slug> delimiter ambiguity (CHARACTERIZATION · EI-1690)', () => {
  it('a SLASHFUL workspace_id collides two DISTINCT tenancy pairs onto ONE topic (the latent gap)', () => {
    // ("a/x","y") and ("a","x/y") both serialize to "local:a/x/y" → same sha256.
    // harness_slug "x/y" is itself invalid by the slug pattern, so this is only
    // reachable via a slashful WORKSPACE id (no enforced format guard — EI-1690).
    // CHARACTERIZATION of the CURRENT behavior: FLIP this to .not.toBe(true) once
    // the binding is length-prefixed/escaped or workspace_id is slash-constrained.
    const a = deriveSwarmTopic({ kind: 'local', workspace_id: 'a/x', harness_slug: 'y' });
    const b = deriveSwarmTopic({ kind: 'local', workspace_id: 'a', harness_slug: 'x/y' });
    expect(a.equals(b)).toBe(true); // ⚠ EI-1690 — distinct tenancy pairs, identical topic
  });
});
