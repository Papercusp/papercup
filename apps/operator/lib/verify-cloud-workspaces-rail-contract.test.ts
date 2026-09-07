/**
 * Contract guard for scripts/verify-cloud-workspaces-rail.sh — the live
 * verification instrument for plan cloud-workspaces-guided-rail-2026-08-28.
 *
 * WHY THIS FILE EXISTS. The plan's acceptance rubric
 * (cloud-workspaces-guided-rail-acceptance, criterion
 * `verified-live-with-stated-coverage`) asks a GRADER to confirm several
 * properties of that script by reading it: that it emits a machine-readable
 * coverage line, that no assertion is an unguarded negative, and that the run
 * is read-only. Those are exactly the checks that rot when nobody re-reads the
 * script — so they are pinned here instead of re-asked of every future grader.
 *
 * The rubric originally declared the .sh itself as its `check.kind:'tests'`
 * file. That made the rubric permanently ungradeable: `scorecards:emit` routes
 * every rated criterion's declared files through the Vitest router, and the
 * router cannot report on a shell script (TEST_FILE_UNSUPPORTED_INPUT /
 * NON_TEST), so the emit refused unconditionally and the plan could never reach
 * `shipped`. The class fix — validating routability at propose time — is
 * WI-369566. This file is the local repair: a real Vitest suite the rubric can
 * point at, which pins the script's contract rather than merely naming it.
 *
 * The `exercised` field is derived from the labels of assertions that actually
 * reported PASS. This keeps a fixture with matching preconditions from being
 * mistaken for one whose guarded assertion really ran.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");
/* Overridable so falsifiability can be proven against a COPY outside the tree
   (scripts/mutation-probe.sh --file ... ), never by mutating this shared
   checkout: git-sync sweeps the whole tree every few minutes and would commit
   a probe's intermediate mutant even when nothing goes wrong. */
const SCRIPT = process.env.CW_RAIL_SCRIPT
  ? resolve(process.env.CW_RAIL_SCRIPT)
  : resolve(ROOT, "scripts/verify-cloud-workspaces-rail.sh");
const src = readFileSync(SCRIPT, "utf8");

/** The script with comment-only lines removed, so prose describing a behaviour
 *  is never mistaken for the behaviour itself. (`grep 'click'` over the raw
 *  source matches three COMMENTS promising the script does not click — the
 *  exact false positive this strips.) */
const code = src
  .split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

describe("verify-cloud-workspaces-rail.sh — live-verification contract", () => {
  it("emits the CW_RAIL_RESULT coverage line with every field the rubric reads", () => {
    /* The rubric's method reads this line FIRST and refuses a pass on failed>0
       or unaccepted skips. If the format drifts, a grader silently loses the
       ability to tell a real verification from a green run that skipped
       everything — so pin the exact printf contract, not just the token. */
    expect(code).toContain(
      "CW_RAIL_RESULT passed=%d failed=%d skipped=%d hosts=%d drifting=%d exercised=%s",
    );

    /* Positive control for the instrument: the same source must NOT contain a
       format string we know was never written, or `toContain` passing above
       would prove nothing about how the file was read. */
    expect(code).not.toContain("CW_RAIL_RESULT ok=%d");
  });

  it("can name all three data-dependent assertions the rubric requires", () => {
    /* `exercised` is what makes the run evidence rather than ceremony: these
       three can only pass against real fixture data. The rubric refuses a pass
       when they are absent, so the vocabulary must exist in the emitter. */
    for (const token of [
      "landing-operate",
      "expanded-host-tabs",
      "drift-divergent-form",
      "desktop-workspace-layout",
    ]) {
      expect(code).toContain(token);
    }
  });

  it("derives exercised coverage from PASS labels, not fixture preconditions", () => {
    /* A fixture count only says that a subject might be available. The
       coverage line must name a capability only after its assertion has
       reported PASS, otherwise a failed assertion can still be quoted as
       exercised coverage. */
    expect(code).toMatch(
      /passed_labels="\$\{passed_labels\}\$\{passed_labels:\+\$'\\n'\}\$\*"/,
    );
    expect(code).toContain(
      'grep_pass "$passed_labels" "R3 a fresh visit lands on Operate once a workspace exists"',
    );
    expect(code).toContain(
      'grep_pass "$passed_labels" "R9 ?tab=resources selects Resources; the host tablist keeps exactly one tab stop"',
    );
    expect(code).toContain(
      'grep_pass "$passed_labels" "R4 a diverging host renders ONE chip in the \'observed → desired\' form"',
    );
    expect(code).not.toMatch(/\[\s*"\$HOSTS"\s+-gt\s+0\s*\]\s*&&\s*EXERCISED=/);
    expect(code).not.toMatch(
      /\[\s*"\$DRIFTING"\s+-gt\s+0\s*\]\s*&&\s*EXERCISED=/,
    );
  });

  it("uses no unguarded negative assertion", () => {
    /* An absence assertion on a half-loaded document is vacuously true. The
       rubric names this as a drift marker and asks the grader to grep for it. */
    expect(src).not.toContain("allow-unguarded-negative");
  });

  it("refuses a missing explicitly requested host instead of reporting skipped acceptance", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "cw-required-host-"));
    try {
      const poll = resolve(dir, "poll.sh");
      const tat = resolve(dir, "tat.sh");
      writeFileSync(
        poll,
        '#!/bin/sh\ncase "$*" in *host-panel-required-host*) exit 1;; *) exit 0;; esac\n',
        { mode: 0o755 },
      );
      writeFileSync(tat, '#!/bin/sh\nprintf "0\\n"\n', { mode: 0o755 });
      const run = spawnSync("bash", [SCRIPT], {
        encoding: "utf8",
        timeout: 5000,
        env: {
          ...process.env,
          VERIFY_TAURI_PID: "1",
          VERIFY_TAURI_PORT: "33700",
          VERIFY_TAURI_POLL: poll,
          VERIFY_TAURI_AGENT_TOOLS_BIN: tat,
          CW_HOST_ID: "required-host",
          CW_SHOT_DIR: resolve(dir, "shots"),
        },
      });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(
        "requested host required-host did not render",
      );
      expect(run.stdout).not.toContain("CW_RAIL_RESULT");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("measures desktop layout on the selected tab and keeps the final assertion on the last navigation", () => {
    expect(code).toContain("tab=desktops");
    expect(code).toContain('[aria-label="Workspace desktops and activity"]');
    expect(code).toContain("layout.scrollWidth<=layout.clientWidth+1");
    expect(code).toContain(
      "layout.clientWidth>860 ? s.left>=m.right : s.top>=m.bottom",
    );
    expect(code).toContain('CURRENT_NONCE="$nonce"');
    expect(code).toContain('settle "$CURRENT_NONCE" "$RAIL"');
  });

  it("fuses the navigation nonce and a presence guard into one evaluation", () => {
    /* settle() is the only assertion primitive. Both halves must be in the SAME
       --eval: the nonce proves the navigation landed, --require proves the
       subject rendered. Split across two evaluations, a stale document can
       satisfy one while the other is measured on the next frame. */
    expect(code).toContain("location.href.indexOf('vnonce=");
    expect(code).toMatch(/--require\s+"\$req"/);
    expect(code).toMatch(/settle\(\)\s*\{/);
  });

  it("stays read-only: no lifecycle control is clicked and no form submitted", () => {
    /* The wrapper does NOT isolate the database by default, so a lifecycle
       click here really provisions, stops or destroys a live cloud host. This
       asserts against COMMENT-STRIPPED source, because the script's own header
       comments mention exactly these words while promising not to do them. */
    expect(code).not.toMatch(/\bclick\b/i);
    expect(code).not.toMatch(/\bsubmit\(/i);
  });

  it("fails the run when any assertion failed, and marks skips as unverified", () => {
    /* A skip is unverified coverage, not a pass. The script must say so rather
       than let `exit 0` be read as full coverage. */
    expect(code).toMatch(/if \[ "\$failures" -gt 0 \]/);
    expect(code).toContain("exit 1");
    expect(src).toContain("A skipped assertion is UNVERIFIED");
  });
});
