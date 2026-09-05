/**
 * pack-residue — rule unit tests + the GATE over the committed builtin packs
 * (memory-corpus-hygiene P-006 / D-017).
 *
 * The gate is the point: builtin packs SHIP (build-desktop-sidecar.sh copies
 * every file under packages/harness into the bundle), so anything committed
 * under knowledge-packs/ reaches customers. This test is what fails when a
 * future path re-introduces internal references into a shipped artifact.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkPackAdmission,
  findIdentityResidue,
  findPackResidue,
  findPackShapeFaults,
  findShippableTextFaults,
  formatPackResidue,
  resolvePackIdentityEntries,
  PACK_ITEM_MIN_TEXT_CHARS,
  PACK_RESIDUE_RULES,
} from './pack-residue';

/* ────────────────────────────────────────────────────────────────────────
 * FIXTURES ARE SPLIT LITERALS ON PURPOSE.
 *
 * This file is tracked source, so it is scanned by the same three identity-leak
 * lints whose matchers the gate reuses. A fixture that must MATCH one of them
 * therefore cannot be spelled contiguously here — it would red the gate from
 * inside the test written to prevent that exact leak. Same technique (and same
 * reason) as pretooluse-content-lint-identity.test.ts's HOME/USER_SEG.
 * ──────────────────────────────────────────────────────────────────────── */

/** `/home`, unspellable so the class-2 path lint cannot see it in this source. */
const HOME = `/ho${'me'}`;
/** A user segment that is NOT in GENERIC_USERS, so the matcher actually fires. */
const USER_SEG = `quill${'on'}`;
/** A named owner-provenance tag — the `[owner:` marker itself is split too, or
 *  the class-1 lint would capture the truncated name out of this very line. */
const OWNER_TAG = `[own${'er'}:Kes${'trel'} 2026-08-03]`;
/** Synthetic class-3 entries. Never this box's real values — the matcher takes
 *  them as a parameter precisely so a test can stay honest here. */
const SYNTHETIC_ENTRIES: [string, string][] = [
  ['build-hostname', 'zzhost-fixture-9x'],
  ['build-git-email', 'nobody@fixture.invalid'],
];

/** Long enough to clear the length floor, so a test can isolate ONE fault. */
const LONG_CLEAN_BODY =
  'A background job reports the exit code of its last statement, not the command ' +
  'you cared about, so a trailing echo masks a real failure as success.';

describe('findPackResidue', () => {
  it('passes clean, transferable lesson prose', () => {
    const clean =
      'A log may report peer_connected status while its replicator never ingests\n' +
      'operations, causing silent write divergence. Monitor for connections that\n' +
      'remain attached but ingest nothing for the grace period.\n\n' +
      'Provenance: recurred 5× across the fleet — adopted from the fleet candidate queue.';
    expect(findPackResidue(clean)).toEqual([]);
  });

  it('catches each residue class, and reports the offending substring', () => {
    // Calibration: the exact shape the live fleet-lessons pack carried on
    // 2026-08-03, before the renderer was fixed. If this ever stops failing,
    // the rule has been weakened — not the corpus cleaned.
    const dirty =
      'Provenance: recurred 9× across operator, harness:@singleton ' +
      '(signature `183 4072cfad012b class harness liveness`; items EI-9411, EI-9413) ' +
      '— adopted from the fleet candidate queue.';
    const hits = findPackResidue(dirty);
    const byRule = (id: string) => hits.filter((h) => h.rule === id).map((h) => h.match);

    expect(byRule('ledger-id')).toEqual(['EI-9411', 'EI-9413']);
    expect(byRule('scope-literal')).toEqual(['harness:@singleton']);
    expect(byRule('signature-hash')).toEqual(['4072cfad012b']);
    expect(formatPackResidue(hits)).toContain('dangling references');
  });

  it('catches a remote-access target as access-topology (WI-8482 / P-008)', () => {
    // Calibration for the leak this rule was added for: the organic corpus
    // carried rows of exactly this shape and the gate ADMITTED them, because
    // the class-3 identity leg hunts THIS box's literals and a target for a
    // DIFFERENT machine is not one. Addresses are RFC-5737 documentation
    // ranges — this fixture must never spell a real box identity.
    const sshTarget = findPackResidue('Reach the build rig with `ssh deploy@203.0.113.7` first.');
    expect(sshTarget.map((h) => h.rule)).toContain('access-topology');

    const withFlags = findPackResidue('The VM (ssh -p 2222 builder@198.51.100.4) has no GPU.');
    expect(withFlags.map((h) => h.rule)).toContain('access-topology');

    // A bare user@ip needs no ssh verb — the pair alone is access topology.
    const bare = findPackResidue('The sidecar runs as agent@192.0.2.15 and holds the lock.');
    expect(bare.map((h) => h.rule)).toContain('access-topology');
  });

  it('access-topology does not fire on npm scopes, version specs, or a bare hostname', () => {
    // Over-broad here would reject legitimate transferable prose, which is how
    // a gate gets switched off rather than fixed.
    const benign =
      'Import from `@papercusp/sync`, pin tooling with `vitest@4.0.1`, and read ' +
      'the docs at example.com before changing the ssh transport abstraction.';
    expect(findPackResidue(benign).filter((h) => h.rule === 'access-topology')).toEqual([]);
  });

  it('does not fire on ordinary prose that merely looks technical', () => {
    // Guards the rules against being over-broad: short hex, a version, a bare
    // word "harness", and a hyphenated capital that is not a ledger id.
    const benign =
      'Pin the build to commit abc1234 and re-run. The harness config is versioned; ' +
      'see RFC-7231 for the status-code semantics. Retry-After is a header, not an id.';
    expect(findPackResidue(benign)).toEqual([]);
  });

  it('is stateless across calls (the /g regexes must not carry lastIndex)', () => {
    const dirty = 'items EI-1 and EI-2';
    const first = findPackResidue(dirty);
    const second = findPackResidue(dirty);
    expect(second).toEqual(first);
    expect(first).toHaveLength(2);
  });

  it('every rule carries a non-empty id and rationale', () => {
    for (const rule of PACK_RESIDUE_RULES) {
      expect(rule.id).toBeTruthy();
      expect(rule.why.length).toBeGreaterThan(20);
    }
  });

  it('names an agent-session UUID as session-id — ONCE, not also as signature-hash', () => {
    // D-008 lists agent-session ids as tier-3. A UUID's final group is exactly 12
    // hex, so the signature-hash rule ALSO matches it; overlap suppression is what
    // keeps the refusal from naming one string under two rules with two different
    // (one of them wrong) explanations.
    const hits = findPackResidue('Diagnosed by su-1f7ee244-2982-409e-9e7c-0af6184b6763 on the loop.');
    expect(hits.map((h) => h.rule)).toEqual(['session-id']);
    expect(hits[0].match).toBe('1f7ee244-2982-409e-9e7c-0af6184b6763');
  });

  it('still reports a bare 12-hex digest as signature-hash (the UUID case is not a blanket mute)', () => {
    const hits = findPackResidue('signature `4072cfad012b` grouped these.');
    expect(hits.map((h) => h.rule)).toEqual(['signature-hash']);
  });
});

describe('findIdentityResidue — tier-3 THIS-BOX, via the shared detector', () => {
  it('catches this-box literals (class 3) and reports the KEY, never the value', () => {
    const text = `Set the port on ${SYNTHETIC_ENTRIES[0][1]} before the cut.`;
    const hits = findIdentityResidue(text, SYNTHETIC_ENTRIES);
    expect(hits.map((h) => h.rule)).toEqual(['box-identity']);
    expect(hits[0].match).toBe('<build-hostname>');
    // The whole point of reporting the key: the refusal text must not re-leak
    // the literal it just refused, because it lands in logs and coord messages.
    expect(JSON.stringify(hits)).not.toContain(SYNTHETIC_ENTRIES[0][1]);
  });

  it('catches an absolute home path (class 2) with NO entries — the shape leg needs no per-box values', () => {
    // This is the leg that catches a PEER's or a VM's path, which no list of this
    // box's own literals could ever contain.
    const hits = findIdentityResidue(`Config lives at ${HOME}/${USER_SEG}/.papercusp/state.json.`);
    expect(hits.map((h) => h.rule)).toEqual(['box-identity-path']);
    expect(JSON.stringify(hits)).not.toContain(USER_SEG);
  });

  it('catches a NAMED owner-provenance tag (class 1) and redacts the name', () => {
    const hits = findIdentityResidue(`${OWNER_TAG} the owner asked for this behaviour.`);
    expect(hits.map((h) => h.rule)).toEqual(['owner-name']);
    expect(hits[0].match).toBe('<owner-name>');
    expect(JSON.stringify(hits)).not.toContain('Kestrel');
  });

  it('passes clean transferable prose, with and without entries', () => {
    expect(findIdentityResidue(LONG_CLEAN_BODY)).toEqual([]);
    expect(findIdentityResidue(LONG_CLEAN_BODY, SYNTHETIC_ENTRIES)).toEqual([]);
  });

  it('degrades the class-3 leg to a no-op on empty entries (the bare/CI-box posture)', () => {
    const text = `Set the port on ${SYNTHETIC_ENTRIES[0][1]} before the cut.`;
    expect(findIdentityResidue(text, [])).toEqual([]);
  });
});

describe('findPackShapeFaults — the length/kind floor', () => {
  it('refuses a body below the length floor, and says how short it was', () => {
    const hits = findPackShapeFaults({ title: 'Locks', text: 'Use locks.' });
    expect(hits.map((h) => h.rule)).toEqual(['below-length-floor']);
    expect(hits[0].match).toBe('10 chars');
  });

  it(`admits a body at exactly the floor (${PACK_ITEM_MIN_TEXT_CHARS} chars) — the bound is not off by one`, () => {
    const exact = 'x'.repeat(PACK_ITEM_MIN_TEXT_CHARS);
    expect(findPackShapeFaults({ title: 'T', text: exact })).toEqual([]);
    expect(findPackShapeFaults({ title: 'T', text: 'x'.repeat(PACK_ITEM_MIN_TEXT_CHARS - 1) })
      .map((h) => h.rule)).toEqual(['below-length-floor']);
  });

  it('measures the TRIMMED body, so padding cannot buy admission', () => {
    const padded = `${' '.repeat(200)}Use locks.${' '.repeat(200)}`;
    expect(findPackShapeFaults({ title: 'T', text: padded }).map((h) => h.rule)).toEqual([
      'below-length-floor',
    ]);
  });

  it("refuses kind 'user' — a fact about OUR owner is not transferable knowledge", () => {
    const hits = findPackShapeFaults({ title: 'T', text: LONG_CLEAN_BODY, kind: 'user' });
    expect(hits.map((h) => h.rule)).toEqual(['inadmissible-kind']);
  });

  it("ADMITS 'project' and 'reference' — D-008 ships tier-2 dev-infra, so kind is not a tier gate", () => {
    // Pins the ratified two-tier rule ("ship dev-infra too"). If a future change
    // excludes one of these kinds, it contradicts an owner decision and this fails.
    for (const kind of ['project', 'reference', 'feedback']) {
      expect(findPackShapeFaults({ title: 'T', text: LONG_CLEAN_BODY, kind })).toEqual([]);
    }
  });

  it('refuses an empty title (it is prefixed onto the seeded memory text)', () => {
    const hits = findPackShapeFaults({ title: '   ', text: LONG_CLEAN_BODY });
    expect(hits.map((h) => h.rule)).toEqual(['missing-title']);
  });
});

describe('checkPackAdmission — the one gate', () => {
  it('admits a clean, well-shaped item', () => {
    const v = checkPackAdmission(
      { title: 'Background exit codes mislead', text: LONG_CLEAN_BODY, kind: 'feedback' },
      { identityEntries: SYNTHETIC_ENTRIES },
    );
    expect(v.hits).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.identityLiteralsScanned).toBe(true);
  });

  it('scans the TITLE as well as the body — residue there ships too', () => {
    const v = checkPackAdmission(
      { title: 'Fix for EI-9411', text: LONG_CLEAN_BODY, kind: 'feedback' },
      { identityEntries: SYNTHETIC_ENTRIES },
    );
    expect(v.ok).toBe(false);
    expect(v.hits.map((h) => h.rule)).toContain('ledger-id');
  });

  it('reports identityLiteralsScanned:false when no entries were supplied — "nothing to hunt" must not read like "found nothing"', () => {
    const v = checkPackAdmission({ title: 'T', text: LONG_CLEAN_BODY, kind: 'feedback' });
    expect(v.ok).toBe(true);
    expect(v.identityLiteralsScanned).toBe(false);
  });

  it('accumulates every reason at once, so one fix-round names them all', () => {
    const v = checkPackAdmission(
      { title: '', text: `See EI-1 on ${SYNTHETIC_ENTRIES[0][1]}.`, kind: 'user' },
      { identityEntries: SYNTHETIC_ENTRIES },
    );
    expect(new Set(v.hits.map((h) => h.rule))).toEqual(
      new Set(['below-length-floor', 'missing-title', 'inadmissible-kind', 'ledger-id', 'box-identity']),
    );
  });
});

describe('findShippableTextFaults — the raw-file granularity the exporter uses', () => {
  it('applies the text legs but NOT the item-shape floor', () => {
    // A short raw string must not trip the length floor here: the exporter feeds
    // whole FILES, where "title" and "body" are not separable.
    expect(findShippableTextFaults('short')).toEqual([]);
    expect(findShippableTextFaults(`carries EI-1`).map((h) => h.rule)).toEqual(['ledger-id']);
  });

  it('sees FRONTMATTER residue, which a parsed-item view cannot', () => {
    const rawFile = `---\nid: x\ntitle: Fix for EI-9411\nkind: feedback\n---\n${LONG_CLEAN_BODY}\n`;
    expect(findShippableTextFaults(rawFile).map((h) => h.rule)).toEqual(['ledger-id']);
  });
});

describe('committed builtin knowledge packs are fit to ship', () => {
  // Resolved against THIS file rather than harnessPath(): the subject is the
  // repo's committed content, not whatever the running host has mounted.
  const packsRoot = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', '..', '..', '..',
    'libs', 'papercusp', 'packages', 'harness', 'knowledge-packs',
  );

  const packDirs = existsSync(packsRoot)
    ? readdirSync(packsRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    : [];

  it('finds the builtin packs root (else the submodule is not initialized)', () => {
    // Skipping rather than failing on an uninitialized `libs/papercusp`
    // submodule: an empty checkout cannot hide residue, so a hard failure here
    // would only produce spurious reds on partial checkouts.
    if (packDirs.length === 0) {
      console.warn(`[pack-residue] no builtin packs under ${packsRoot} — skipping the ship gate`);
    }
    expect(Array.isArray(packDirs)).toBe(true);
  });

  // P-009: the ship gate now runs the identity legs too, not just the
  // internal-reference residue. The class-2/class-1 legs (absolute paths, named
  // owner tags) are shape-based and run everywhere; the class-3 leg needs THIS
  // box's literals, so on a CI/bare box with no resolvable git identity it
  // degrades to a documented no-op — the same posture as the three gate lints it
  // reuses. That is why the assertion message states which legs actually ran.
  const identityEntries = resolvePackIdentityEntries();

  for (const pack of packDirs) {
    it(`${pack}: no item carries internal references or tier-3 identity`, () => {
      const dir = join(packsRoot, pack);
      const items = readdirSync(dir).filter((f) => f.endsWith('.md'));
      const failures: string[] = [];

      for (const file of items) {
        const path = join(dir, file);
        if (!statSync(path).isFile()) continue;
        const hits = findShippableTextFaults(readFileSync(path, 'utf8'), { identityEntries });
        if (hits.length > 0) {
          failures.push(`${pack}/${file}\n${formatPackResidue(hits)}`);
        }
      }

      expect(
        failures.join('\n\n'),
        failures.length > 0
          ? `Builtin knowledge-pack items SHIP in the desktop bundle. ` +
              `These carry internal references or tier-3 THIS-BOX identity:\n\n` +
              `${failures.join('\n\n')}\n\n` +
              `Fix the item text (or the path that generated it) — do not relax the rule. ` +
              `(this-box literal leg: ${identityEntries.length > 0 ? 'ran' : 'NO-OP — no identity resolved on this box'})`
          : undefined,
      ).toBe('');
    });
  }
});
