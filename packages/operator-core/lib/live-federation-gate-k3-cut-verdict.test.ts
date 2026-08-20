/**
 * live-federation-gate-k3-cut-verdict.test.ts — WI-37144 guard for the K3 CUT leg of
 * papercusp-desktop/bin/two-instance-hive-from-repo-smoke.sh.
 *
 * WHAT WENT WRONG (the defect this pins shut, measured 2026-08-09).
 *
 * The K3 CUT leg is a SIX-WAY AND that renders as the single word FAIL. On the 11:01Z witness
 * run it printed `FAIL (B_DEV-new=0 remaining-on-B=0 A-new=1)` — and that was carried for two
 * wakes as "the revocation cut may be broken", i.e. a release blocker. It was not. FIVE of the
 * six conjuncts passed, INCLUDING BOTH conjuncts that assert the cut (`B_DEV-new=0` = B's own
 * device holds no new-epoch key; `A-new=1` = the owner does). The sole failure was
 * `k3_remaining >= 1`, the ANTI-CONFOUND conjunct, which asks a different question entirely:
 * did a REMAINING member's new-epoch row still reach B, proving B is connected-but-cut rather
 * than merely disconnected? A verdict word cannot carry that distinction, and "I could not rule
 * out a confound" and "the property is violated" have opposite remediations.
 *
 * WHY IT READ 0 (and the retraction that matters more than the fix).
 *
 * `k3_remaining` was a SINGLE-SHOT read fired immediately after K2's epoch-advance poll broke.
 * K1 above breaks on its FIRST iteration, so B had ~0 seconds to receive the remaining member's
 * new-epoch row. It was recorded at the time as "structurally unsatisfiable at 2 members" — the
 * reasoning being that once B is revoked only A remains, so the only new-epoch row is A's own
 * and there is nothing for B to receive.
 *
 * ⛔ THAT CLAIM WAS WRONG, AND IS REFUTED BY MEASUREMENT. Epoch-key rows federate to B SEALED to
 * the holder's device, so the remaining member's row is EXPECTED to reach B and be undecryptable
 * there. The adjacent matrix rig (papercusp-desktop/bin/lib/scenarios/b3-revocation.sh — same
 * revoke endpoint, potSlug/hive scope) observes exactly that and says so in its own witness text:
 * banked run 232013 has B holding `hello-world-pot|1|sXuPh9DH…|remote`, the OWNER's device row at
 * the new epoch, annotated "the epoch-1 row B did receive is sealed to the owner's device,
 * unreadable by B". Run 223519 shows TWO such rows. The condition is satisfiable at this member
 * count; the smoke was measuring before delivery could happen. The matrix never saw 0 because it
 * dumps the same tables only after its post-ban content probe, tens of seconds later.
 *
 * So this file guards TWO things, and the second is the one that actually cost time:
 *   1. the POLL — `k3_remaining` must not regress to a single-shot read, and
 *   2. the VERDICT — a failing anti-confound must never again render as a failing cut.
 *
 * ⚠ ASYMMETRY, deliberate — do not "tidy" the two reads into one loop. `k3_remaining` asserts
 * PRESENCE, so it is polled (a bounded wait can only remove a FALSE fail). `k3_bdev` asserts
 * ABSENCE, and polling "until absent" is meaningless, so it is read ONCE and AFTER the presence
 * loop settles — the latest decidable moment, which makes the cut assertion STRICTLY STRONGER
 * than the old early read: B has had the full delivery window in which to wrongly receive a
 * new-epoch key for its own device, and still holds none.
 *
 * STATIC leg: pins the poll, the read order, and the recorded refutation in source.
 * BEHAVIORAL leg: extracts the REAL predicate + verdict chain out of the shipping bash and evals
 * it under bash against fixtures, so the branch a reader acts on is the branch that ships.
 *
 *   cd packages/operator-core && npx vitest run lib/live-federation-gate-k3-cut-verdict.test.ts
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_REL = join('papercusp-desktop', 'bin', 'two-instance-hive-from-repo-smoke.sh');

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, SCRIPT_REL))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not locate repo root containing ${SCRIPT_REL}`);
}

// PROBE_SCRIPT exists so falsifiability can be proven by tier-2 COPY-OUT (mutate a copy OUTSIDE
// the tree and point the test at it) rather than by mutating the shared checkout — git-sync sweeps
// the whole working tree every few minutes, so an in-tree mutant can be committed by a sweep even
// when nothing goes wrong and no trap fires. See scripts/mutation-probe.sh.
const SCRIPT_PATH = process.env.PROBE_SCRIPT || join(repoRoot(), SCRIPT_REL);
const SRC = readFileSync(SCRIPT_PATH, 'utf8');

/**
 * Slice the REAL predicate + verdict chain out of the shipping script, so the behavioral leg
 * cannot drift from what runs. Anchored on content, never on line numbers.
 */
function extractVerdictBlock(): string {
  const lines = SRC.split('\n');
  const predicateIdx = lines.findIndex(
    (l) => l.includes('rk_cut_ok=1') && l.includes('$k3_bdev') && l.includes('$k3_remaining'),
  );
  if (predicateIdx < 0) throw new Error('K3 predicate line not found — did the conjunction move?');
  const ifIdx = lines.findIndex(
    (l, i) => i > predicateIdx && /^\s*if \[ "\$rk_cut_ok" = 1 \]; then\s*$/.test(l),
  );
  if (ifIdx < 0) throw new Error('K3 verdict `if` not found after the predicate');
  const endIdx = lines.findIndex((l, i) => i > ifIdx && /^\s*fi\s*$/.test(l));
  if (endIdx < 0) throw new Error('K3 verdict `fi` not found');
  return lines.slice(predicateIdx, endIdx + 1).join('\n');
}

interface Fixture {
  B_DEV: string;
  k3_bdev: string;
  k3_remaining: string;
  a_new: string;
}

/** Run the extracted block under bash with fixture values; return the rendered verdict. */
function renderVerdict(fx: Fixture): { verdict: string; cutOk: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fedgate-k3-verdict-'));
  const harness = join(dir, 'k3.sh');
  const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  writeFileSync(
    harness,
    [
      '#!/usr/bin/env bash',
      // The shipping script runs without strict mode; mirror it so the extracted block behaves
      // exactly as it does in situ rather than under a stricter shell than production.
      `B_DEV=${q(fx.B_DEV)}`,
      `k3_bdev=${q(fx.k3_bdev)}`,
      `k3_remaining=${q(fx.k3_remaining)}`,
      `a_new=${q(fx.a_new)}`,
      'CUR_EPOCH=0',
      'NEW_EPOCH=1',
      'EPOCH_KEY_PROBE_TRIES=20',
      'rk_cut_ok=0',
      extractVerdictBlock(),
      'printf "VERDICT=%s\\n" "$k3_why"',
      'printf "CUTOK=%s\\n" "$rk_cut_ok"',
      '',
    ].join('\n'),
    'utf8',
  );
  const run = spawnSync('bash', [harness], { encoding: 'utf8' });
  const out = `${run.stdout ?? ''}`;
  const verdict = /^VERDICT=(.*)$/m.exec(out)?.[1] ?? '';
  const cutOk = /^CUTOK=(.*)$/m.exec(out)?.[1] ?? '';
  // A harness that silently produced nothing would make every "does not contain" assertion below
  // pass vacuously — that is the whole false-green shape this repo keeps re-learning.
  expect(verdict, `harness produced no verdict (stderr: ${run.stderr})`).not.toBe('');
  return { verdict, cutOk };
}

describe('K3 CUT — the anti-confound is polled, and a failing anti-confound is not a failing cut', () => {
  describe('STATIC — the shipping script', () => {
    it('reads k3_remaining inside a bounded poll, not single-shot', () => {
      // The presence read must sit inside a `for … EPOCH_KEY_PROBE_TRIES` loop with a sleep,
      // matching the K0/K1/K2 idiom the script already uses for every cross-instance read.
      const loop =
        /for _k3_i in \$\(seq 1 "\$\{EPOCH_KEY_PROBE_TRIES:-20\}"\); do([\s\S]*?)\n {2}done/.exec(SRC);
      expect(loop, 'k3_remaining poll loop is gone — it must not regress to a single-shot read').not.toBeNull();
      expect(loop![1]).toContain('k3_remaining=');
      expect(loop![1]).toContain("member_device_pubkey<>'$B_DEV'");
      expect(loop![1]).toMatch(/sleep 3/);
    });

    it('reads k3_bdev exactly once, AFTER the presence poll (absence is read at the latest moment)', () => {
      const bdevReads = SRC.match(/^\s*k3_bdev="\$\(drv_psql/gm) ?? [];
      expect(bdevReads.length, 'k3_bdev must be read exactly once').toBe(1);

      const loopEnd = SRC.indexOf('done', SRC.indexOf('for _k3_i in'));
      const bdevAt = SRC.search(/^\s*k3_bdev="\$\(drv_psql/m);
      expect(loopEnd).toBeGreaterThan(0);
      expect(
        bdevAt,
        'k3_bdev (absence) must be read AFTER the k3_remaining poll settles — reading it early is the weaker assertion the fix replaced',
      ).toBeGreaterThan(loopEnd);
    });

    it('records that "structurally unsatisfiable at 2 members" was REFUTED, so it cannot be reinstated', () => {
      // The retraction is load-bearing: the next reader who sees remaining-on-B=0 will otherwise
      // re-derive the same wrong conclusion and delete the poll as pointless.
      const k3 = SRC.slice(SRC.indexOf('# K3 CUT —'), SRC.indexOf('K4b CONTENT CUT'));
      expect(k3).toMatch(/REFUTED BY MEASUREMENT/);
      expect(k3).toMatch(/b3-revocation\.sh/);
      expect(k3).toMatch(/sealed/i);
    });
  });

  describe('BEHAVIORAL — the real predicate + verdict chain, evaluated under bash', () => {
    it('PASSes only when the cut holds AND the anti-confound was measurable', () => {
      const { verdict, cutOk } = renderVerdict({ B_DEV: 'dev-b', k3_bdev: '0', k3_remaining: '1', a_new: '1' });
      expect(verdict).toMatch(/^PASS /);
      expect(cutOk).toBe('1');
    });

    it('the 11:01Z shape (B_DEV-new=0 remaining-on-B=0 A-new=1) reads as ANTI-CONFOUND UNMEASURABLE, never as a broken cut', () => {
      const { verdict, cutOk } = renderVerdict({ B_DEV: 'dev-b', k3_bdev: '0', k3_remaining: '0', a_new: '1' });
      expect(verdict).toContain('ANTI-CONFOUND UNMEASURABLE');
      expect(verdict).toContain('the cut itself is NOT contradicted');
      // The regression in one line: this must NOT be readable as the cut having failed.
      expect(verdict).not.toContain('CUT BROKEN');
      expect(cutOk).toBe('0');
    });

    it('a genuinely broken cut (B holds a new-epoch key for its OWN device) says CUT BROKEN', () => {
      const { verdict, cutOk } = renderVerdict({ B_DEV: 'dev-b', k3_bdev: '1', k3_remaining: '1', a_new: '1' });
      expect(verdict).toContain('CUT BROKEN');
      expect(verdict).not.toContain('ANTI-CONFOUND');
      expect(cutOk).toBe('0');
    });

    it('CUT BROKEN outranks a simultaneously-unmeasurable anti-confound', () => {
      // Both conjuncts fail at once; the security-relevant one must be the one reported.
      const { verdict } = renderVerdict({ B_DEV: 'dev-b', k3_bdev: '2', k3_remaining: '0', a_new: '1' });
      expect(verdict).toContain('CUT BROKEN');
    });

    it('an unresolvable B_DEV is INCONCLUSIVE — it ran no query and is not evidence about the cut', () => {
      const { verdict, cutOk } = renderVerdict({ B_DEV: '', k3_bdev: '0', k3_remaining: '0', a_new: '1' });
      expect(verdict).toContain('INCONCLUSIVE');
      expect(verdict).toContain('NOT evidence about the cut');
      expect(verdict).not.toContain('CUT BROKEN');
      expect(cutOk).toBe('0');
    });

    it('an UNREAD anti-confound count is labelled <unread>, not silently rendered as 0', () => {
      // An empty psql result means "the query never ran", which is not the same claim as "zero
      // rows" — the script's own [K2 PRE] comment makes that distinction and this leg must too.
      const { verdict } = renderVerdict({ B_DEV: 'dev-b', k3_bdev: '0', k3_remaining: '', a_new: '1' });
      expect(verdict).toContain('ANTI-CONFOUND UNMEASURABLE');
      expect(verdict).toContain('<unread>');
    });

    it('a missing owner-side new epoch is reported as its own distinct failure', () => {
      const { verdict } = renderVerdict({ B_DEV: 'dev-b', k3_bdev: '0', k3_remaining: '1', a_new: '0' });
      expect(verdict).toContain('A does not hold the new epoch');
      expect(verdict).not.toContain('CUT BROKEN');
      expect(verdict).not.toContain('ANTI-CONFOUND');
    });
  });
});

describe('K4b CONTENT CUT — ciphertext arrival and no-key defer are both witnessed (WI-6266)', () => {
  const k4b = SRC.slice(SRC.indexOf('# ── K4b CONTENT CUT'), SRC.indexOf('# ── 6.5 MODERATION'));

  it('rejects a packaged witness bundle that lacks the epoch-gate arrival trace', () => {
    const supportGate = SRC.slice(
      SRC.indexOf('assert_serve_supports_from_repo()'),
      SRC.indexOf('# ── resolve mode'),
    );
    expect(supportGate).toContain("grep -qaF 'epoch_gate_seen'");
    expect(supportGate).toMatch(/K4b cannot distinguish ciphertext deferral from non-arrival/);
  });

  it('reads B boot-history through the authenticated superuser token and filters the exact four gate outcomes', () => {
    const helper = SRC.slice(SRC.indexOf('boot_history_get()'), SRC.indexOf('# ── 0. pre-create'));
    expect(helper).toContain('/api/admin/dogfood-substrate-boot-history');
    expect(helper).toContain('Authorization: Bearer $tok');
    expect(k4b).toContain('epoch_gate_seen,epoch_defer,epoch_decrypt_fail,epoch_applied');
    expect(k4b).toContain('"/F-RKCUT"');
  });

  it('cannot PASS from non-materialization alone: K3, seen, defer, and negative applied/decrypt-fail are load-bearing', () => {
    expect(k4b).toContain('[ "$rk_cut_ok" != 1 ]');
    expect(k4b).toContain('[ "${rkcut_seen:-0}" -lt 1 ]');
    expect(k4b).toContain('[ "${rkcut_defer:-0}" -lt 1 ]');
    expect(k4b).toContain('[ "${rkcut_decrypt_fail:-0}" -gt 0 ]');
    expect(k4b).toContain('[ "${rkcut_applied:-0}" -gt 0 ]');
    expect(k4b).toMatch(/never recorded epoch_gate_seen for \/F-RKCUT — non-materialization may be non-arrival/);
    expect(k4b.match(/rk_content_cut_ok=1/g)).toHaveLength(1);
  });
});
