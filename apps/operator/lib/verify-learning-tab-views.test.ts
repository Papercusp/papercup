/**
 * verify-learning-tab-views.test.ts — the recurrence guard for EI-18819790444425845
 * (and the near-miss that shaped how this file is written).
 *
 * WHAT THE GATE IS FOR. scripts/verify-learning-tab-views.sh drives every
 * Learning-tab view in a real webview and is the release gate for the class of
 * defect jsdom is structurally blind to (a render LOOP, an error-boundary trip).
 *
 * WHAT WENT WRONG WITH IT. Until 2026-07-27 it drove every view with NO pot
 * selected and asserted a bare `.pc-learning__viewpane`, so `painted: true` meant
 * "an element exists", not "this view rendered its data path". The five
 * pot-scoped views were therefore verified in exactly the EMPTY state that
 * WI-6410 — the bug this gate was written to guard — was about telling apart
 * from a failure. The gate could not have caught the bug it exists for.
 *
 * WHY THIS TEST EXECUTES THE SCRIPT INSTEAD OF READING IT. The sibling
 * verify-tauri-headless-*.test.ts files are readFileSync text guards, correctly:
 * that script boots a real Xvfb/Tauri/sidecar stack, so its wiring can only be
 * asserted at the wiring site. This one is different, and the difference was
 * bought with a near-miss. The sweep script's real logic lives in a bash DRIVE it
 * GENERATES as text and hands to the webview bridge — and a bug was very nearly
 * shipped in exactly that generated text: a pattern matching the bridge's COMPACT
 * output (`"painted":true`) against its actual PRETTY-PRINTED output
 * (`"painted": true`). It would have failed silently and plausibly — every view
 * burning both attempts, every healthy view mislabelled "recovered on attempt 2",
 * a fabricated flake rate emitted by the code meant to MEASURE flakiness. Tests
 * that stub the harness and assert on the parser never execute the generated
 * drive, so they cannot see that class at all.
 *
 * So: the script takes VERIFY_LEARNING_HARNESS, and this test points it at a stub
 * that runs the GENERATED drive against a stub bridge — one that quotes and
 * newlines its output the way the real bridge does, so the drive's own
 * whitespace handling is exercised rather than assumed. Every verdict class is
 * asserted end-to-end: generation → execution → classification.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../../scripts/verify-learning-tab-views.sh');

/** A stub webview bridge. Fixture rows are `view|waitExit|verdictToken`. */
const BRIDGE = `#!/usr/bin/env bash
set -u
CMD="\${1:-}"
EXPR=""
for a in "$@"; do EXPR="$EXPR $a"; done
STATE="$STUB_STATE"

lookup() { grep "^$1|" "$STUB_FIXTURE" | head -1; }

case "$CMD" in
  wait)
    case "$EXPR" in
      *vnonce=*)
        # The settle wait is pinned on the navigation NONCE and so names no view
        # itself — recover it from the last navigation, as the real page would.
        V="$(cat "$STATE" 2>/dev/null || true)"
        ROW="$(lookup "$V")"; [ -z "$ROW" ] && exit 0
        ATT_FILE="$STATE.$V"
        N=$(( $(cat "$ATT_FILE" 2>/dev/null || echo 0) + 1 ))
        echo "$N" > "$ATT_FILE"
        WANT="$(printf '%s' "$ROW" | cut -d'|' -f2)"
        # "recover@N" ⇒ fail every attempt before N, succeed from N on.
        case "$WANT" in
          recover@*)
            [ "$N" -ge "\${WANT#recover@}" ] && exit 0 || exit 1 ;;
          *) exit "$WANT" ;;
        esac
        ;;
      *) exit 0 ;;
    esac
    ;;
  eval)
    case "$EXPR" in
      *"location.href="*)
        printf '%s' "$EXPR" | grep -o 'lview=[a-z-]*' | head -1 | sed 's/lview=//' > "$STATE"
        echo '"go"'
        ;;
      *VERDICT*)
        V="$(printf '%s' "$EXPR" | grep -o "VERDICT~[a-z-]*" | head -1 | sed 's/VERDICT~//')"
        ROW="$(lookup "$V")"
        [ -z "$ROW" ] && { echo '""'; exit 0; }
        # Quote AND newline it, exactly like the pretty-printing bridge. If the
        # drive ever stops de-spacing its result, this is what catches it.
        printf '"\\n%s\\n"\\n' "$(printf '%s' "$ROW" | cut -d'|' -f3-)"
        ;;
      *) echo '"go"' ;;
    esac
    ;;
  *) exit 0 ;;
esac
`;

const HARNESS = `#!/usr/bin/env bash
set -u
[ "\${1:-}" = "--" ] && shift
export VERIFY_TAURI_PID=4242 VERIFY_TAURI_PORT=31000 VERIFY_TAURI_DISPLAY=":99"
export PATH="$STUB_BIN:$PATH"
exec "$@"
`;

let dir: string;
let harnessPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'learning-views-test-'));
  const bin = join(dir, 'bin');
  spawnSync('mkdir', ['-p', bin]);
  const bridgePath = join(bin, 'tauri-agent-tools');
  writeFileSync(bridgePath, BRIDGE);
  chmodSync(bridgePath, 0o755);
  harnessPath = join(dir, 'harness.sh');
  writeFileSync(harnessPath, HARNESS);
  chmodSync(harnessPath, 0o755);
});

/** Run the gate against a fixture; returns its stdout + exit code. */
function runGate(rows: string[], views: string[], env: Record<string, string> = {}) {
  const fixture = join(dir, `fixture-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(fixture, `${rows.join('\n')}\n`);
  const state = join(dir, `state-${Math.random().toString(36).slice(2)}`);
  const res = spawnSync('bash', [SCRIPT, ...views], {
    encoding: 'utf8',
    env: {
      ...process.env,
      STUB_FIXTURE: fixture,
      STUB_STATE: state,
      STUB_BIN: join(dir, 'bin'),
      VERIFY_LEARNING_HARNESS: harnessPath,
      VERIFY_LEARNING_MAXIMIZE: '0',
      VERIFY_LEARNING_PAINT_ATTEMPTS: '2',
      VERIFY_LEARNING_PAINT_TIMEOUT_MS: '1000',
    },
  });
  return { out: `${res.stdout}${res.stderr}`, code: res.status };
}

/** The generated drive, without executing it. */
function generateDrive(views: string[], env: Record<string, string> = {}) {
  return spawnSync('bash', [SCRIPT, ...views], {
    encoding: 'utf8',
    env: { ...process.env, VERIFY_LEARNING_PRINT_DRIVE: '1', ...env },
  }).stdout;
}

const ok = (v: string, extra = 'scoped=0') =>
  `${v}|0|VERDICT~${v}~pane=1~visible=${v}~boundary=0~${extra}~loading=0~chars=500`;

describe('the generated drive (the text no parser-only test ever sees)', () => {
  it('pins the settle wait on a navigation NONCE, not on lview=', () => {
    const drive = generateDrive(['gym']);
    // The obvious pin is wrong here specifically: LearningTab rewrites the raw
    // ?lview= to the RESOLVED view, so `lview=gym` evaporates the moment the
    // degrade happens — i.e. on exactly the views whose degrade we want to see.
    expect(drive).toContain("location.href.indexOf('vnonce=vn1')>=0");
    expect(drive).not.toContain("location.href.indexOf('lview=gym')");
  });

  it('requires the pot lens on hive-aware views and only those', () => {
    const CLAUSE = "if(!document.querySelector('.pc-learning__hivepick'))return false;";
    // improvements is hive-aware; signals is not. Split the drive at the second
    // view's verdict token so each half can be asserted on its own.
    const drive = generateDrive(['improvements', 'signals']);
    const [improvementsHalf, signalsHalf] = drive.split("'VERDICT~signals'");
    expect(improvementsHalf).toContain(CLAUSE);
    // The negative half matters as much: demanding a pot chip from a view that
    // never renders one would hang the gate on nine of sixteen views.
    expect(signalsHalf).not.toContain(CLAUSE);
  });

  it('navigates with a pot selected — the whole point of EI-18819790444425845', () => {
    const drive = generateDrive(['throughput']);
    expect(drive).toContain('slug=papercusp');
    expect(drive).toContain('scope=expanded');
    // scope=all is what made every pot-scoped view render its empty state.
    expect(drive).not.toContain('scope=all');
  });

  it('honours VERIFY_LEARNING_POT so the gate is not pinned to one workspace', () => {
    const drive = generateDrive(['throughput'], { VERIFY_LEARNING_POT: 'oddsmith-hive' });
    expect(drive).toContain('slug=oddsmith-hive');
  });

  it('rejects a loading placeholder as a render', () => {
    expect(generateDrive(['pipeline'])).toContain('Loading [^\\n]*');
  });
});

describe('verdict classification, end to end through the generated drive', () => {
  it('passes a clean run and exits 0', () => {
    const { out, code } = runGate(
      [ok('signals'), ok('throughput', 'scoped=1')],
      ['signals', 'throughput'],
    );
    expect(out).toMatch(/signals\s+ok/);
    // A pot-scoped ok says so — the verdict now carries what it actually proved.
    expect(out).toMatch(/throughput\s+ok — pot-scoped/);
    expect(out).toContain('ALL PROBED VIEWS PAINTED');
    expect(code).toBe(0);
  });

  it('FAILS a hive-aware view whose pot lens never applied (the filed bug)', () => {
    const { out, code } = runGate([ok('improvements', 'scoped=0')], ['improvements']);
    expect(out).toContain('UNSCOPED');
    expect(code).toBe(1);
  });

  it('does not demand a pot lens from a view that has none', () => {
    // signals is not hive-aware, so scoped=0 is correct there, not a failure.
    const { out, code } = runGate([ok('signals', 'scoped=0')], ['signals']);
    expect(out).not.toContain('UNSCOPED');
    expect(code).toBe(0);
  });

  it('reports a DECLARED degrade as such instead of a clean ok', () => {
    const { out, code } = runGate(
      ['gym|0|VERDICT~gym~pane=1~visible=improvements~boundary=0~scoped=1~loading=0~chars=430'],
      ['gym'],
    );
    // The old gate passed this as a silent `gym ok` — it never compared the view
    // it asked for against the view it got.
    expect(out).toContain('DEGRADED to improvements (declared)');
    expect(code).toBe(0);
  });

  it('FAILS an UNDECLARED degrade', () => {
    const { out, code } = runGate(
      ['ekg|0|VERDICT~ekg~pane=1~visible=red-queen~boundary=0~scoped=0~loading=0~chars=200'],
      ['ekg'],
    );
    expect(out).toContain('WRONG VIEW — rendered red-queen instead');
    expect(code).toBe(1);
  });

  it('FAILS a view still showing a loading placeholder', () => {
    const { out, code } = runGate(
      ['frontier|1|VERDICT~frontier~pane=1~visible=frontier~boundary=0~scoped=1~loading=1~chars=40'],
      ['frontier'],
    );
    expect(out).toContain('STILL LOADING');
    expect(code).toBe(1);
  });

  it('FAILS an error-boundary trip, and does not burn retries on it', () => {
    const { out, code } = runGate(
      ['bakeoff|0|VERDICT~bakeoff~pane=0~visible=-~boundary=1~scoped=0~loading=0~chars=0'],
      ['bakeoff'],
    );
    expect(out).toContain('CRASHED');
    // A crash is definitive; retrying it just burns the budget.
    expect(out).toContain('ATTEMPTS:bakeoff:1');
    expect(code).toBe(1);
  });

  it('separates a TIMED OUT check from one that concluded negatively', () => {
    const { out, code } = runGate(
      ['rubrics|1|VERDICT~rubrics~pane=0~visible=-~boundary=0~scoped=0~loading=0~chars=0'],
      ['rubrics'],
    );
    // EI-18818262219163661: a check that never CONCLUDED must not be reported in
    // the same words as one that concluded negatively.
    expect(out).toContain('TIMED OUT');
    expect(out).not.toContain('NEVER PAINTED');
    expect(code).toBe(1);
  });

  it('reports a genuine flake recovery honestly — and only a genuine one', () => {
    // The near-miss this whole file exists for would have printed this line for
    // EVERY view, on every run, from a pattern that could never match.
    const { out, code } = runGate(
      ['ekg|recover@2|VERDICT~ekg~pane=1~visible=ekg~boundary=0~scoped=0~loading=0~chars=300'],
      ['ekg'],
    );
    expect(out).toContain('recovered on attempt 2');
    expect(code).toBe(0);

    const clean = runGate([ok('ekg')], ['ekg']);
    expect(clean.out).not.toContain('recovered on attempt');
    expect(clean.code).toBe(0);
  });

  it('reads each view\'s own fields — a neighbour\'s verdict cannot answer for it', () => {
    // The previous version flattened the whole transcript to de-newline it, which
    // welded each view's token onto the NEXT view's markers; a `grep -o key=… |
    // tail -1` over that soup can answer with the wrong view's field.
    const { out, code } = runGate(
      [ok('signals'), 'ekg|0|VERDICT~ekg~pane=1~visible=red-queen~boundary=0~scoped=0~loading=0~chars=200'],
      ['signals', 'ekg'],
    );
    expect(out).toMatch(/signals\s+ok/);
    expect(out).toContain('WRONG VIEW');
    expect(code).toBe(1);
  });
});
