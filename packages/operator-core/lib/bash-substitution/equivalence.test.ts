/**
 * The committed equivalence harness test (plan
 * `bash-to-tool-substitution-2026-07-26`, P-004/P-005).
 *
 * This is the anti-rot latch the plan asks for. Each pair declares the verdict
 * it is RECORDED as carrying; the harness recomputes that verdict from frozen
 * samples of real commands. If someone changes a tool's capability (or the
 * envelope that models it) without re-recording the verdict, this test fails —
 * so a registry row can never quietly claim an equivalence the tool no longer
 * provides, which is the whole basis of D-001's enforcement gate.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { atomize, atomHead, normalizeAtom } from './atomize';
import { auditPair, deriveVerdict, matchingAtoms, maxTierFor, MIN_SAMPLE_SIZE } from './equivalence';
import { ALL_PAIRS } from './pairs';
import { catFileRead, headFileRead, sedRangeRead, tailFileRead, FILE_READ_PAIRS } from './pairs/file-read';
import { psqlDescribe, psqlSelectRead } from './pairs/postgres';
import { psProcessQuery } from './pairs/process';
import { curlHealthProbe, listeningPorts, systemctlIsActive } from './pairs/service';
import { gitReadPassthrough, shellArgv } from './pairs/git-read';
import type { CorpusFixture } from './corpus';
import type { SampledCommand } from './types';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function loadFixture(pairId: string): CorpusFixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${pairId}.sample.json`), 'utf8')) as CorpusFixture;
}

describe('atomize', () => {
  it('splits compound commands on every shell separator', () => {
    expect(atomize("cd /repo && sed -n '1,40p' a.ts | head -5")).toEqual([
      'cd /repo',
      "sed -n '1,40p' a.ts",
      'head -5',
    ]);
    expect(atomize('a; b || c')).toEqual(['a', 'b', 'c']);
  });

  it('strips runner wrappers and env assignments so the verb is at position 0', () => {
    expect(normalizeAtom('sudo -n journalctl -u x')).toBe('journalctl -u x');
    expect(normalizeAtom('PGPASSWORD=x timeout 30 psql -c "select 1"')).toBe('psql -c "select 1"');
    expect(normalizeAtom('nohup npm run build')).toBe('npm run build');
  });

  it('reduces a verb to its bare name', () => {
    expect(atomHead('/usr/bin/psql -c x')).toBe('psql');
    expect(atomHead('   ')).toBeNull();
  });
});

describe('verdict derivation (D-008 — total coverage or it is not equivalent)', () => {
  it('requires every sampled command to be covered', () => {
    expect(deriveVerdict(20, 20)).toBe('equivalent');
    // The near-miss is deliberately NOT equivalent: the pattern is the unit of
    // enforcement, so one uncovered command means one agent nudged toward a
    // tool that cannot do the job.
    expect(deriveVerdict(19, 20)).toBe('needs-widening');
    expect(deriveVerdict(0, 20)).toBe('not-a-substitute');
    expect(deriveVerdict(0, 0)).toBe('unaudited');
  });

  it('only an equivalent verdict may be promoted past observe', () => {
    expect(maxTierFor('equivalent')).toBe('advise');
    expect(maxTierFor('needs-widening')).toBe('observe');
    expect(maxTierFor('not-a-substitute')).toBe('observe');
    expect(maxTierFor('unaudited')).toBe('observe');
  });

  it('refuses to produce a verdict from an under-sized sample', () => {
    const thin: SampledCommand[] = [{ sid: 'su-x', ts: '2026-07-26T00:00:00Z', atom: 'cat /tmp/a.log' }];
    expect(() => auditPair(catFileRead, thin)).toThrow(/need >= 20/);
  });
});

describe.each(ALL_PAIRS)('pair $id', (pair) => {
  const fixture = loadFixture(pair.id);

  it(`carries a sample of at least ${MIN_SAMPLE_SIZE} real commands`, () => {
    expect(fixture.sample.length).toBeGreaterThanOrEqual(MIN_SAMPLE_SIZE);
    // Every sampled command must be a real one drawn from the corpus, not a
    // hand-written example that happens to pass.
    for (const entry of fixture.sample) {
      expect(entry.sid).toMatch(/^su-|^[0-9a-f-]{8,}/);
    }
  });

  it('records the verdict the harness actually computes', () => {
    const audit = auditPair(pair, fixture.sample);
    expect(audit.verdict).toBe(pair.expectedVerdict);
    expect(audit.sampleSize).toBe(fixture.sample.length);
  });

  it('explains every failure it reports', () => {
    const audit = auditPair(pair, fixture.sample);
    for (const failure of audit.failingCases) {
      expect(failure.reason.length).toBeGreaterThan(10);
      expect(failure.atom).toBeTruthy();
    }
    // An `equivalent` verdict must have nothing left to explain.
    if (audit.verdict === 'equivalent') expect(audit.failingCases).toHaveLength(0);
  });

  it('produces a concrete tool expression for every covered command', () => {
    for (const entry of fixture.sample) {
      const result = pair.cover(entry.atom);
      if (result.covered) {
        expect(result.expression).toContain(pair.toolName);
      } else {
        expect(result.reason).toBeTruthy();
      }
    }
  });
});

/**
 * Regression guards for the mis-scorings the harness caught on its first real
 * run. Each of these was a live bug in the envelope, and each would have
 * produced a WRONG verdict — two of them optimistic.
 */
describe('file-read pattern boundaries', () => {
  const claims = (pair: (typeof FILE_READ_PAIRS)[number], atom: string) =>
    matchingAtoms(pair, [{ sid: 's', ts: 't', atom }]).length === 1;

  it('excludes pipe filters, which are stream shaping and not file reads', () => {
    // `head`/`tail` are dominated by this form (11,381 head atoms, only 408
    // distinct) — claiming them would swamp the registry with false advisories.
    expect(claims(headFileRead, 'head -20')).toBe(false);
    expect(claims(tailFileRead, 'tail -16')).toBe(false);
    expect(claims(sedRangeRead, 'sed -n "1,200p"')).toBe(false);
  });

  it('excludes heredocs and stdout redirects, which are writes', () => {
    expect(claims(catFileRead, "cat > /tmp/x.ts << 'EOF'")).toBe(false);
    expect(claims(catFileRead, 'cat /tmp/a.log > /tmp/b.log')).toBe(false);
  });

  it('treats a stderr redirect as noise, not as a write', () => {
    // `2>/dev/null` rides on a large share of real reads; scoring it as a write
    // mis-failed a third of the cat sample.
    expect(claims(catFileRead, 'cat /tmp/a.log 2>/dev/null')).toBe(true);
    expect(catFileRead.cover('cat /tmp/a.log 2>/dev/null').covered).toBe(true);
  });

  it('does not mistake a flag argument for a second file', () => {
    // `tail -n 40 FILE` parses as flag(-n) arg(40) operand(FILE) — reading `40`
    // as a filename made every -n form look like a two-file read.
    const result = tailFileRead.cover('tail -n 40 /tmp/run.log');
    expect(result.covered).toBe(true);
    expect(result.expression).toContain('tail: 40');
  });

  it('excludes shell expansion, which has no literal path to pass', () => {
    expect(claims(catFileRead, 'cat $TRIAGE/scn.log')).toBe(false);
    expect(claims(catFileRead, 'cat "$B/build-provenance.json"')).toBe(false);
  });

  it('claims ~/ paths now that capability:read expands them', () => {
    expect(claims(catFileRead, 'cat ~/.papercusp/live-fed-gate/last-downgrade')).toBe(true);
    expect(catFileRead.cover('cat ~/.papercusp/state').covered).toBe(true);
  });

  it('excludes follow mode and byte windows as different intents', () => {
    expect(claims(tailFileRead, 'tail -f /tmp/run.log')).toBe(false);
    expect(claims(tailFileRead, 'tail -c 2000 /tmp/run.log')).toBe(false);
  });

  it('maps a sed range onto offset+limit exactly', () => {
    const result = sedRangeRead.cover("sed -n '110,200p' packages/operator-core/lib/x.ts");
    expect(result.covered).toBe(true);
    expect(result.expression).toContain('offset: 110');
    expect(result.expression).toContain('limit: 91');
  });
});

describe('postgres pattern boundaries', () => {
  const claims = (pair: (typeof ALL_PAIRS)[number], atom: string) =>
    matchingAtoms(pair, [{ sid: 's', ts: 't', atom }]).length === 1;

  const OPERATOR = 'psql "postgresql://harness_admin:pwd@localhost:5432/papercusp"';

  it('claims a SELECT against the operator database', () => {
    expect(claims(psqlSelectRead, `${OPERATOR} -c "SELECT count(*) FROM harness_shared.work_items"`)).toBe(true);
  });

  /**
   * The most important guard in this file. `dev:pg_query` has NO database
   * selector, so nudging a non-operator psql call toward it would silently
   * query the WRONG DATABASE and return plausible rows instead of an error —
   * strictly worse than the raw psql it replaced.
   */
  it('never claims a query against another database', () => {
    expect(claims(psqlSelectRead, 'psql "$ODDS_DB" -c "SELECT 1"')).toBe(false);
    expect(claims(psqlSelectRead, 'psql "$PGURL/oddsmith_028_rehearsal" -c "SELECT 1"')).toBe(false);
    expect(claims(psqlSelectRead, 'psql -h localhost -U harness_admin -d wi5635_scratch -c "SELECT 1"')).toBe(false);
  });

  it('never claims a write, a heredoc, or a -f script', () => {
    expect(claims(psqlSelectRead, `${OPERATOR} -c "INSERT INTO t VALUES (1)"`)).toBe(false);
    expect(claims(psqlSelectRead, `${OPERATOR} -c "CREATE TABLE t (id int)"`)).toBe(false);
    expect(claims(psqlSelectRead, `${OPERATOR} <<'SQL'`)).toBe(false);
    expect(claims(psqlSelectRead, `${OPERATOR} -1 -f packages/db/sql/028.sql`)).toBe(false);
  });

  it('claims the relation-describing meta-commands', () => {
    expect(psqlDescribe.cover(`${OPERATOR} -c "\\d harness_shared.agent_facts"`).expression).toContain(
      'describe: "harness_shared.agent_facts"',
    );
    expect(psqlDescribe.cover(`${OPERATOR} -c "\\dt harness_shared.*"`).covered).toBe(true);
    expect(psqlDescribe.cover(`${OPERATOR} -c "\\d+ work_items"`).covered).toBe(true);
  });

  it('excludes non-relation object classes, which describe does not cover', () => {
    // `\df` lists FUNCTIONS — a different object class, not a missing corner of
    // relation description. Claiming it would promise something describe cannot do.
    expect(claims(psqlDescribe, `${OPERATOR} -c "\\df+ harness_shared.some_fn"`)).toBe(false);
    expect(claims(psqlDescribe, `${OPERATOR} -c "\\du"`)).toBe(false);
  });
});

/**
 * P-008. The plan's first NEGATIVE verdict, so these guards protect a
 * conclusion rather than a substitution: they must fail if anyone starts
 * routing `ps`/`pgrep` at `dev:processes`.
 */
describe('process pattern boundaries (a not-a-substitute verdict)', () => {
  const claims = (atom: string) =>
    matchingAtoms(psProcessQuery, [{ sid: 's', ts: 't', atom }]).length === 1;

  it('claims the job-liveness questions the family is actually made of', () => {
    expect(claims('ps -p 636440 -o pid,etime,cmd')).toBe(true);
    expect(claims('pgrep -f "tsc --noEmit"')).toBe(true);
    expect(claims('ps aux')).toBe(true);
    expect(claims('ps --ppid 3823918 -o pid,cmd')).toBe(true);
  });

  it('covers none of them — dev:processes has no pid, name or parent selector', () => {
    for (const atom of [
      'ps -p 636440 -o pid,etime,cmd',
      'pgrep -f "tsc --noEmit"',
      'ps aux',
      'ps --ppid 3823918 -o pid,cmd',
    ]) {
      const result = psProcessQuery.cover(atom);
      expect(result.covered, `${atom} should have no dev:processes expression`).toBe(false);
      expect(result.reason).toBeTruthy();
    }
  });

  /**
   * The D-008 boundary. Searching for an agent kind IS `dev:processes`' question
   * and it answers it exactly, so that intent is excluded from this pattern
   * rather than dragging a genuinely-covered case into a negative verdict.
   */
  it('excludes searches for an agent kind, which are a different intent', () => {
    expect(claims('pgrep -fc "claude"')).toBe(false);
    expect(claims('pgrep -af omp')).toBe(false);
    expect(claims('pgrep -f next-server')).toBe(false);
  });

  /**
   * The tripwire. The exclusion above must live in the PATTERN; if it instead
   * lived in a rigged `cover()` that returned false for everything, this
   * assertion would fail — and if the lookahead ever breaks, the excluded atom
   * reaches `cover()`, scores COVERED, and flips the recorded verdict.
   */
  it('still scores an agent-kind search as covered, so a broken exclusion is loud', () => {
    const result = psProcessQuery.cover('pgrep -fc "claude"');
    expect(result.covered).toBe(true);
    expect(result.expression).toContain("kinds: ['claude']");
  });

  it('does not reach across to psql, which is a different family', () => {
    expect(claims('psql -d papercusp -c "SELECT 1"')).toBe(false);
  });

  it('is never promotable past observe', () => {
    expect(psProcessQuery.expectedVerdict).toBe('not-a-substitute');
    expect(maxTierFor(psProcessQuery.expectedVerdict)).toBe('observe');
  });

  /**
   * EI-18733363666718163. `atomize` is not a shell parser, so an inlined
   * script payload (`python3 -c "..."`) splits into pseudo-verb atoms headed
   * by short identifiers — including one that happens to start with `ps`.
   * A bare `\b` anchor sits between `ps` and `=` (both are non-word-adjacent),
   * so it used to claim a python assignment as a process-liveness query. The
   * anchor now requires a shell-argument boundary (whitespace or end of atom).
   */
  it('does not false-positive on a python assignment that starts with ps/pgrep', () => {
    expect(claims("ps=json.load(sys.stdin)['status']")).toBe(false);
    expect(claims('pgrep=some_other_value')).toBe(false);
    expect(claims('pshell --foo')).toBe(false);
  });
});

/**
 * The SERVICE family (P-009). Three pairs, drawn on intent boundaries, and the
 * boundaries are the whole finding: `dev:service_health` takes no arguments, so
 * what it can answer is fixed by which services something PROBES — not by which
 * units are in the supervision registry, and not by which port you care about.
 */
describe('service pattern boundaries', () => {
  const claims = (pair: typeof systemctlIsActive, atom: string) =>
    matchingAtoms(pair, [{ sid: 's', ts: 't', atom }]).length === 1;

  describe('systemctl unit liveness (needs-widening)', () => {
    it('claims the boolean-liveness verbs', () => {
      expect(claims(systemctlIsActive, 'systemctl --user is-active papercup-bg-host.service')).toBe(true);
      expect(claims(systemctlIsActive, 'systemctl --user is-failed papercusp-db-backup.service 2>&1')).toBe(true);
      expect(claims(systemctlIsActive, 'systemctl is-active auditd 2>&1')).toBe(true);
    });

    /**
     * `status` is EXCLUDED deliberately: it returns the unit's journal tail as
     * well as its state (21 distinct corpus shapes pass `-n <N>` asking for
     * exactly those lines), and `dev:service_health` returns no journal at all.
     * `show`/`cat`/`list-timers` ask about CONFIG and SCHEDULE, which it also
     * cannot produce. Enforcing a liveness advisory over any of them would
     * answer a question the agent did not ask.
     */
    it('excludes status, show, cat and the list verbs — different questions', () => {
      expect(claims(systemctlIsActive, 'systemctl --user status papercup-bg-host.service --no-pager -n 20')).toBe(false);
      expect(claims(systemctlIsActive, 'systemctl --user show papercup-bg-host.service -p NRestarts')).toBe(false);
      expect(claims(systemctlIsActive, 'systemctl --user cat papercup-dev-api.service')).toBe(false);
      expect(claims(systemctlIsActive, 'systemctl --user list-timers papercup-live-federation-gate.timer')).toBe(false);
      expect(claims(systemctlIsActive, 'systemctl --user restart papercup-bg-host.service')).toBe(false);
    });

    /** The genuine overlap, and the tripwire: these three units ARE probed, so a
     *  rigged envelope that covered nothing would fail here. */
    it('covers exactly the units something probes', () => {
      for (const [unit, probe] of [
        ['papercup-dev-api.service', 'operator'],
        ['papercup-bg-host.service', 'bg-host-ticker'],
        ['papercup-embed-sidecar.service', 'embed-sidecar'],
      ] as const) {
        const result = systemctlIsActive.cover(`systemctl --user is-active ${unit}`);
        expect(result.covered, `${unit} should be answerable`).toBe(true);
        expect(result.expression).toContain(probe);
      }
    });

    /**
     * The finding, as an assertion. Being in `SUPERVISED_PROCESSES` is NOT the
     * same as being answerable: a supervision row carries flap/restart counters
     * and no up-or-down field, and a stopped unit is indistinguishable from a
     * failed probe (both leave `secondsSinceStart` undefined). The two failure
     * reasons stay distinct because the remedy differs — these need a PROBE
     * (P-013), the others need registration first.
     */
    it('does not cover a supervised-but-unprobed unit, and says why', () => {
      // WI-6146 gave `papercup-staging-api` a real probe, so it is no longer an
      // example of this class — see the covered-case assertion below. The
      // inference gateway still is: supervised, never probed.
      const result = systemctlIsActive.cover('systemctl --user is-active papercup-inference-gateway.service');
      expect(result.covered).toBe(false);
      expect(result.reason).toContain('SUPERVISED_PROCESSES');
      expect(result.reason).toContain('no up/down field');
    });

    /**
     * WI-6146 / WI-6153. This assertion is the INVERSE of what stood here
     * before: `papercup-staging-api` was the headline supervised-but-unprobed
     * unit (34 is-active/status reads in the 7d corpus, more than any other),
     * and P-013 item 1 gave it a probe. Kept as a regression guard so the
     * coverage cannot silently disappear again if the endpoint is removed —
     * pairs/service-model-drift.test.ts guards the same fact from the model side.
     */
    it('DOES cover staging-api now that :3170 is probed (was the headline gap)', () => {
      const result = systemctlIsActive.cover('systemctl --user is-active papercup-staging-api.service');
      expect(result.covered).toBe(true);
      expect(result.expression).toContain('staging-api');
    });

    it('does not cover a unit outside the registry entirely', () => {
      const result = systemctlIsActive.cover('systemctl --user is-active papercup-oddsmith-sidecar.service');
      expect(result.covered).toBe(false);
      expect(result.reason).toContain('outside the supervision registry');
    });
  });

  describe('curl health probe (needs-widening)', () => {
    it('claims a loopback health or version probe', () => {
      expect(claims(curlHealthProbe, 'curl -s http://127.0.0.1:3070/api/health')).toBe(true);
      expect(claims(curlHealthProbe, 'curl -s http://localhost:3170/api/health 2>&1')).toBe(true);
      expect(claims(curlHealthProbe, 'curl -s -m 10 http://127.0.0.1:8788/health')).toBe(true);
    });

    it('excludes remote hosts and non-health routes', () => {
      expect(claims(curlHealthProbe, 'curl -s https://papercusp.com/api/health')).toBe(false);
      expect(claims(curlHealthProbe, 'curl -s http://127.0.0.1:3070/api/mcp')).toBe(false);
    });

    /** The tripwire: a probed port, body discarded, is genuinely answered. */
    it('covers a liveness-only probe of a port it actually probes', () => {
      const result = curlHealthProbe.cover(
        'curl -s -o /dev/null -w "%{http_code}\\n" http://127.0.0.1:3070/api/health',
      );
      expect(result.covered).toBe(true);
      expect(result.expression).toContain('operator');
    });

    /**
     * WAS the sharpest single finding in this family, and is now CLOSED —
     * this assertion has been inverted deliberately (WI-6146 / WI-6153).
     *
     * `CLAUDE.md` tells every agent to verify a staging edit by restarting
     * `:3170` and probing it. `:3170` was not in `HEALTH_ENDPOINTS`, so the
     * documented workflow had no tool form and 80 curl atoms went to bash
     * because there was nowhere else to go. P-013 item 1 added the probe.
     *
     * Kept (inverted) rather than deleted: the coverage is exactly what the
     * pair's verdict and advisoryText now rest on, so it needs a guard.
     */
    it('DOES answer for :3170 now that the staging operator is probed', () => {
      const result = curlHealthProbe.cover(
        'curl -s -o /dev/null -w "%{http_code}\\n" http://127.0.0.1:3170/api/health',
      );
      expect(result.covered).toBe(true);
      expect(result.expression).toContain('staging-api');
    });

    /**
     * The port-gap failure mode has NOT gone away — it moved. :8788 (inference
     * gateway) is the live example, and it is why this pair does not simply
     * become `equivalent` on the strength of :3170.
     */
    it('still cannot answer for a port it does not probe (:8788 gateway)', () => {
      const result = curlHealthProbe.cover(
        'curl -s -o /dev/null -w "%{http_code}\\n" http://127.0.0.1:8788/health',
      );
      expect(result.covered).toBe(false);
      expect(result.reason).toContain(':8788');
    });

    it('cannot answer when the response BODY is what is wanted', () => {
      const result = curlHealthProbe.cover('curl -s http://127.0.0.1:3070/api/health');
      expect(result.covered).toBe(false);
      expect(result.reason).toContain('BODY');
    });
  });

  describe('listening sockets (a not-a-substitute verdict)', () => {
    it('claims the socket-query tools', () => {
      expect(claims(listeningPorts, 'ss -ltnp 2>/dev/null')).toBe(true);
      expect(claims(listeningPorts, 'netstat -tlnp 2>/dev/null')).toBe(true);
      expect(claims(listeningPorts, 'lsof -nP -iTCP:3070 -sTCP:LISTEN')).toBe(true);
    });

    /**
     * A real regression, caught by the harness the first time this pattern ran:
     * `^ss\b` claimed JavaScript heredocs (`ss._blocked = true`,
     * `ss = makeStore()`) as if they were socket queries. A pattern that claims
     * a language's variable names is not claiming an intent.
     */
    it('does not claim JavaScript that merely starts with the letters ss', () => {
      expect(claims(listeningPorts, 'ss._blocked = true')).toBe(false);
      expect(claims(listeningPorts, 'ss = makeStore()')).toBe(false);
    });

    it('does not claim lsof against a FILE, which is a lock query', () => {
      expect(claims(listeningPorts, 'lsof src-tauri/sidecar.lock 2>/dev/null')).toBe(false);
    });

    it('covers none of the real shapes — there is no socket table in the payload', () => {
      for (const atom of ['ss -ltnp 2>/dev/null', 'ss -ltn', 'lsof -nP -iTCP:3070 -sTCP:LISTEN', 'netstat -tlnp']) {
        const result = listeningPorts.cover(atom);
        expect(result.covered, `${atom} should have no dev:service_health expression`).toBe(false);
        expect(result.reason).toBeTruthy();
      }
    });

    /**
     * The tripwire, and where P-013's coverage will first appear: asking only
     * whether a PROBED port has a listener (no process-ownership flag) IS
     * answered by that port's probe succeeding.
     */
    it('still scores a probed-port listener check as covered, so a rigged envelope is loud', () => {
      const result = listeningPorts.cover('ss -ltn "sport = :3070"');
      expect(result.covered).toBe(true);
      expect(result.expression).toContain('operator');
    });

    it('is never promotable past observe', () => {
      expect(listeningPorts.expectedVerdict).toBe('not-a-substitute');
      expect(maxTierFor(listeningPorts.expectedVerdict)).toBe('observe');
    });
  });

  it('the three pairs do not reach across into each other', () => {
    expect(claims(systemctlIsActive, 'curl -s http://127.0.0.1:3070/api/health')).toBe(false);
    expect(claims(curlHealthProbe, 'systemctl --user is-active papercup-bg-host.service')).toBe(false);
    expect(claims(listeningPorts, 'systemctl --user is-active papercup-bg-host.service')).toBe(false);
  });
});

/**
 * The GIT-READ family (P-010). `capability:git` is an argv PASS-THROUGH
 * (`{ args: string[], cwd? }`, spawned with no shell), so unlike every other
 * family the boundary is not "which reads is the tool shaped for" — it is
 * "which argv the SHELL produces rather than the agent".
 */
describe('git-read pattern boundaries', () => {
  const claims = (atom: string) =>
    matchingAtoms(gitReadPassthrough, [{ sid: 's', ts: 't', atom }]).length === 1;

  /**
   * The argv splitter is the load-bearing part of this pair's evidence: a naive
   * whitespace split turns `--format='%H %cI'` into two arguments and `-S "a b
   * c"` into four, so `cover()` would emit an `expression` that does not
   * reproduce the command — false evidence behind a true verdict.
   */
  describe('shellArgv', () => {
    it('keeps a quoted value with spaces as ONE argument', () => {
      expect(shellArgv(`git log --format='%H %cI' -S "reclaimed dead holder"`)).toEqual([
        'git',
        'log',
        '--format=%H %cI',
        '-S',
        'reclaimed dead holder',
      ]);
    });

    it('closes an unterminated quote instead of dropping the fragment', () => {
      // A real corpus atom: `atomize` split inside the quoted regex at its `|`.
      expect(shellArgv('git grep -nEi "select .*from +(harness_shared')).toEqual([
        'git',
        'grep',
        '-nEi',
        'select .*from +(harness_shared',
      ]);
    });
  });

  it('claims the read subcommands, including behind -C and --git-dir', () => {
    expect(claims('git status --short')).toBe(true);
    expect(claims('git log --oneline -5 -- packages/operator-core')).toBe(true);
    expect(claims('git -C libs/papercusp status --porcelain')).toBe(true);
    expect(claims('git --git-dir=/home/x/.git for-each-ref')).toBe(true);
    expect(claims('git merge-base --is-ancestor ff1e25c5 a5ba5521 2>/dev/null')).toBe(true);
  });

  /**
   * The D-008 boundary, and the ONLY one this tool has: `args` is a literal
   * `string[]` and expands nothing, so a command whose argv the shell produces
   * has no tool form. 99 of 2,500 corpus reads (4.0%) are this residue.
   */
  it('excludes commands whose argv comes from the shell', () => {
    expect(claims('git -C "$DESK" rev-parse HEAD 2>/dev/null')).toBe(false);
    expect(claims('git log -1 --format=%H -- $(find . -name x.ts)')).toBe(false);
    expect(claims('git -C $R for-each-ref `cat /tmp/refs`')).toBe(false);
  });

  /** The tripwire: the exclusion must live in the PATTERN, so a substituted
   *  atom that reaches `cover()` scores NOT covered and drops the verdict. */
  it('still scores a substituted atom as uncovered, so a broken exclusion is loud', () => {
    const result = gitReadPassthrough.cover('git -C "$DESK" rev-parse HEAD');
    expect(result.covered).toBe(false);
    expect(result.reason).toContain('LITERAL string[]');
  });

  it('does not claim git writes — git-sync owns commit and push', () => {
    expect(claims('git commit -m "wip"')).toBe(false);
    expect(claims('git push origin staging')).toBe(false);
    expect(claims('git add -A')).toBe(false);
    expect(claims('git reset --hard HEAD')).toBe(false);
  });

  it('renders a faithful tool call, quoted arguments intact', () => {
    const result = gitReadPassthrough.cover(`git log --format='%H %cI' -3 -- bin/lib/x.sh`);
    expect(result.covered).toBe(true);
    expect(result.expression).toBe(
      'capability:git { args: ["log", "--format=%H %cI", "-3", "--", "bin/lib/x.sh"] }',
    );
  });

  it('maps a repo-selecting global flag onto cwd, not onto argv', () => {
    const result = gitReadPassthrough.cover('git -C /home/x/papercup-release rev-parse HEAD 2>/dev/null');
    expect(result.covered).toBe(true);
    expect(result.expression).toBe(
      'capability:git { args: ["rev-parse", "HEAD"], cwd: "/home/x/papercup-release" }',
    );
  });

  it('does not reach across into the other families', () => {
    expect(claims('psql -d papercusp -c "SELECT 1"')).toBe(false);
    expect(claims('ps aux')).toBe(false);
    expect(claims('systemctl --user is-active papercup-bg-host.service')).toBe(false);
  });
});
