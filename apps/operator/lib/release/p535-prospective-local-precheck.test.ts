/** Independent prospective P535 acceptance, WI-6554700010020476. */
import { describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildP2pCandidateManifest,
  candidateArtifactDigest,
  type P2pCandidateProvenance,
  type P2pJourneyResult,
} from "./p2p-candidate-manifest";

// Owner-authored P521 population; a production deletion cannot shrink the oracle.
const JOURNEYS = [
  "discovery-join",
  "git-consistency-signed-scope",
  "serving-identity-restart",
  "replicated-write-outage-replay",
  "delegated-seat-lifecycle",
  "protected-effect-fencing",
  "github-bridge",
  "full-installer-compat",
] as const;
const candidate: P2pCandidateProvenance = {
  version: "0.0.99",
  channel: "alpha",
  sourceSha: "a".repeat(40),
  artifacts: [{ name: "candidate.deb", sha256: "b".repeat(64) }],
};
const now = Date.parse("2026-10-22T15:00:00Z");
function journeys() {
  const pass: P2pJourneyResult = {
    verdict: "pass",
    reason: "physical journey observed",
    measuredAt: new Date(now - 1_000).toISOString(),
    evidence: [{ ref: "physical-fixture", kind: "physical-drill" }],
    artifactDigest: candidateArtifactDigest(candidate.artifacts),
    observedPeers: ["mac-vm", "tower"],
  };
  return Object.fromEntries(JOURNEYS.map((key) => [key, { ...pass }]));
}

describe("P535 prospective same-artifact local precheck admission", () => {
  it.each(JOURNEYS)(
    "physical success cannot admit %s without its local precheck",
    async (key) => {
      // Deliberately supply no local precheck. Physical evidence alone cannot
      // discharge P535, even when every physical journey is otherwise green.
      const manifest = await buildP2pCandidateManifest({
        candidate,
        now,
        journeys: journeys(),
      });
      expect(manifest.current.go).toBe(false);
      expect(
        manifest.current.rows.find((row) => row.capability === key)?.state,
      ).not.toBe("passed-on-this-artifact");
    },
  );

  it("an entirely unmeasured candidate remains refused", async () => {
    const manifest = await buildP2pCandidateManifest({ candidate, now });
    expect(manifest.current.go).toBe(false);
    expect(manifest.current.rows.map((row) => row.capability)).toEqual(
      JOURNEYS,
    );
  });

  it.each([
    ["hive-git-physical-probe.sh", []],
    ["p202-workdist.sh", ["--i-accept-live-spawn"]],
  ] as const)("%s refuses missing local precheck before its first physical effect", (script, flags) => {
    const root = mkdtempSync(join(tmpdir(), "p535-dispatch-sentinel-"));
    try {
      const effects = join(root, "effects");
      const init = join(root, "sentinels.sh");
      const sentinel = '#!/bin/bash\nprintf "%s\\n" "$0 $*" >> "$P535_EFFECT_LOG"\nexit 97\n';
      // The production driver runs intact. Every external effect is intercepted
      // in both this shell and descendant shells; no physical host is contacted.
      for (const command of ["ssh", "scp", "rsync", "curl", "psql", "ptool"]) {
        const file = join(root, command);
        writeFileSync(file, sentinel);
        chmodSync(file, 0o755);
      }
      writeFileSync(init, [
        'export PATH="$P535_SENTINEL_BIN:$PATH"',
        'p535_effect() { printf "%s\\n" "$*" >> "$P535_EFFECT_LOG"; exit 97; }',
        ...["ssh", "scp", "rsync", "curl", "psql", "ptool"].map(command =>
          `${command}() { p535_effect ${command} "$@"; }`),
        // Even an absolute ptool/API/SSH path must stop inside the fixture.
        'set -T',
        'trap \'case "$BASH_COMMAND" in */ptool\\ *|/usr/bin/ssh\\ *|/usr/bin/curl\\ *) p535_effect "$BASH_COMMAND";; esac\' DEBUG',
      ].join("\n"));
      const probe = script === "hive-git-physical-probe.sh";
      const args = probe ? [join(root, "evidence.json"), join(root, "trust.json")] : [...flags];
      const run = spawnSync("bash", [resolve("../../papercusp-desktop/bin/vm-rig", script), ...args], {
        encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024,
        env: { ...process.env, BASH_ENV: init, PATH: `${root}:${process.env.PATH}`,
          P535_EFFECT_LOG: effects, P535_SENTINEL_BIN: root,
          HIVE_GIT_PHYSICAL_PLAN: "p2p-git-live-activation-2026-07-09",
          PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID: "p535-disposable-fixture",
          PCUSP_P202_MODEL: "gpt-5.6-sol", PCUSP_P202_EFFORT: "xhigh",
        },
      });
      const attempted = existsSync(effects) ? readFileSync(effects, "utf8") : "";
      expect(run.error).toBeUndefined();
      expect(attempted, run.stdout + run.stderr).toBe("");
      expect(run.status).not.toBe(0);
      expect(run.stdout + run.stderr).toMatch(/precheck.*(missing|absent|required|refus)|(?:missing|required|refus).*precheck/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
