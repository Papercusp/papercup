/**
 * WI-10003957 — the nested-CLI guard in the SessionStart/SessionEnd lifecycle hook.
 *
 * A `claude`/`codex` run from inside another agent (its Bash tool, or anything under a
 * capability:bash job) inherits that agent's PAPERCUSP_SID, so the global lifecycle hook
 * used to report the nested CLI's SessionEnd AS the su — and a `terminal` verdict then
 * fleet:kill'ed the live su (su-075445e6, 2026-09-29 21:45:42Z). `pc_nested_cli.py`
 * decides "nested" from the process tree; lifecycle-report.sh skips the report on it.
 *
 * Two layers:
 *  1. the pure decision (`nested_cli_reason`) against a FAKE /proc table, so every
 *     branch is deterministic regardless of what this test itself runs under;
 *  2. the real hook end-to-end under a real process tree built with `exec -a`, asserting
 *     on the HTTP requests it actually sends (the only observable that matters: a nested
 *     CLI must send NOTHING, a managed CLI must still report).
 */
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { createServer } from "node:http";
import * as os from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HOOK_DIR = join(__dirname, "..");
// Overridable so a falsifiability probe can point the end-to-end cases at an OUT-OF-TREE
// copy of hooks/cc with the guard stripped (it must then fail) — never mutate the tree.
const LIFECYCLE_HOOK =
  process.env.PC_NESTED_CLI_HOOK_UNDER_TEST ?? join(HOOK_DIR, "lifecycle-report.sh");

type ProcTable = Record<number, [number, string[]]>;

/** Run nested_cli_reason(start_pid, environ, proc=<fake table>) in python. */
function reason(
  table: ProcTable,
  startPid: number,
  environ: Record<string, string> = {},
): string | null {
  const script = [
    "import json, sys",
    "sys.path.insert(0, sys.argv[1])",
    "from pc_nested_cli import nested_cli_reason",
    "spec = json.loads(sys.stdin.read())",
    "table = {int(k): (v[0], v[1]) for k, v in spec['table'].items()}",
    "r = nested_cli_reason(start_pid=spec['start'], environ=spec['env'], proc=lambda pid: table.get(pid))",
    "print(json.dumps(r))",
  ].join("\n");
  return JSON.parse(
    execFileSync("python3", ["-c", script, HOOK_DIR], {
      input: JSON.stringify({ table, start: startPid, env: environ }),
      encoding: "utf8",
    }),
  ) as string | null;
}

// Shared tail of every fake tree: a terminal under the user's systemd.
const BASE: ProcTable = {
  2: [1, ["/usr/lib/systemd/systemd", "--user"]],
  3: [2, ["/usr/libexec/gnome-terminal-server"]],
  4: [3, ["bash", "-l"]],
};
const LAUNCHER_ARGV = [
  "/usr/bin/node",
  "/repo/apps/operator/scripts/psu-launcher.mjs",
  "--agent=claude",
];
const HOOK_CHAIN = (cliPid: number): ProcTable => ({
  100: [101, ["bash", "/home/u/.papercusp/hooks/cc/lifecycle-report.sh"]],
  101: [cliPid, ["/bin/sh", "-c", "bash lifecycle-report.sh"]],
});

describe("pc_nested_cli.nested_cli_reason — decision table (fake /proc)", () => {
  it("a managed su (CLI is a direct child of psu-launcher.mjs) is NOT nested", () => {
    // The measured live shape on 2026-09-29: psu-launcher hosts the PTY in-process.
    const t: ProcTable = {
      ...BASE,
      5: [4, ["bash", "/home/u/.papercusp/bin/psu"]],
      6: [5, LAUNCHER_ARGV],
      7: [6, ["claude", "--settings", "{}"]],
      ...HOOK_CHAIN(7),
    };
    expect(reason(t, 100)).toBeNull();
  });

  it("a managed su under a separate psu-pty-host process is NOT nested", () => {
    const t: ProcTable = {
      ...BASE,
      6: [4, ["node", "/repo/apps/operator/scripts/psu-pty-host.mjs"]],
      7: [6, ["claude"]],
      ...HOOK_CHAIN(7),
    };
    expect(reason(t, 100)).toBeNull();
  });

  it("psu parentage wins even over a capability:bash marker and an agent CLI above it", () => {
    // psu minted this CLI's own SID, so however the launcher was started, it is a real
    // session — the incident class is an INHERITED SID, which a psu child never has.
    const t: ProcTable = {
      ...BASE,
      5: [4, ["claude"]],
      6: [5, ["/bin/bash", "-c", "psu --agent=claude"]],
      8: [6, ["node", "/repo/apps/operator/scripts/psu-launcher.mjs"]],
      9: [8, ["claude"]],
      ...HOOK_CHAIN(9),
    };
    expect(reason(t, 100, { PAPERCUSP_CAPABILITY_BASH_FOREGROUND: "1" })).toBeNull();
  });

  it("a `claude -p` run from an su's Bash tool IS nested (another agent CLI above it)", () => {
    const t: ProcTable = {
      ...BASE,
      6: [4, LAUNCHER_ARGV],
      7: [6, ["claude", "--settings", "{}"]],
      8: [7, ["/bin/bash", "-c", "source snapshot; claude -p 'say ok'"]],
      9: [8, ["claude", "-p", "say ok"]],
      ...HOOK_CHAIN(9),
    };
    expect(reason(t, 100)).toBe("nested under agent CLI pid 7");
  });

  it("the incident shape — a test-spawned probe under a capability:bash job — IS nested", () => {
    // capability:bash runs under systemd-run, NOT under the su's CLI, so only the job's
    // env marker identifies it. Both markers are always present (value may be '').
    const t: ProcTable = {
      ...BASE,
      20: [2, ["/usr/bin/bash", "-lc", "trap ... npm run test:all:integration"]],
      21: [20, ["npm", "run", "test:all:integration"]],
      22: [21, ["node", "/repo/node_modules/vitest/dist/workers/forks.js"]],
      23: [22, ["claude", "-p", "say ok"]],
      ...HOOK_CHAIN(23),
    };
    expect(reason(t, 100, { PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID: "" })).toBe(
      "inside a capability:bash job (PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID)",
    );
    expect(reason(t, 100, { PAPERCUSP_CAPABILITY_BASH_FOREGROUND: "1" })).toBe(
      "inside a capability:bash job (PAPERCUSP_CAPABILITY_BASH_FOREGROUND)",
    );
    // Calibration: the same tree WITHOUT the marker carries no positive evidence.
    expect(reason(t, 100, {})).toBeNull();
  });

  it("Codex's node wrapper over its vendor binary is ONE CLI, not a nested pair", () => {
    const t: ProcTable = {
      ...BASE,
      6: [4, LAUNCHER_ARGV],
      7: [6, ["node", "/usr/lib/node_modules/@openai/codex/bin/codex"]],
      8: [7, ["/usr/lib/node_modules/@openai/codex/vendor/codex-x86_64-unknown-linux-musl"]],
      ...HOOK_CHAIN(8),
    };
    expect(reason(t, 100)).toBeNull();
  });

  it("recognises a claude-code node entrypoint as an agent CLI", () => {
    const t: ProcTable = {
      ...BASE,
      7: [4, ["node", "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js"]],
      8: [7, ["bash", "-c", "claude -p hi"]],
      9: [8, ["claude", "-p", "hi"]],
      ...HOOK_CHAIN(9),
    };
    expect(reason(t, 100)).toBe("nested under agent CLI pid 7");
  });

  it("fails OPEN (not nested) when /proc cannot answer or no agent CLI is found", () => {
    // Unreadable hook parent.
    expect(reason({}, 100, { PAPERCUSP_CAPABILITY_BASH_FOREGROUND: "1" })).toBeNull();
    // A tree with no agent CLI at all (e.g. a hook run by a test harness in CI):
    // the marker alone is not enough — there is no CLI to be nested.
    const t: ProcTable = {
      ...BASE,
      22: [4, ["node", "/repo/node_modules/vitest/dist/workers/forks.js"]],
      100: [22, ["bash", "lifecycle-report.sh"]],
    };
    expect(reason(t, 100, { PAPERCUSP_CAPABILITY_BASH_FOREGROUND: "1" })).toBeNull();
  });

  it("an unreadable ancestor ABOVE the CLI does not hide a capability:bash marker", () => {
    const gap: ProcTable = { 9: [8, ["claude"]], ...HOOK_CHAIN(9) };
    expect(reason(gap, 100)).toBeNull();
    expect(reason(gap, 100, { PAPERCUSP_CAPABILITY_BASH_FOREGROUND: "1" })).toBe(
      "inside a capability:bash job (PAPERCUSP_CAPABILITY_BASH_FOREGROUND)",
    );
  });
});

// ── End-to-end: the real hook under a real process tree ─────────────────────────
let home: string;
let fixtures: string;

beforeAll(() => {
  home = fs.mkdtempSync(join(os.tmpdir(), "pc-nested-home-"));
  fs.mkdirSync(join(home, ".papercusp"), { recursive: true });
  fs.writeFileSync(join(home, ".papercusp", "superuser-token"), "test-token\n");
  fixtures = fs.mkdtempSync(join(os.tmpdir(), "pc-nested-fx-"));
  // The fake agent CLI: a bash whose argv[0] is `claude` (set via `exec -a`), running the
  // hook as a CHILD so the hook's /proc ancestry really passes through a "claude".
  fs.writeFileSync(
    join(fixtures, "fake-claude-body.sh"),
    'bash "$LIFECYCLE_HOOK"\nexit $?\n',
  );
  // The fake launcher: argv = [node, …/psu-launcher.mjs], parent of the fake claude.
  fs.writeFileSync(
    join(fixtures, "psu-launcher.mjs"),
    '( exec -a claude bash "$FAKE_CLAUDE_BODY" )\nexit $?\n',
  );
});
afterAll(() => {
  for (const d of [home, fixtures]) fs.rmSync(d, { recursive: true, force: true });
});

async function runHookUnder(
  shape: "nested-cli" | "psu-managed",
  event: string,
  hookPath: string = LIFECYCLE_HOOK,
  extraPayload: Record<string, unknown> = {},
) {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({ ok: true, session_end_disposition: "continuation" }),
              },
            ],
          },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind");

  const body = join(fixtures, "fake-claude-body.sh");
  const launcher = join(fixtures, "psu-launcher.mjs");
  const argv =
    shape === "nested-cli"
      ? ["-c", 'exec -a claude bash "$0"', body]
      : ["-c", 'exec -a node bash "$0"', launcher];
  const child = spawn("bash", argv, {
    env: {
      ...process.env,
      HOME: home,
      PAPERCUSP_SID: "su-nested-guard-test",
      PAPERCUSP_AGENT: "claude",
      PAPERCUSP_OPERATOR_URL: `http://127.0.0.1:${address.port}`,
      PAPERCUSP_ACTIVITY_SYNC: "1",
      // Present in BOTH shapes: in the nested shape it makes the verdict deterministic
      // when no real agent CLI sits above this test (CI); in the managed shape it proves
      // psu parentage outranks it.
      PAPERCUSP_CAPABILITY_BASH_FOREGROUND: "1",
      PAPERCUSP_JOURNAL_SYNC: "1",
      LIFECYCLE_HOOK: hookPath,
      FAKE_CLAUDE_BODY: body,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stdin.end(
    JSON.stringify({
      hook_event_name: event,
      session_id: "nested-native-1",
      cwd: "/x",
      ...extraPayload,
    }),
  );
  const exitCode = await Promise.race([
    new Promise<number | null>((resolve) => child.once("close", resolve)),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("lifecycle hook timed out")), 8_000),
    ),
  ]);
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return { exitCode, stdout, requests };
}

describe("lifecycle-report.sh — nested-CLI guard end-to-end (WI-10003957)", () => {
  it("a NESTED CLI's SessionEnd sends nothing — no activity:report, no fleet:kill", async () => {
    const r = await runHookUnder("nested-cli", "SessionEnd");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.requests).toEqual([]);
  });

  it("a NESTED CLI's SessionStart sends nothing (no reanchor of the su's adv row)", async () => {
    const r = await runHookUnder("nested-cli", "SessionStart");
    expect(r.exitCode).toBe(0);
    expect(r.requests).toEqual([]);
  });

  it("calibration: a psu-managed CLI still reports its SessionEnd", async () => {
    // Without this the two assertions above could pass because the hook never reports
    // from this fixture at all (bad token path, unreachable URL, broken exec -a).
    const r = await runHookUnder("psu-managed", "SessionEnd");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.requests).toHaveLength(1);
    expect(r.requests[0]).toMatch(/^\/api\/mcp\?superuser=1&origin=hook&client=su-nested-guard-test/);
  });
});

// ── WI-10004863: the same leak in the per-TURN owner-mutating hooks ─────────────
// Measured: harness_shared.owner_directives held 12 'say ok' rows (the advertised-tools
// probe prompt) across 4 sessions — the provenance hook captured a nested CLI's `-p`
// prompt as an OWNER directive of the su. stop-turn-journal filed its turns likewise.
const PROVENANCE_HOOK = join(HOOK_DIR, "userpromptsubmit-provenance.sh");
const JOURNAL_HOOK = join(HOOK_DIR, "stop-turn-journal.sh");

/** Every hook that must skip a nested CLI. A new owner-mutating hook joins this list. */
const NESTED_GUARDED_HOOKS = [
  "lifecycle-report.sh",
  "userpromptsubmit-provenance.sh",
  "stop-turn-journal.sh",
];

describe("per-turn owner-mutating hooks skip a nested CLI (WI-10004863)", () => {
  it("each guarded hook consults pc_nested_cli.py BEFORE its operator-facing python runs", () => {
    // The owner-mutating work in every guarded hook is a `python3 - …` heredoc (the POST /
    // classification). lifecycle-report.sh legitimately reads stdin first (`python3 -c`, to
    // learn the event name) — that sends nothing, so the invariant is "guard before the
    // reporting heredoc", not "guard before stdin".
    for (const name of NESTED_GUARDED_HOOKS) {
      const src = fs.readFileSync(join(HOOK_DIR, name), "utf8");
      const guard = src.indexOf('python3 "$(dirname "$0")/pc_nested_cli.py"');
      const work = src.indexOf("python3 - ");
      expect(guard, `${name}: no pc_nested_cli.py guard`).toBeGreaterThan(-1);
      expect(work, `${name}: reporting heredoc not found (instrument broken)`).toBeGreaterThan(-1);
      expect(guard, `${name}: guard must run before the reporting heredoc`).toBeLessThan(work);
    }
  });

  it("a NESTED CLI's prompt is not classified, stamped or captured as an owner directive", async () => {
    const r = await runHookUnder("nested-cli", "UserPromptSubmit", PROVENANCE_HOOK, {
      prompt: "say ok",
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.requests).toEqual([]);
  });

  it("calibration: a psu-managed CLI's prompt IS still stamped", async () => {
    const r = await runHookUnder("psu-managed", "UserPromptSubmit", PROVENANCE_HOOK, {
      prompt: "say ok",
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("turn-provenance");
  });

  it("a NESTED CLI's Stop does not journal its turns under the su", async () => {
    const transcript = join(fixtures, "nested-transcript.jsonl");
    fs.writeFileSync(transcript, "{}\n");
    const r = await runHookUnder("nested-cli", "Stop", JOURNAL_HOOK, {
      transcript_path: transcript,
    });
    expect(r.exitCode).toBe(0);
    expect(r.requests).toEqual([]);
  });

  it("calibration: a psu-managed CLI's Stop still journals", async () => {
    const transcript = join(fixtures, "managed-transcript.jsonl");
    fs.writeFileSync(transcript, "{}\n");
    const r = await runHookUnder("psu-managed", "Stop", JOURNAL_HOOK, {
      transcript_path: transcript,
    });
    expect(r.exitCode).toBe(0);
    expect(r.requests).toHaveLength(1);
  });
});
