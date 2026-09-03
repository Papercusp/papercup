import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ANY_FAMILY_TERMINAL_STATES } from '@papercusp/operator-core/lib/work-item-dispatch-states';

const SCRIPTS = resolve(__dirname, '..');
// Overridable so falsifiability can be proven against a COPY outside the tree
// (scripts/mutation-probe.sh tier 2) instead of mutating this shared checkout,
// where a git-sync sweep can commit the mutant mid-probe.
const LIB = process.env.RED_MARKER_LIB || join(SCRIPTS, 'lib', 'red-marker.sh');
const DISK = join(SCRIPTS, 'papercup-fedplane-disk-health-check.sh');
const DHT = join(SCRIPTS, 'papercup-dht-liveness-check.sh');
// Overridable for the same reason as LIB: falsifiability is proven against a COPY
// outside the tree (mutation-probe tier 2), never by mutating this shared checkout.
const BACKUP = process.env.BACKUP_HEALTH_SCRIPT || join(SCRIPTS, 'papercup-backup-health-check.sh');
const KEYPERM = join(SCRIPTS, 'papercup-fedplane-key-permission-check.sh');

/**
 * Run red_dedup_check against a throwaway marker.
 *
 * `markerBody` is written verbatim so the legacy "<epoch>" form can be exercised
 * beside the new "<epoch> <id>" form. `state` drives the stubbed item-state
 * resolver; '' means the lookup could not answer (no bearer / transport failure),
 * which is a distinct case from open and from terminal.
 */
function dedupCheck(markerBody: string, state: string, refileH = 12): string {
  const dir = mkdtempSync(join(tmpdir(), 'red-marker-'));
  const marker = join(dir, 'red-ei-filed');
  writeFileSync(marker, markerBody);

  const stub = join(dir, 'state-stub.sh');
  writeFileSync(stub, '#!/usr/bin/env bash\nprintf %s "${FAKE_STATE:-}"\n');
  chmodSync(stub, 0o755);

  return execFileSync(
    'bash',
    ['-c', `set -uo pipefail; . "$1"; red_dedup_check "$2" "$3"`, '_', LIB, marker, String(refileH)],
    { encoding: 'utf8', env: { ...process.env, RED_ITEM_STATE_CMD: stub, FAKE_STATE: state } },
  ).trim();
}

const fresh = () => `${Math.floor(Date.now() / 1000)}`;

describe('red-marker.sh — state-aware RED dedup (EI-22240553542994017)', () => {
  it('every touched script passes bash syntax validation', () => {
    for (const file of [LIB, DISK, DHT, BACKUP, KEYPERM]) {
      const result = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
      expect(`${file}: ${result.status} ${result.stderr ?? ''}`).toBe(`${file}: 0 `);
    }
  });

  // ── The regression this library exists to prevent ────────────────────────────
  // WI-2143135 was dropped at 04:40:58Z while its marker stayed fresh, so the disk
  // RED went untracked until the 12h window aged out at 15:20:03Z — 10h39m during
  // which the journal asserted "RED already tracked".
  it('REFILES when the tracked item went terminal but the marker is still fresh', () => {
    const verdict = dedupCheck(`${fresh()} WI-2143135`, 'dropped');
    expect(verdict.startsWith('FILE')).toBe(true);
    expect(verdict).toContain('WI-2143135');
    expect(verdict).toContain('dropped');
  });

  it('DISCRIMINATION CONTROL: that same marker is fresh, so age-only logic suppresses it', () => {
    // Guards against the fix "passing" for the trivial reason that the marker had
    // aged out anyway. Identical marker, identical window — only the item state
    // differs, and only the state-aware rule can tell these two apart.
    const body = `${fresh()} WI-2143135`;
    expect(dedupCheck(body, 'open').startsWith('SUPPRESS')).toBe(true);
    expect(dedupCheck(body, 'dropped').startsWith('FILE')).toBe(true);
  });

  it('refiles for EVERY terminal state, not just the one that was observed', () => {
    for (const state of ANY_FAMILY_TERMINAL_STATES) {
      expect(`${state}:${dedupCheck(`${fresh()} WI-1`, state).split(' ')[0]}`).toBe(`${state}:FILE`);
    }
  });

  it('suppresses while the tracked item is genuinely still open, and says which item', () => {
    const verdict = dedupCheck(`${fresh()} WI-2143488`, 'open');
    expect(verdict.startsWith('SUPPRESS')).toBe(true);
    expect(verdict).toContain('WI-2143488');
    expect(verdict).toContain('still open');
  });

  it('still rate-limits: an aged-out marker refiles regardless of state', () => {
    const old = `${Math.floor(Date.now() / 1000) - 13 * 3600} WI-1`;
    expect(dedupCheck(old, 'open').startsWith('FILE')).toBe(true);
  });

  // ── Honest logging: the harm in the original defect was the WORDING ──────────
  // Both unverifiable cases still suppress (re-filing every tick would be worse),
  // but neither may claim the RED is tracked.
  it('a legacy age-only marker suppresses WITHOUT claiming the RED is tracked', () => {
    const verdict = dedupCheck(fresh(), 'open');
    expect(verdict.startsWith('SUPPRESS')).toBe(true);
    expect(verdict).toContain('UNVERIFIED');
    expect(verdict).not.toContain('already tracked');
  });

  it('an unreadable item state suppresses WITHOUT claiming the RED is tracked', () => {
    const verdict = dedupCheck(`${fresh()} WI-1`, '');
    expect(verdict.startsWith('SUPPRESS')).toBe(true);
    expect(verdict).toContain('UNVERIFIED');
    expect(verdict).not.toContain('already tracked');
  });

  // ── PIN (derived-truth ladder rung 2) ───────────────────────────────────────
  // RED_TERMINAL_STATES is a hand-copy in a language that cannot import the
  // constant. work-item-dispatch-states.ts records that hand-copied unions of this
  // exact list have ALREADY drifted here, so a divergence must fail the build:
  // a missing state silently suppresses a real RED, an extra one refiles forever.
  it('RED_TERMINAL_STATES matches ANY_FAMILY_TERMINAL_STATES exactly', () => {
    const shellStates = execFileSync(
      'bash',
      ['-c', `set -uo pipefail; . "$1"; printf %s "$RED_TERMINAL_STATES"`, '_', LIB],
      { encoding: 'utf8' },
    )
      .trim()
      .split(/\s+/)
      .sort();
    expect(shellStates).toEqual([...ANY_FAMILY_TERMINAL_STATES].sort());
  });

  // ── Relapse guard ───────────────────────────────────────────────────────────
  // papercup-backup-health-check.sh already suffered the sibling of this bug: call
  // sites inlined `echo "$(now_s)" >"$RED_MARKER"` and bypassed the guarded writer,
  // silently disarming the next real red. An inlined write here would drop the item
  // id and downgrade every later tick to the age-only path this library replaced.
  it('the wired scripts record markers through red_marker_write, never a bare epoch', () => {
    for (const file of [DISK, DHT]) {
      const src = readFileSync(file, 'utf8');
      expect(`${file}: ${/echo\s+"\$\(now_s\)"\s*>\s*"\$RED_MARKER"/.test(src)}`).toBe(`${file}: false`);
      expect(`${file}: ${src.includes('red_marker_write "$RED_MARKER"')}`).toBe(`${file}: true`);
    }
  });

  // ── papercup-backup-health-check.sh (WI-2143605) ────────────────────────────
  // It funnels every marker write through its own mark_red (which keeps the
  // EI-10746 dry-run guard) rather than calling red_marker_write at each site, so
  // the literal above does not cover it and it needs its own guards.
  describe('papercup-backup-health-check.sh is wired to the state-aware gate', () => {
    const src = () => readFileSync(BACKUP, 'utf8');
    /**
     * Comment lines stripped.
     *
     * These scripts DOCUMENT the bug they guard against, quoting the offending
     * snippet verbatim — this file's own relapse-guard comment does it too. A
     * naive source-text search therefore matches the explanation and reports a
     * relapse that does not exist, which is a guard that fails closed on its own
     * documentation and pressures the next author to delete the comment. Assert
     * about CODE.
     */
    const code = () =>
      src()
        .split('\n')
        .filter((l) => !/^\s*#/.test(l))
        .join('\n');

    it('has NO age-only dedup site left', () => {
      // The defect: `[ "$(age_h "$M")" -lt "$BACKUP_RED_REFILE_H" ]` suppresses on
      // the marker's AGE while logging "RED already tracked", which asserts the
      // condition is OWNED. All nine sites now route through red_gate →
      // red_dedup_check, which additionally checks the tracked item's STATE.
      const ageOnly = code().match(/age_h "\$(?:red_marker|RED_MARKER)"\)" -lt "\$BACKUP_RED_REFILE_H"/g);
      expect(ageOnly).toBe(null);
    });

    it('routes every RED site through the shared gate', () => {
      expect(src().match(/if red_gate "/g)?.length ?? 0).toBeGreaterThanOrEqual(9);
      expect(src()).toContain('red_dedup_check "$marker" "$BACKUP_RED_REFILE_H"');
    });

    it('records the filed item id into the marker, and still refuses to write one on a dry-run', () => {
      // Both halves matter and they pull against each other: the id is what makes
      // the next tick state-aware, while the BACKUP_NO_FILE guard is what stops a
      // dry-run disarming the next real red for 12h (EI-10746 — that guard was
      // written, documented, and then bypassed by every call site).
      expect(src()).toContain('red_marker_write "$1" "$LAST_FILED_EI_ID"');
      expect(src()).toMatch(/mark_red\(\) \{ \[ "\$BACKUP_NO_FILE" = 1 \] && return 0;/);
      expect(/echo\s+"\$\(now_s\)"\s*>\s*"\$(?:RED_)?MARKER"/.test(code())).toBe(false);
    });

    it('reads marker ages through the shared reader, so a two-field marker cannot break it', () => {
      // red_marker_write now emits "<epoch> <item-id>". The old local age_h was
      // `cat` piped into arithmetic, which on a two-field marker is a syntax error
      // — every age would read as garbage and dedup would silently misbehave.
      expect(src()).toContain('age_h() { red_marker_age_h "$1"; }');
    });
  });
});
