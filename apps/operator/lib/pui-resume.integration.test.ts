// @vitest-environment node
/**
 * PUI resume, end to end through the real launcher process
 * (consult-backed-parking-2026-10-12 P-012, bars R-11 and R-25).
 *
 * PUI's ended-session route opens a pane running `psu --resume <adv id>`
 * (apps/tui/src/app.rs resume_spec, pinned by its own Rust tests). This file
 * runs that exact command as a child process — the real
 * apps/operator/scripts/psu-launcher.mjs, not an imported function — with:
 *
 *   - a throwaway HOME holding each backend's native transcript where the
 *     launcher's own lookup finds it,
 *   - fake `claude` / `codex` / `omp` binaries first on PATH that record their
 *     argv and working directory instead of starting a model, and
 *   - a stub operator on a random port that serves the tracked session row and
 *     the resume reservation verdicts, and records every request.
 *
 * `--no-picker` takes the picker's default row; that the default row IS the
 * original backend is pinned in psu-pui-resume.test.ts.
 *
 *   R-11 — a claude, codex or omp session reopens in its ORIGINAL backend, in
 *          its recorded cwd, resuming its own native conversation id whose
 *          transcript is on disk.
 *   R-25 — a cross-backend pick that cannot be honoured exits non-zero with its
 *          cause, and no backend process is spawned.
 */
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const LAUNCHER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../scripts/psu-launcher.mjs",
);
const BACKENDS = ["claude", "codex", "omp"] as const;
type Backend = (typeof BACKENDS)[number];

const ADV_ID = 42;
const OWNER = "su-pui-resume-it-owner";
const CLAUDE_SESSION = "bb06937a-2054-4f27-945b-225b84dc3ccb";
const CODEX_ROLLOUT = "0199c1d2-7a3b-7c44-9d55-e66f77a88b99";
const OMP_THREAD = "pui-resume-omp-thread-01";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

interface Fixture {
  home: string;
  cwd: string;
  session: Record<string, unknown>;
  /** The native transcript the resume must reopen (absent for an R-25 source). */
  transcript: string | null;
}

/** A tracked, ended adv session of `agent` with its native transcript on disk. */
function fixture(agent: Backend, { withTranscript = true } = {}): Fixture {
  const home = mkdtempSync(join(tmpdir(), `pui-resume-it-${agent}-`));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const cwd = join(home, "repo");
  mkdirSync(cwd, { recursive: true });
  const base = {
    id: ADV_ID,
    agent,
    role: null,
    workspaceId: "papercusp-workspace",
    coordOwnerId: OWNER,
    cwd,
    endedAt: new Date().toISOString(),
  };
  let session: Record<string, unknown>;
  let transcript: string | null = null;
  if (agent === "claude") {
    const configDir = join(home, ".papercusp", "su-claude-homes", OWNER);
    session = { ...base, sessionId: CLAUDE_SESSION, configDir };
    const dir = join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    transcript = join(dir, `${CLAUDE_SESSION}.jsonl`);
    if (withTranscript) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        transcript,
        `${JSON.stringify({ type: "user", sessionId: CLAUDE_SESSION, cwd, message: { role: "user", content: "hello from before" } })}\n`,
      );
    }
  } else if (agent === "codex") {
    const codexHome = join(home, ".papercusp", "su-codex-homes", `session-${ADV_ID}`);
    session = { ...base, sessionId: CODEX_ROLLOUT, codexHome };
    const dir = join(codexHome, "sessions", "2026", "10", "12");
    transcript = join(dir, `rollout-2026-10-12T00-00-00-${CODEX_ROLLOUT}.jsonl`);
    if (withTranscript) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        transcript,
        [
          { type: "session_meta", payload: { id: CODEX_ROLLOUT, cwd } },
          { type: "turn_context", payload: { cwd, model: "gpt-5.5" } },
          { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello from before" }] } },
        ]
          .map((l) => JSON.stringify(l))
          .join("\n") + "\n",
      );
    }
  } else {
    const agentHome = join(home, ".papercusp", "su-omp-homes", `session-${ADV_ID}`, "agent");
    session = { ...base, ompThreadId: OMP_THREAD, agentHome };
    // The default account route restores the user's global OMP registry into the
    // session's isolated one (applyOmpResumeAccountRoute); a real user has it.
    mkdirSync(join(home, ".omp", "agent"), { recursive: true });
    writeFileSync(join(home, ".omp", "agent", "models.yml"), "providers: {}\n");
    const dir = join(agentHome, "sessions", "repo");
    transcript = join(dir, `2026-10-12T00-00-00_${OMP_THREAD}.jsonl`);
    if (withTranscript) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        transcript,
        `${JSON.stringify({ type: "session", id: OMP_THREAD, cwd })}\n${JSON.stringify({ type: "message", message: { role: "user", content: "hello from before" } })}\n`,
      );
    }
  }
  return { home, cwd, session, transcript: withTranscript ? transcript : null };
}

interface Launch {
  bin: string;
  cwd: string;
  argv: string[];
}

interface RunResult {
  code: number | null;
  output: string;
  requests: Array<{ method: string; path: string; body: string }>;
  launches: Launch[];
}

/** Run `psu --resume <id> --no-picker [...extra]` against the fixture. */
async function runPsuResume(fx: Fixture, extra: string[] = []): Promise<RunResult> {
  const bin = join(fx.home, "fakebin");
  const launchDir = join(fx.home, "launches");
  mkdirSync(bin, { recursive: true });
  mkdirSync(launchDir, { recursive: true });
  for (const b of BACKENDS) {
    const p = join(bin, b);
    // One record per spawn: binary name, working directory, then argv one per line.
    writeFileSync(
      p,
      `#!/bin/sh\n{ printf '%s\\n' "${b}" "$PWD"; printf '%s\\n' "$@"; } > "${launchDir}/${b}.$$"\nexit 0\n`,
    );
    chmodSync(p, 0o755);
  }

  const requests: RunResult["requests"] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const path = req.url ?? "";
      requests.push({ method: req.method ?? "", path, body });
      res.setHeader("content-type", "application/json");
      if (path.startsWith("/api/adv/sessions/resumable")) {
        res.end(JSON.stringify({ sessions: [fx.session] }));
      } else if (path.endsWith("/session-resumed")) {
        res.end(JSON.stringify({ ok: true, acquired: true, status: "acquired" }));
      } else {
        res.end(JSON.stringify({ ok: true }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  cleanups.push(() => server.close());
  const port = (server.address() as { port: number }).port;

  // Nothing from the developer's own session may steer the child: drop every
  // papercusp/backend variable, then point it at the stub and the fake binaries.
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(PAPERCUSP_|CLAUDE|CODEX_|OMP_|PI_|ANTHROPIC_|OPENAI_)/.test(k)) continue;
    env[k] = v;
  }
  Object.assign(env, {
    HOME: fx.home,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    PAPERCUSP_OPERATOR_URL: `http://127.0.0.1:${port}`,
    PAPERCUSP_MCP_PROXY: "0",
  });

  const child = spawn(
    process.execPath,
    [LAUNCHER, "--resume", String(ADV_ID), "--no-picker", ...extra],
    { cwd: fx.home, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const killer = setTimeout(() => child.kill("SIGKILL"), 90_000);
  const code = await new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
  clearTimeout(killer);

  const launches = readdirSync(launchDir).map((f) => {
    const [b, cwd, ...argv] = readFileSync(join(launchDir, f), "utf8").split("\n");
    return { bin: b, cwd, argv: argv.filter((a, i) => !(a === "" && i === argv.length - 1)) };
  });
  return { code, output, requests, launches };
}

/** The argv slice that names WHICH conversation the backend reopens. */
function nativeResumeTarget(agent: Backend, argv: string[]): string | undefined {
  if (agent === "claude") return argv[argv.indexOf("--resume") + 1];
  if (agent === "omp") return argv[argv.indexOf("-r") + 1];
  return argv.find((a) => a === CODEX_ROLLOUT);
}

const NATIVE_ID: Record<Backend, string> = {
  claude: CLAUDE_SESSION,
  codex: CODEX_ROLLOUT,
  omp: OMP_THREAD,
};

describe("PUI resume reopens the original backend with its conversation (R-11)", () => {
  it.each(BACKENDS)(
    "psu --resume of an ended %s session spawns that backend once, in its cwd, on its own transcript",
    async (agent) => {
      const fx = fixture(agent);
      const run = await runPsuResume(fx);

      expect(run.code, run.output).toBe(0);
      expect(run.launches, run.output).toHaveLength(1);
      const [launch] = run.launches;
      expect(launch.bin).toBe(agent);
      expect(launch.cwd).toBe(fx.cwd);
      expect(nativeResumeTarget(agent, launch.argv), launch.argv.join(" ")).toBe(NATIVE_ID[agent]);
      // The conversation the argv names is still on disk for the backend to load.
      expect(fx.transcript && existsSync(fx.transcript)).toBe(true);
      expect(readFileSync(fx.transcript as string, "utf8")).toContain("hello from before");

      // The operator saw an in-place resume of THIS session, not a cross-backend port.
      const paths = run.requests.map((r) => r.path);
      expect(paths).toContain("/api/agent-mcp/console/bootstrap-su/session-resumed");
      expect(paths.some((p) => /port/i.test(p))).toBe(false);
      const finalized = run.requests.find((r) => r.path.endsWith("/session-resume-finalized"));
      expect(finalized, paths.join("\n")).toBeDefined();
      const body = JSON.parse(finalized!.body) as { advSessionId: number; launchArgv: string[] };
      expect(body.advSessionId).toBe(ADV_ID);
      expect(body.launchArgv).toContain(`--agent=${agent}`);
    },
    120_000,
  );
});

describe("PUI cross-backend resume refusal (R-25)", () => {
  it(
    "a cross-backend pick of a session with no source transcript exits non-zero with its cause and spawns nothing",
    async () => {
      const fx = fixture("codex", { withTranscript: false });
      const run = await runPsuResume(fx, ["--agent", "claude"]);

      expect(run.code).not.toBe(0);
      expect(run.output).toMatch(/psu: refusing to resume — .*no source transcript to carry onto claude/);
      expect(run.launches).toEqual([]);
      // Only the session lookup reached the operator: no reservation, port or account call.
      expect(run.requests.every((r) => r.path.startsWith("/api/adv/sessions/resumable"))).toBe(true);
    },
    120_000,
  );
});
