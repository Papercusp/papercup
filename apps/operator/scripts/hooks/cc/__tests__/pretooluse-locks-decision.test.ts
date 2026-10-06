/**
 * pretooluse-locks-decision.test.ts — the file-lock PreToolUse hook's
 * OPERATOR-DEPENDENT decision rendering (coordination-test-suite-2026-06-08 P-008).
 *
 * cc-hooks.test.ts already covers the operator-INDEPENDENT paths (tool filtering,
 * workspace scoping, and the fail-open contract — operator unreachable / junk
 * input / not-installed never block an edit). The one path it leaves to a live
 * smoke is the DECISION rendering once the operator answers: a `busy` result must
 * become a `permissionDecision:'deny'` the MODEL can act on, and an `ok:true`
 * grant must allow + cache the lock_id for the matching PostToolUse release. This
 * closes that cell at the hook layer with a STUB operator (a real socket speaking
 * the JSON-RPC tools/call envelope), so the block-on-held → deny path — the file
 * lock the whole shared-tree discipline rests on — is regression-guarded without
 * needing a live operator.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runHookProcess } from "./spawn-hook";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { createServer, type Server } from "node:http";

// Overridable so a falsifiability probe can point the suite at a COPY of an older
// hook outside the shared tree (never mutate the tracked file in place).
const HOOK =
  process.env.PAPERCUSP_TEST_LOCKS_ACQUIRE_HOOK ??
  join(__dirname, "..", "pretooluse-locks-acquire.sh");
const POST_HOOK = join(__dirname, "..", "posttooluse-locks-release.sh");

let home: string, cache: string, ws: string, repo: string;
let server: Server;
let port: number;
/** The inner tools/call result the stub returns next ({ ok, lock_id?, busy?, reason? }). */
let nextInner: unknown = { ok: true, lock_id: "stub-lock" };
/** Optional SEQUENCE of inner results, one shifted per operator call — lets a test
 * drive the hook's EI-9478 transient-retry loop across multiple attempts (e.g.
 * contended on attempt 1, ok on attempt 2). When null/empty the static `nextInner`
 * is used for every call, so existing tests are unaffected. */
let nextInnerSeq: unknown[] | null = null;
/** Simulate a stale operator that rejects the newer coordination_domain arg. */
let rejectCoordinationDomain = false;
/** Optionally frame the response as text/event-stream (the hook parses both). */
let useSse = false;
/** Simulate an acquire that committed but returned an empty MCP content array. */
let emptyAcquireContent = false;
/** Recovery responses keyed by tool name; null leaves the existing static reply path. */
let recoveryQueueInner: unknown | null = null;
let recoveryReleaseInner: unknown | null = null;
let lastRequest: { url: string; body: Record<string, any> } | null = null;
let requests: Array<{ url: string; body: Record<string, any> }> = [];

// Every hook spawn below passes `...process.env`. The worktree guard reads
// PAPERCUSP_CANONICAL_TREE before its <ws>/papercusp default, and a psu session
// exports it (pointing at the real staging tree). If it is inherited, the guard
// refuses every edit in this test's temp workspace (WI-10003698). Scrub it for
// the whole file so the guard falls back to the default this suite asserts.
const inheritedCanonicalTree = process.env.PAPERCUSP_CANONICAL_TREE;

beforeAll(async () => {
  delete process.env.PAPERCUSP_CANONICAL_TREE;
  home = fs.mkdtempSync(join(os.tmpdir(), "cchook-dec-home-"));
  fs.mkdirSync(join(home, ".papercusp"), { recursive: true });
  fs.writeFileSync(join(home, ".papercusp", "superuser-token"), "test-token\n");
  fs.writeFileSync(join(home, ".papercusp", "su-agent-id"), "test-agent\n");
  cache = fs.mkdtempSync(join(os.tmpdir(), "cchook-dec-cache-"));
  ws = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "cchook-dec-ws-")));
  repo = join(ws, "papercusp"); // the canonical staging tree (worktree guard default: <ws>/papercusp)
  fs.mkdirSync(join(repo, "sub"), { recursive: true });
  fs.writeFileSync(join(repo, ".git"), "gitdir: /nonexistent\n");

  // Stub operator: respond to the hook's POST /api/mcp with a JSON-RPC result
  // wrapping the next inner payload as the tools/call text content (the exact
  // shape the hook parses). A `nextInnerSeq` (when set) is drained one entry per
  // request so a test can script attempt-1-vs-attempt-2 outcomes; otherwise the
  // static `nextInner` answers every request.
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const parsed = JSON.parse(body) as Record<string, any>;
      lastRequest = { url: req.url ?? "", body: parsed };
      requests.push(lastRequest);
      const args = parsed.params?.arguments as Record<string, any> | undefined;
      const toolName = parsed.params?.name as string | undefined;
      const rejectsDomain =
        rejectCoordinationDomain && args?.coordination_domain;
      let recoveryInner: unknown | null = null;
      if (toolName === "locks:queue" && recoveryQueueInner !== null) {
        recoveryInner = JSON.parse(JSON.stringify(recoveryQueueInner));
        const rows = (recoveryInner as any)?.active_locks;
        if (Array.isArray(rows) && args?.owner) {
          for (const row of rows) {
            if (row?.owner === "$REQUEST_OWNER") row.owner = args.owner;
          }
        }
      } else if (
        toolName === "locks:release" &&
        recoveryReleaseInner !== null
      ) {
        recoveryInner = recoveryReleaseInner;
      }
      const rpc = rejectsDomain
        ? {
            jsonrpc: "2.0",
            id: 1,
            error: {
              code: -32602,
              message:
                'invalid_input: invalid_args: Unrecognized key: "coordination_domain"',
            },
          }
        : toolName === "locks:acquire" && emptyAcquireContent
          ? {
              jsonrpc: "2.0",
              id: 1,
              result: { content: [] },
            }
          : recoveryInner !== null
            ? {
                jsonrpc: "2.0",
                id: 1,
                result: {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify(recoveryInner),
                    },
                  ],
                },
              }
            : {
                jsonrpc: "2.0",
                id: 1,
                result: {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify(
                        nextInnerSeq && nextInnerSeq.length
                          ? nextInnerSeq.shift()
                          : nextInner,
                      ),
                    },
                  ],
                },
              };
      if (useSse) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`event: message\ndata: ${JSON.stringify(rpc)}\n\n`);
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(rpc));
      }
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const d of [home, cache, ws])
    fs.rmSync(d, { recursive: true, force: true });
  if (inheritedCanonicalTree !== undefined)
    process.env.PAPERCUSP_CANONICAL_TREE = inheritedCanonicalTree;
});

afterEach(() => {
  nextInner = { ok: true, lock_id: "stub-lock" };
  nextInnerSeq = null;
  rejectCoordinationDomain = false;
  useSse = false;
  emptyAcquireContent = false;
  recoveryQueueInner = null;
  recoveryReleaseInner = null;
  lastRequest = null;
  requests = [];
});

// Async spawn (NOT spawnSync): spawnSync blocks the event loop, so the in-process stub operator
// below could never serve the hook's request — it would always fall through to the 10s timeout +
// fail-open. Async keeps the loop free to respond. ./spawn-hook.ts owns that invariant, plus the
// EPIPE-tolerant stdin write (the hook exits before reading stdin on its guard paths).
async function run(
  input: object,
  extraEnv: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string }> {
  const { status, stdout } = await runHookProcess("bash", [HOOK], {
    input: JSON.stringify(input),
    env: {
      ...process.env,
      HOME: home,
      PAPERCUSP_LOCKS_CACHE_DIR: cache,
      PAPERCUSP_WORKSPACE_ROOT: ws,
      PAPERCUSP_OPERATOR_URL: `http://127.0.0.1:${port}`,
      ...extraEnv,
    },
  });
  return { status, stdout: stdout.trim() };
}

async function runPost(
  input: object,
  extraEnv: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string }> {
  const { status, stdout } = await runHookProcess("bash", [POST_HOOK], {
    input: JSON.stringify(input),
    env: {
      ...process.env,
      HOME: home,
      PAPERCUSP_LOCKS_CACHE_DIR: cache,
      PAPERCUSP_WORKSPACE_ROOT: ws,
      PAPERCUSP_OPERATOR_URL: `http://127.0.0.1:${port}`,
      ...extraEnv,
    },
  });
  return { status, stdout: stdout.trim() };
}

const editOf = (rel: string, toolUseId: string) => ({
  tool_name: "Edit",
  tool_input: { file_path: join(repo, rel) },
  tool_use_id: toolUseId,
  session_id: "s",
  cwd: repo,
});

const nativeBatchInput = (
  transcriptPath: string,
  rel: string,
  toolUseId: string,
) => ({
  ...editOf(rel, toolUseId),
  transcript_path: transcriptPath,
});

describe("cc PreToolUse hook — operator decision rendering (stub operator)", () => {
  it("grant (ok:true) → allow (exit 0, no decision) and CACHES the lock_id for release", async () => {
    nextInner = { ok: true, lock_id: "lock-xyz" };
    const r = await run(editOf("sub/grant.ts", "tu-grant"));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(""); // allow = no decision
    expect(lastRequest?.body.params.arguments.paths).toEqual(["sub/grant.ts"]);
    expect(lastRequest?.body.params.arguments.coordination_domain).toBe(
      fs.realpathSync(repo),
    );
    // The lock_id is cached by tool_use_id so PostToolUse can release it.
    const cached = join(cache, "tu-grant.lock");
    expect(fs.existsSync(cached)).toBe(true);
    expect(fs.readFileSync(cached, "utf8")).toBe("lock-xyz");
    // EI-63: the paths sidecar is ALSO cached, so PostToolUse can scope its
    // release to exactly this edit's path(s) instead of every path under a
    // (possibly REUSED, see su-lock-store.ts same-owner reuse) lock_id.
    const pathsCache = join(cache, "tu-grant.paths");
    expect(fs.existsSync(pathsCache)).toBe(true);
    expect(JSON.parse(fs.readFileSync(pathsCache, "utf8"))).toEqual([
      "sub/grant.ts",
    ]);
    expect(fs.readFileSync(join(cache, "tu-grant.domain"), "utf8")).toBe(
      fs.realpathSync(repo),
    );
  });

  it("Codex multi-file apply_patch → caches and releases every touched path", async () => {
    const toolUseId = "tu-codex-five-paths";
    const paths = [
      "sub/codex-five-1.ts",
      "sub/codex-five-2.ts",
      "sub/codex-five-3.ts",
      "sub/codex-five-4.ts",
      "sub/codex-five-5.ts",
    ];
    for (const path of paths) fs.writeFileSync(join(repo, path), "before\n");
    const patch = [
      "*** Begin Patch",
      ...paths.flatMap((path) => [
        `*** Update File: ${path}`,
        "@@",
        "-before",
        "+after",
      ]),
      "*** End Patch",
    ].join("\n");
    const identity = {
      PAPERCUSP_LOCK_SID: "codex-five-paths-owner",
      PAPERCUSP_SID: "codex-five-paths-owner",
    };
    nextInner = {
      ok: true,
      lock_id: "codex-five-paths-lock",
      newly_held: paths,
    };

    const pre = await run(
      {
        tool_name: "apply_patch",
        tool_input: patch,
        tool_use_id: toolUseId,
        session_id: "codex-session",
        cwd: repo,
      },
      identity,
    );

    expect(pre.status).toBe(0);
    expect(pre.stdout).toBe("");
    expect(requests[0].body.params).toMatchObject({
      name: "locks:acquire",
      arguments: {
        paths,
        coordination_domain: fs.realpathSync(repo),
      },
    });
    expect(fs.readFileSync(join(cache, `${toolUseId}.lock`), "utf8")).toBe(
      "codex-five-paths-lock",
    );
    expect(JSON.parse(fs.readFileSync(join(cache, `${toolUseId}.paths`), "utf8"))).toEqual(
      paths,
    );

    recoveryReleaseInner = { ok: true, released: paths, held_before: paths.length };
    const post = await runPost({
      tool_name: "apply_patch",
      tool_input: patch,
      tool_use_id: toolUseId,
      session_id: "codex-session",
      cwd: repo,
    }, identity);

    expect(post.status).toBe(0);
    expect(requests.map((request) => request.body.params.name)).toEqual([
      "locks:acquire",
      "locks:release",
    ]);
    expect(requests[1].body.params).toMatchObject({
      name: "locks:release",
      arguments: {
        lock_id: "codex-five-paths-lock",
        paths,
        coordination_domain: fs.realpathSync(repo),
      },
    });
    for (const suffix of ["lock", "paths", "owner", "domain"])
      expect(fs.existsSync(join(cache, `${toolUseId}.${suffix}`))).toBe(false);
  });

  it("keeps a managed suite app in the repository-domain namespace", async () => {
    const portal = join(
      home,
      ".papercusp-workspaces",
      "papercusp-workspace",
      ".papercusp",
      "apps",
      "portal",
    );
    const target = join(portal, "packages", "contracts", "src", "index.ts");
    fs.mkdirSync(join(portal, ".git"), { recursive: true });
    fs.writeFileSync(join(portal, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.mkdirSync(dirname(target), { recursive: true });
    fs.writeFileSync(target, "export {};\n");

    nextInner = { ok: true, lock_id: "suite-app-lock" };
    const r = await run({
      tool_name: "Edit",
      tool_input: { file_path: target },
      tool_use_id: "tu-suite-app",
      session_id: "s",
      cwd: portal,
    });

    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(lastRequest?.body.params.arguments).toMatchObject({
      paths: ["packages/contracts/src/index.ts"],
      coordination_domain: fs.realpathSync(portal),
    });
    expect(lastRequest?.body.params.arguments.paths).not.toEqual([
      "@external/home/.papercusp-workspaces/papercusp-workspace/.papercusp/apps/portal/packages/contracts/src/index.ts",
    ]);
    expect(fs.readFileSync(join(cache, "tu-suite-app.domain"), "utf8")).toBe(
      fs.realpathSync(portal),
    );
    const post = await runPost({
      tool_use_id: "tu-suite-app",
      session_id: "s",
    });
    expect(post.status).toBe(0);
    expect(lastRequest?.body.params.name).toBe("locks:release");
    expect(lastRequest?.body.params.arguments).toMatchObject({
      lock_id: "suite-app-lock",
      paths: ["packages/contracts/src/index.ts"],
      coordination_domain: fs.realpathSync(portal),
    });
  });

  it("Claude native two-Edit batch → one union acquire and terminal follower grants", async () => {
    const transcriptPath = join(home, "claude-transcript.jsonl");
    const firstPath = join(repo, "sub/batch-first.ts");
    const secondPath = join(repo, "sub/batch-second.ts");
    fs.writeFileSync(
      transcriptPath,
      `${JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tu-batch-first",
              name: "Edit",
              input: { file_path: firstPath },
            },
            {
              type: "tool_use",
              id: "tu-batch-second",
              name: "Edit",
              input: { file_path: secondPath },
            },
          ],
        },
      })}\n`,
    );

    const env = {
      PAPERCUSP_SID: "batch-test-session",
      PAPERCUSP_LOCK_SID: "batch-test-session",
    };
    const [first, second] = await Promise.all([
      run(
        nativeBatchInput(
          transcriptPath,
          "sub/batch-first.ts",
          "tu-batch-first",
        ),
        env,
      ),
      run(
        nativeBatchInput(
          transcriptPath,
          "sub/batch-second.ts",
          "tu-batch-second",
        ),
        env,
      ),
    ]);

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(first.stdout).toBe("");
    expect(second.stdout).toBe("");

    const acquires = requests.filter(
      (request) => request.body.params.name === "locks:acquire",
    );
    expect(acquires).toHaveLength(1);
    expect(acquires[0].body.params.arguments.paths).toEqual([
      "sub/batch-first.ts",
      "sub/batch-second.ts",
    ]);
    expect(acquires[0].body.params.arguments.coordination_domain).toBe(
      fs.realpathSync(repo),
    );

    expect(fs.existsSync(join(cache, "tu-batch-first.batch"))).toBe(true);
    expect(fs.existsSync(join(cache, "tu-batch-second.batch"))).toBe(true);
    expect(fs.existsSync(join(cache, "tu-batch-first.lock"))).toBe(false);
    expect(fs.existsSync(join(cache, "tu-batch-second.lock"))).toBe(false);

    const stateFile = fs
      .readdirSync(cache)
      .find(
        (name) => name.startsWith("batch-") && name.endsWith(".state.json"),
      );
    expect(stateFile).toBeDefined();
    expect(
      JSON.parse(fs.readFileSync(join(cache, stateFile!), "utf8")),
    ).toMatchObject({
      status: "granted",
      tool_use_ids: ["tu-batch-first", "tu-batch-second"],
      paths: ["sub/batch-first.ts", "sub/batch-second.ts"],
    });
  });

  it("ambiguous acquire response → releases only the fresh automatic lock it can identify", async () => {
    emptyAcquireContent = true;
    recoveryQueueInner = {
      active_locks: [
        {
          lock_id: "orphan-lock",
          path: "sub/ambiguous.ts",
          owner: "$REQUEST_OWNER",
          intent: "PreToolUse:Edit",
          coordination_domain: fs.realpathSync(repo),
          acquired_ts: new Date().toISOString(),
          expires_ts: new Date(Date.now() + 1_200_000).toISOString(),
        },
        {
          lock_id: "deliberate-lock",
          path: "sub/ambiguous.ts",
          owner: "$REQUEST_OWNER",
          intent: "EI-20244912686267355: deliberate hold",
          coordination_domain: fs.realpathSync(repo),
          acquired_ts: new Date().toISOString(),
          expires_ts: new Date(Date.now() + 1_200_000).toISOString(),
        },
        {
          lock_id: "old-automatic-lock",
          path: "sub/ambiguous.ts",
          owner: "$REQUEST_OWNER",
          intent: "PreToolUse:Edit",
          coordination_domain: fs.realpathSync(repo),
          acquired_ts: new Date(Date.now() - 60_000).toISOString(),
          expires_ts: new Date(Date.now() + 1_140_000).toISOString(),
        },
      ],
      waiting: [],
    };
    recoveryReleaseInner = { ok: true, released: ["orphan-lock"] };
    const r = await run(editOf("sub/ambiguous.ts", "tu-ambiguous"), {
      PAPERCUSP_LOCK_SID: "test-owner",
      PAPERCUSP_SID: "test-owner",
    });

    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(requests.map((request) => request.body.params.name)).toEqual([
      "locks:acquire",
      "locks:queue",
      "locks:release",
    ]);
    expect(requests[1].body.params.arguments).toMatchObject({
      owner: "test-owner",
      paths: ["sub/ambiguous.ts"],
    });
    expect(requests[2].body.params.arguments).toMatchObject({
      lock_id: "orphan-lock",
      paths: ["sub/ambiguous.ts"],
      coordination_domain: fs.realpathSync(repo),
    });
    expect(fs.existsSync(join(cache, "tu-ambiguous.lock"))).toBe(false);
  });

  it("stale operator rejects coordination_domain → retries without it and emits a non-blocking advisory", async () => {
    rejectCoordinationDomain = true;
    nextInner = { ok: true, lock_id: "legacy-lock" };
    const r = await run(editOf("sub/legacy-operator.ts", "tu-legacy-operator"));
    expect(r.status).toBe(0);

    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput).toMatchObject({
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
    });
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(
      /compatibility fallback/i,
    );
    expect(out.hookSpecificOutput.additionalContext).toMatch(/version skew/i);
    expect(out.hookSpecificOutput.additionalContext).toMatch(
      /retained file-lock enforcement/i,
    );

    expect(requests).toHaveLength(2);
    expect(requests[0].body.params.arguments.coordination_domain).toBe(
      fs.realpathSync(repo),
    );
    expect(requests[1].body.params.arguments).not.toHaveProperty(
      "coordination_domain",
    );
    expect(
      fs.readFileSync(join(cache, "tu-legacy-operator.lock"), "utf8"),
    ).toBe("legacy-lock");
  });

  it("PostToolUse releases through the same physical domain as PreToolUse", async () => {
    nextInner = { ok: true, lock_id: "domain-lock" };
    const pre = await run(editOf("sub/domain-release.ts", "tu-domain-release"));
    expect(pre.status).toBe(0);
    const post = await runPost({
      tool_use_id: "tu-domain-release",
      session_id: "s",
    });
    expect(post.status).toBe(0);
    expect(lastRequest?.body.params.name).toBe("locks:release");
    expect(lastRequest?.body.params.arguments).toMatchObject({
      lock_id: "domain-lock",
      coordination_domain: fs.realpathSync(repo),
    });
    expect(fs.existsSync(join(cache, "tu-domain-release.domain"))).toBe(false);
  });

  it("PostToolUse falls back to the stable operator when the staging authority refuses connections", async () => {
    const toolUseId = "tu-staging-restart-fallback";
    const lockId = "staging-restart-lock";
    const paths = ["sub/staging-restart.ts"];
    fs.writeFileSync(join(cache, `${toolUseId}.lock`), lockId);
    fs.writeFileSync(join(cache, `${toolUseId}.paths`), JSON.stringify(paths));
    fs.writeFileSync(join(cache, `${toolUseId}.domain`), fs.realpathSync(repo));
    recoveryReleaseInner = { ok: true, released: paths, held_before: 1 };

    const post = await runPost(
      {
        tool_name: "apply_patch",
        tool_input: "",
        tool_use_id: toolUseId,
        session_id: "s",
      },
      {
        PAPERCUSP_OPERATOR_URL: "http://127.0.0.1:1",
        PAPERCUSP_LOCKS_FALLBACK_OPERATOR_URL: `http://127.0.0.1:${port}`,
      },
    );

    expect(post.status).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0].body.params.name).toBe("locks:release");
    expect(requests[0].body.params.arguments).toMatchObject({
      lock_id: lockId,
      paths,
      coordination_domain: fs.realpathSync(repo),
    });
    for (const suffix of ["lock", "paths", "domain"]) {
      expect(fs.existsSync(join(cache, `${toolUseId}.${suffix}`))).toBe(false);
    }
  });

  it("PostToolUse retries a stale release without coordination_domain and cleans sidecars only after confirmation", async () => {
    const toolUseId = "tu-legacy-release";
    const paths = ["sub/legacy-release.ts"];
    fs.writeFileSync(join(cache, `${toolUseId}.lock`), "legacy-release-lock");
    fs.writeFileSync(join(cache, `${toolUseId}.paths`), JSON.stringify(paths));
    fs.writeFileSync(join(cache, `${toolUseId}.domain`), fs.realpathSync(repo));
    rejectCoordinationDomain = true;
    recoveryReleaseInner = { ok: true, released: paths, held_before: 1 };

    const post = await runPost(
      {
        tool_name: "Edit",
        tool_use_id: toolUseId,
        session_id: "s",
        tool_response: { ok: true },
      },
    );

    expect(post.status).toBe(0);
    expect(requests).toHaveLength(2);
    expect(requests[0].body.params.arguments).toMatchObject({
      lock_id: "legacy-release-lock",
      paths,
      coordination_domain: fs.realpathSync(repo),
    });
    expect(requests[1].body.params.arguments).toMatchObject({
      lock_id: "legacy-release-lock",
      paths,
    });
    expect(requests[1].body.params.arguments).not.toHaveProperty(
      "coordination_domain",
    );
    for (const suffix of ["lock", "paths", "domain"]) {
      expect(fs.existsSync(join(cache, `${toolUseId}.${suffix}`))).toBe(false);
    }
    expect(
      JSON.parse(fs.readFileSync(join(cache, "last-success.json"), "utf8")),
    ).toMatchObject({
      mode: "posttooluse-compatibility-fallback",
    });
  });

  it("PostToolUse retains sidecars when the stale-release compatibility retry is unconfirmed", async () => {
    const toolUseId = "tu-legacy-release-unconfirmed";
    const paths = ["sub/legacy-release-unconfirmed.ts"];
    fs.writeFileSync(
      join(cache, `${toolUseId}.lock`),
      "legacy-release-unconfirmed-lock",
    );
    fs.writeFileSync(join(cache, `${toolUseId}.paths`), JSON.stringify(paths));
    fs.writeFileSync(join(cache, `${toolUseId}.domain`), fs.realpathSync(repo));
    rejectCoordinationDomain = true;
    recoveryReleaseInner = { ok: true, released: [], held_before: 1 };

    const post = await runPost({
      tool_name: "Edit",
      tool_use_id: toolUseId,
      session_id: "s",
      tool_response: { ok: true },
    });

    expect(post.status).toBe(0);
    expect(requests).toHaveLength(2);
    expect(requests[1].body.params.arguments).not.toHaveProperty(
      "coordination_domain",
    );
    for (const suffix of ["lock", "paths", "domain"]) {
      expect(fs.existsSync(join(cache, `${toolUseId}.${suffix}`))).toBe(true);
    }
    expect(
      JSON.parse(fs.readFileSync(join(cache, "last-error.json"), "utf8")),
    ).toMatchObject({
      handler: "posttooluse",
      phase: "release",
    });
  });

  it("PostToolUse falls back to the stable operator when the staging authority times out", async () => {
    const toolUseId = "tu-staging-timeout-fallback";
    const lockId = "staging-timeout-lock";
    const paths = ["sub/staging-timeout.ts"];
    fs.writeFileSync(join(cache, `${toolUseId}.lock`), lockId);
    fs.writeFileSync(join(cache, `${toolUseId}.paths`), JSON.stringify(paths));
    fs.writeFileSync(join(cache, `${toolUseId}.domain`), fs.realpathSync(repo));
    recoveryReleaseInner = { ok: true, released: paths, held_before: 1 };

    // Accept the request but never answer it: urllib reaches its 10-second
    // read timeout, matching the production failure that stranded an
    // apply_patch lock even though the stable operator was healthy.
    const stalled = createServer(() => {});
    await new Promise<void>((resolve) =>
      stalled.listen(0, "127.0.0.1", () => resolve()),
    );
    const stalledPort = (stalled.address() as { port: number }).port;
    try {
      const startedAt = Date.now();
      const post = await runPost(
        {
          tool_name: "apply_patch",
          tool_input: "",
          tool_use_id: toolUseId,
          session_id: "s",
        },
        {
          PAPERCUSP_OPERATOR_URL: `http://127.0.0.1:${stalledPort}`,
          PAPERCUSP_LOCKS_FALLBACK_OPERATOR_URL: `http://127.0.0.1:${port}`,
        },
      );

      expect(post.status).toBe(0);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(9_000);
      expect(requests).toHaveLength(1);
      expect(requests[0].body.params.name).toBe("locks:release");
      expect(requests[0].body.params.arguments).toMatchObject({
        lock_id: lockId,
        paths,
        coordination_domain: fs.realpathSync(repo),
      });
      for (const suffix of ["lock", "paths", "domain"]) {
        expect(fs.existsSync(join(cache, `${toolUseId}.${suffix}`))).toBe(
          false,
        );
      }
    } finally {
      stalled.closeAllConnections();
      await new Promise<void>((resolve) => stalled.close(() => resolve()));
    }
  }, 20_000);

  it.each(["exec", "functions.exec"])(
    "failed nested apply_patch is recovered when its %s parent completes",
    async (parentToolName) => {
      const identity = {
        PAPERCUSP_LOCK_SID: "test-parent-owner",
        PAPERCUSP_SID: "test-parent-owner",
      };
      const patch = [
        "*** Begin Patch",
        "*** Update File: sub/failed-nested.ts",
        "@@",
        "-before",
        "+after",
        "*** End Patch",
      ].join("\n");
      nextInner = { ok: true, lock_id: "failed-nested-lock" };
      const pre = await run(
        {
          tool_name: "apply_patch",
          tool_input: patch,
          tool_use_id: "tu-failed-nested",
          session_id: "s",
          cwd: repo,
        },
        identity,
      );
      expect(pre.status).toBe(0);
      expect(fs.existsSync(join(cache, "tu-failed-nested.lock"))).toBe(true);

      recoveryQueueInner = {
        active_locks: [
          {
            lock_id: "failed-nested-lock",
            path: "sub/failed-nested.ts",
            owner: "$REQUEST_OWNER",
          },
        ],
        waiting: [],
      };
      recoveryReleaseInner = {
        ok: true,
        released: ["sub/failed-nested.ts"],
        held_before: 1,
      };
      const parent = await runPost(
        {
          tool_name: parentToolName,
          tool_input: {
            source: `const result = await tools.apply_patch(${JSON.stringify(patch)}); text(result);`,
          },
          tool_use_id: `tu-parent-${parentToolName.replace(/\W/g, "-")}`,
          session_id: "s",
          cwd: repo,
        },
        identity,
      );

      expect(parent.status).toBe(0);
      expect(requests.map((request) => request.body.params.name)).toEqual([
        "locks:acquire",
        "locks:queue",
        "locks:release",
      ]);
      expect(requests[1].body.params.arguments).toEqual({
        owner: "test-parent-owner",
        paths: ["sub/failed-nested.ts"],
      });
      expect(requests[2].body.params.arguments).toMatchObject({
        lock_id: "failed-nested-lock",
        paths: ["sub/failed-nested.ts"],
        coordination_domain: fs.realpathSync(repo),
      });
      for (const suffix of ["lock", "paths", "domain"]) {
        expect(fs.existsSync(join(cache, `tu-failed-nested.${suffix}`))).toBe(
          false,
        );
      }
    },
  );

  it("retains failed-nested sidecars when the parent cannot prove the queue response shape", async () => {
    const identity = {
      PAPERCUSP_LOCK_SID: "test-queue-unknown-owner",
      PAPERCUSP_SID: "test-queue-unknown-owner",
    };
    const patch = [
      "*** Begin Patch",
      "*** Update File: sub/queue-unknown.ts",
      "@@",
      "-before",
      "+after",
      "*** End Patch",
    ].join("\n");
    nextInner = { ok: true, lock_id: "queue-unknown-lock" };
    const pre = await run(
      {
        tool_name: "apply_patch",
        tool_input: patch,
        tool_use_id: "tu-queue-unknown",
        session_id: "s",
        cwd: repo,
      },
      identity,
    );
    expect(pre.status).toBe(0);

    recoveryQueueInner = { ok: true };
    const parent = await runPost(
      {
        tool_name: "functions.exec",
        tool_input: {
          source: `await tools.apply_patch(${JSON.stringify(patch)});`,
        },
        tool_use_id: "tu-parent-queue-unknown",
        session_id: "s",
        cwd: repo,
      },
      identity,
    );

    expect(parent.status).toBe(0);
    expect(requests.map((request) => request.body.params.name)).toEqual([
      "locks:acquire",
      "locks:queue",
    ]);
    for (const suffix of ["lock", "paths", "domain"]) {
      expect(fs.existsSync(join(cache, `tu-queue-unknown.${suffix}`))).toBe(
        true,
      );
    }
    expect(
      JSON.parse(fs.readFileSync(join(cache, "last-error.json"), "utf8")),
    ).toMatchObject({
      handler: "posttooluse",
      phase: "parent-recovery-queue",
      owner: "test-queue-unknown-owner",
    });
  });

  it("retains the release token when an HTTP-200 locks:release verdict is unconfirmed", async () => {
    const identity = {
      PAPERCUSP_LOCK_SID: "test-unconfirmed-owner",
      PAPERCUSP_SID: "test-unconfirmed-owner",
    };
    const patch = [
      "*** Begin Patch",
      "*** Update File: sub/unconfirmed-release.ts",
      "@@",
      "-before",
      "+after",
      "*** End Patch",
    ].join("\n");
    nextInner = { ok: true, lock_id: "unconfirmed-release-lock" };
    const pre = await run(
      {
        tool_name: "apply_patch",
        tool_input: patch,
        tool_use_id: "tu-unconfirmed-release",
        session_id: "s",
        cwd: repo,
      },
      identity,
    );
    expect(pre.status).toBe(0);

    recoveryReleaseInner = { ok: true, released: [], held_before: 1 };
    const post = await runPost(
      {
        tool_name: "apply_patch",
        tool_input: patch,
        tool_use_id: "tu-unconfirmed-release",
        session_id: "s",
        cwd: repo,
      },
      identity,
    );

    expect(post.status).toBe(0);
    expect(requests.map((request) => request.body.params.name)).toEqual([
      "locks:acquire",
      "locks:release",
    ]);
    for (const suffix of ["lock", "paths", "domain"]) {
      expect(
        fs.existsSync(join(cache, `tu-unconfirmed-release.${suffix}`)),
      ).toBe(true);
    }
    expect(
      JSON.parse(fs.readFileSync(join(cache, "last-error.json"), "utf8")),
    ).toMatchObject({
      handler: "posttooluse",
      phase: "release",
      owner: "test-unconfirmed-owner",
    });
  });

  it("already-held grant → allow without caching a PostToolUse release token", async () => {
    // This is the manual locks:acquire → automatic PreToolUse collision:
    // the server reuses the deliberate lock_id but reports no newly-acquired
    // paths, so PostToolUse must not release the deliberate hold.
    nextInner = { ok: true, lock_id: "manual-lock", newly_held: [] };
    const r = await run(editOf("sub/already-held.ts", "tu-already-held"));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(fs.existsSync(join(cache, "tu-already-held.lock"))).toBe(false);
    expect(fs.existsSync(join(cache, "tu-already-held.paths"))).toBe(false);
    const decision = JSON.parse(
      fs.readFileSync(join(cache, "last-decision.json"), "utf8"),
    );
    expect(decision).toMatchObject({
      decision: "already-held",
      release_paths: [],
      lock_id: "manual-lock",
    });
  });

  // WI-10006831: the already-held edit above used to reach no attribution at
  // all (no release token ⇒ no native_edit_proof ⇒ no ledger row). The attest
  // sidecar carries it to a retain:true release that keeps the hold.
  describe("already-held attestation (WI-10006831)", () => {
    const releaseCalls = () =>
      requests.filter((r) => r.body.params?.name === "locks:release");
    const successfulEdit = (rel: string, toolUseId: string) => ({
      ...editOf(rel, toolUseId),
      hook_event_name: "PostToolUse",
      tool_response: { filePath: join(repo, rel), oldString: "a", newString: "b" },
    });

    it("attests a successful edit with retain and proof-only paths, never a release selector", async () => {
      nextInner = { ok: true, lock_id: "manual-lock", newly_held: [] };
      await run(editOf("sub/attest.ts", "tu-attest"));
      expect(
        JSON.parse(fs.readFileSync(join(cache, "tu-attest.attest"), "utf8")),
      ).toMatchObject({ paths: ["sub/attest.ts"], domain: repo });

      requests = [];
      nextInner = {
        ok: true,
        retained: ["sub/attest.ts"],
        released: [],
        attributed: ["sub/attest.ts"],
      };
      const r = await runPost(successfulEdit("sub/attest.ts", "tu-attest"));
      expect(r.status).toBe(0);

      const calls = releaseCalls();
      expect(calls).toHaveLength(1);
      const args = calls[0].body.params.arguments;
      expect(args).toEqual({
        retain: true,
        coordination_domain: repo,
        native_edit_proof: {
          success: true,
          source: "claude",
          tool: "Edit",
          paths: ["sub/attest.ts"],
        },
      });
      // An operator predating `retain` strips it; without these keys it must
      // refuse instead of releasing the deliberate hold.
      expect(args).not.toHaveProperty("paths");
      expect(args).not.toHaveProperty("lock_id");
      expect(fs.existsSync(join(cache, "tu-attest.attest"))).toBe(false);
      expect(
        JSON.parse(fs.readFileSync(join(cache, "last-attest.json"), "utf8")),
      ).toMatchObject({ attributed: true, paths: ["sub/attest.ts"] });
    });

    it("consumes the sidecar without any release call when the edit failed", async () => {
      nextInner = { ok: true, lock_id: "manual-lock", newly_held: [] };
      await run(editOf("sub/attest-fail.ts", "tu-attest-fail"));
      expect(fs.existsSync(join(cache, "tu-attest-fail.attest"))).toBe(true);

      requests = [];
      await runPost({
        ...editOf("sub/attest-fail.ts", "tu-attest-fail"),
        hook_event_name: "PostToolUse",
        tool_response: { is_error: true, content: "old_string not found" },
      });

      expect(releaseCalls()).toHaveLength(0);
      expect(fs.existsSync(join(cache, "tu-attest-fail.attest"))).toBe(false);
    });

    it("records an unconfirmed attestation instead of claiming it", async () => {
      nextInner = { ok: true, lock_id: "manual-lock", newly_held: [] };
      await run(editOf("sub/attest-refused.ts", "tu-attest-refused"));

      nextInner = { ok: false, error: "retain_paths_not_held", not_held: ["sub/attest-refused.ts"] };
      await runPost(successfulEdit("sub/attest-refused.ts", "tu-attest-refused"));

      expect(
        JSON.parse(fs.readFileSync(join(cache, "last-attest.json"), "utf8")),
      ).toMatchObject({ attributed: false });
    });

    it.each([
      ["a fresh grant (the path is released, not attested)", { ok: true, lock_id: "fresh-lock", newly_held: ["sub/attest-fresh.ts"] }],
      ["an operator that does not report newly_held", { ok: true, lock_id: "old-op-lock" }],
    ])("writes no attest sidecar for %s", async (_label, grant) => {
      nextInner = grant;
      await run(editOf("sub/attest-fresh.ts", "tu-attest-fresh"));
      expect(fs.existsSync(join(cache, "tu-attest-fresh.attest"))).toBe(false);
      for (const suffix of [".lock", ".paths", ".domain", ".owner"]) {
        fs.rmSync(join(cache, `tu-attest-fresh${suffix}`), { force: true });
      }
    });
  });

  it("coordinates an absolute HOME config edit through the reserved external lock key", async () => {
    const configFile = join(home, ".config", "mimeapps.list");
    fs.mkdirSync(join(home, ".config"), { recursive: true });
    fs.writeFileSync(configFile, "[Default Applications]\n");
    const r = await run(
      {
        tool_name: "Edit",
        tool_input: { file_path: configFile },
        tool_use_id: "tu-home-config",
        session_id: "codex-session-owner",
        cwd: home,
      },
      // Mirrors the generated Codex hook command: the per-session owner is
      // baked because the inherited Codex hook environment can be stale.
      {
        PAPERCUSP_LOCK_SID: "codex-session-owner",
        PAPERCUSP_SID: "codex-session-owner",
      },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(lastRequest?.body.params.arguments.paths).toEqual([
      "@external/home/.config/mimeapps.list",
    ]);
    expect(lastRequest?.url).toContain("client=codex-session-owner");
    expect(fs.existsSync(join(cache, "tu-home-config.lock"))).toBe(true);
    const decision = JSON.parse(
      fs.readFileSync(join(cache, "last-decision.json"), "utf8"),
    );
    expect(decision).toMatchObject({
      decision: "granted",
      owner: "codex-session-owner",
      paths: ["@external/home/.config/mimeapps.list"],
    });
  });

  it("coordinates an XDG_RUNTIME_DIR credential edit through the reserved runtime lock key", async () => {
    const runtimeDir = join(home, "runtime");
    const stateFile = join(
      runtimeDir,
      "papercusp-p029-acceptance.9aTT9e",
      "storage-state.json",
    );
    fs.mkdirSync(dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, "{}\n");
    const r = await run(
      {
        tool_name: "Edit",
        tool_input: { file_path: stateFile },
        tool_use_id: "tu-runtime-credential",
        session_id: "codex-session-owner",
        cwd: home,
      },
      {
        PAPERCUSP_LOCK_SID: "codex-session-owner",
        PAPERCUSP_SID: "codex-session-owner",
        XDG_RUNTIME_DIR: runtimeDir,
      },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(lastRequest?.body.params.arguments.paths).toEqual([
      "@external/runtime/papercusp-p029-acceptance.9aTT9e/storage-state.json",
    ]);
    expect(fs.existsSync(join(cache, "tu-runtime-credential.lock"))).toBe(true);
    const decision = JSON.parse(
      fs.readFileSync(join(cache, "last-decision.json"), "utf8"),
    );
    expect(decision).toMatchObject({
      decision: "granted",
      owner: "codex-session-owner",
      paths: [
        "@external/runtime/papercusp-p029-acceptance.9aTT9e/storage-state.json",
      ],
    });
  });

  it("block-on-held (busy) → permissionDecision:deny carrying the holder + intent", async () => {
    nextInner = {
      ok: false,
      busy: [
        {
          path: "sub/held.ts",
          owner: "su-peer",
          owner_label: "su · peer",
          intent: "PreToolUse:Edit",
          holder_intent: "refactoring the auth module",
          holder_focused: true,
          expires_ts: "2026-06-08T23:59:00Z",
        },
      ],
    };
    const r = await run(editOf("sub/held.ts", "tu-busy"));
    expect(r.status).toBe(0); // deny path emits JSON then exits 0
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    const reason: string = out.hookSpecificOutput.permissionDecisionReason;
    // The reason the MODEL sees names the file, the holder, and (preferentially)
    // the holder's DECLARED coord intent, plus the focused marker + wake guidance.
    expect(reason).toContain("sub/held.ts");
    expect(reason).toContain("su · peer");
    expect(reason).toContain("refactoring the auth module");
    expect(reason).toContain("[focused on this file]");
    expect(reason).toContain("wake_on_grant");
    expect(reason).toContain('tools:invoke {name:"locks:acquire"');
    expect(reason).toContain('paths:["sub/held.ts"]');
    // A deny must NOT have cached any lock (nothing to release).
    expect(fs.existsSync(join(cache, "tu-busy.lock"))).toBe(false);
  });

  it("server refusal with a `reason` (e.g. policy) → deny carrying that reason", async () => {
    nextInner = { ok: false, reason: "path is on the protected list" };
    const r = await run(editOf("sub/refused.ts", "tu-reason"));
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain(
      "path is on the protected list",
    );
  });

  it("text/event-stream framed grant is parsed → allow + cache (transport robustness)", async () => {
    useSse = true;
    nextInner = { ok: true, lock_id: "sse-lock" };
    const r = await run(editOf("sub/sse.ts", "tu-sse"));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(fs.readFileSync(join(cache, "tu-sse.lock"), "utf8")).toBe(
      "sse-lock",
    );
  });

  it("text/event-stream framed busy is parsed → deny (transport robustness)", async () => {
    useSse = true;
    nextInner = {
      ok: false,
      busy: [{ path: "sub/sse2.ts", owner: "su-peer2", expires_ts: "soon" }],
    };
    const r = await run(editOf("sub/sse2.ts", "tu-sse2"));
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe(
      "deny",
    );
  });

  it("worktree guard: refuses an edit in a stray sibling worktree, BEFORE any acquire", async () => {
    // A sibling worktree under the workspace root that is NOT the canonical
    // staging tree (papercusp) — e.g. the detached papercup-staging that
    // stranded a feature on 2026-06-30. The guard must deny locally, before
    // ever reaching the operator, with a reason the model can act on.
    const stray = join(ws, "papercup-staging");
    fs.mkdirSync(join(stray, "sub"), { recursive: true });
    fs.writeFileSync(join(stray, ".git"), "gitdir: /nonexistent\n");
    nextInner = { ok: true, lock_id: "should-not-be-acquired" }; // operator would grant…
    const r = await run({
      tool_name: "Edit",
      tool_input: { file_path: join(stray, "sub/x.ts") },
      tool_use_id: "tu-stray",
      session_id: "s",
      cwd: stray,
    });
    expect(r.status).toBe(0); // deny emits JSON then exits 0
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain(
      "worktree guard",
    );
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain(
      "canonical staging tree",
    );
    // …but the guard fired first, so no lock was acquired/cached.
    expect(fs.existsSync(join(cache, "tu-stray.lock"))).toBe(false);
  });

  it("worktree guard: ALLOWS an edit in a .papercusp/worktrees isolation tree", async () => {
    // Migration/synthesis roles get their own isolation worktree under
    // <canonical>/.papercusp/worktrees/<name>. Its parent is NOT the workspace
    // root (it's deep inside the canonical tree), so it is not a stray sibling —
    // the guard must let it through. This is the documented exception in
    // pretooluse-locks-acquire.sh; guarding it would break those roles.
    const iso = join(repo, ".papercusp", "worktrees", "iso-1");
    fs.mkdirSync(join(iso, "sub"), { recursive: true });
    fs.writeFileSync(join(iso, ".git"), "gitdir: /nonexistent\n");
    const r = await run({
      tool_name: "Edit",
      tool_input: { file_path: join(iso, "sub/x.ts") },
      tool_use_id: "tu-iso",
      session_id: "s",
      cwd: iso,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(""); // allow = no decision
    // Isolation trees have a non-workspace-root parent, so they're not
    // coordinated — the guard passes them through without acquiring a lock.
    expect(fs.existsSync(join(cache, "tu-iso.lock"))).toBe(false);
  });

  it("worktree guard (EI-8820): refuses an edit in a LINKED WORKTREE of the canonical tree registered ANYWHERE on disk", async () => {
    // Reproduces the live strand: a per-workspace ephemeral checkout
    // (`~/.papercusp-workspaces/<ws>/.papercusp/env-trees/<name>`) is a
    // linked worktree of the canonical tree, but its parent dir is NEITHER
    // the workspace root NOR inside the canonical tree — so the old
    // sibling-of-workspace-root check missed it entirely and it fell
    // through as an unrelated "foreign" repo (silently allowed, never
    // git-sync committed). Simulate the linked-worktree structure via the
    // gitdir/commondir pointer files git itself uses — no real `git
    // worktree add` needed.
    const wtGitDir = join(ws, "sim-git-worktrees", "staging");
    fs.mkdirSync(wtGitDir, { recursive: true });
    // commondir points back at the canonical tree's `.git` — the same
    // pointer `git worktree add` writes for a real linked worktree.
    fs.writeFileSync(join(wtGitDir, "commondir"), `${join(repo, ".git")}\n`);

    const elsewhere = join(
      ws,
      "unrelated-parent",
      ".papercusp",
      "env-trees",
      "staging",
    );
    fs.mkdirSync(join(elsewhere, "sub"), { recursive: true });
    fs.writeFileSync(join(elsewhere, ".git"), `gitdir: ${wtGitDir}\n`);

    nextInner = { ok: true, lock_id: "should-not-be-acquired" }; // operator would grant…
    const r = await run({
      tool_name: "Edit",
      tool_input: { file_path: join(elsewhere, "sub/x.ts") },
      tool_use_id: "tu-linked-elsewhere",
      session_id: "s",
      cwd: elsewhere,
    });
    expect(r.status).toBe(0); // deny emits JSON then exits 0
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain(
      "worktree guard",
    );
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain(
      "LINKED WORKTREE",
    );
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain(
      "canonical staging tree",
    );
    // …but the guard fired first, so no lock was acquired/cached.
    expect(fs.existsSync(join(cache, "tu-linked-elsewhere.lock"))).toBe(false);
  });

  it("worktree guard (WI-5031): same-origin sibling still refused; INDEPENDENT sibling repo allowed", async () => {
    // papercup-rust-mobile is a standalone project (own .git dir, own remote,
    // own commit discipline) that happens to live as a direct child of the
    // workspace root. The guard exists to catch stray checkouts OF THE
    // CANONICAL project — an independent repo must fall through to normal
    // lock coordination, not be refused (refusing it parked the whole mobile
    // release campaign as needs-human). Identity = the origin remote URL:
    // provably different ⇒ allow; same (any ssh/https spelling) or
    // unreadable ⇒ refuse as before.
    const gitBack = fs.readFileSync(join(repo, ".git"), "utf8");
    fs.rmSync(join(repo, ".git"));
    try {
      // Give the canonical tree a READABLE origin (an ordinary .git dir).
      fs.mkdirSync(join(repo, ".git"));
      fs.writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/staging\n");
      fs.writeFileSync(
        join(repo, ".git", "config"),
        '[remote "origin"]\n\turl = git@github.com:Papercusp/papercup.git\n',
      );

      // A same-project sibling (papercup-release: SAME origin, https
      // spelling) is still refused — the actual stranding hazard.
      const release = join(ws, "papercup-release");
      fs.mkdirSync(join(release, "sub"), { recursive: true });
      fs.mkdirSync(join(release, ".git"));
      fs.writeFileSync(join(release, ".git", "HEAD"), "ref: refs/heads/main\n");
      fs.writeFileSync(
        join(release, ".git", "config"),
        '[remote "origin"]\n\turl = https://github.com/Papercusp/papercup.git\n',
      );
      const denied = await run({
        tool_name: "Edit",
        tool_input: { file_path: join(release, "sub/x.ts") },
        tool_use_id: "tu-same-origin",
        session_id: "s",
        cwd: release,
      });
      expect(denied.status).toBe(0);
      const deniedOut = JSON.parse(denied.stdout);
      expect(deniedOut.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(deniedOut.hookSpecificOutput.permissionDecisionReason).toContain(
        "worktree guard",
      );
      expect(fs.existsSync(join(cache, "tu-same-origin.lock"))).toBe(false);

      // An INDEPENDENT sibling (provably different origin) is allowed and
      // coordinates through the normal lock flow (grant → cached lock_id).
      const mobile = join(ws, "papercup-rust-mobile");
      fs.mkdirSync(join(mobile, "sub"), { recursive: true });
      fs.mkdirSync(join(mobile, ".git"));
      fs.writeFileSync(
        join(mobile, ".git", "HEAD"),
        "ref: refs/heads/master\n",
      );
      fs.writeFileSync(
        join(mobile, ".git", "config"),
        '[remote "origin"]\n\turl = https://github.com/Papercusp/papercup-rust-mobile.git\n',
      );
      nextInner = { ok: true, lock_id: "mobile-lock" };
      const allowed = await run({
        tool_name: "Edit",
        tool_input: { file_path: join(mobile, "sub/x.ts") },
        tool_use_id: "tu-independent",
        session_id: "s",
        cwd: mobile,
      });
      expect(allowed.status).toBe(0);
      expect(allowed.stdout).toBe(""); // allow = no decision
      expect(fs.readFileSync(join(cache, "tu-independent.lock"), "utf8")).toBe(
        "mobile-lock",
      );
    } finally {
      fs.rmSync(join(repo, ".git"), { recursive: true, force: true });
      fs.writeFileSync(join(repo, ".git"), gitBack);
      fs.rmSync(join(ws, "papercup-release"), { recursive: true, force: true });
      fs.rmSync(join(ws, "papercup-rust-mobile"), {
        recursive: true,
        force: true,
      });
    }
  });

  it("EI-18826235967595309: a SYMLINKED ALIAS of the canonical tree is editable and keys identically; an alias of a same-origin sibling is still refused", async () => {
    // `<ws>/papercup -> papercusp` is a REAL shape in this workspace: the alias
    // survives the papercup→papercusp rename and is still referenced by path
    // (CLAUDE.md's `papercup/papercusp-desktop`), so agents and scripts DO edit
    // through it. Editing through the alias IS editing the canonical tree, so it
    // must be allowed — and the guard gets that right only because it compares
    // `os.path.realpath(root)` against the canonical tree. Nothing pinned it.
    //
    // This was filed as a major "the guard has a hole" bug before the symlink was
    // noticed: probing the alias reads the canonical tree's OWN `.git`, so it
    // presents as a same-project checkout with a matching origin, i.e. exactly
    // the shape the guard is supposed to refuse — and it was observed to allow a
    // live edit. The allow is correct; the premise was wrong.
    //
    // Both directions are asserted because they fail in OPPOSITE ways:
    //   • alias→canonical wrongly DENIED — every edit through `papercup/` starts
    //     refusing. The obvious regression, but note the guard is fail-open on
    //     its own exceptions, so a broken realpath comparison can also surface as
    //     an allow that is right by accident.
    //   • alias→non-canonical wrongly ALLOWED — a symlink LAUNDERS a stranding
    //     hazard past the guard. That is the silent data-loss this guard exists
    //     to prevent, and a symlink is the one shape that can smuggle it through
    //     the same realpath normalization that makes the first case correct.
    const gitBack = fs.readFileSync(join(repo, ".git"), "utf8");
    fs.rmSync(join(repo, ".git"));
    try {
      // Canonical tree with a READABLE origin, so the same-origin comparison in
      // the second half is decided by origin rather than by an unreadable config.
      fs.mkdirSync(join(repo, ".git"));
      fs.writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/staging\n");
      fs.writeFileSync(
        join(repo, ".git", "config"),
        '[remote "origin"]\n\turl = git@github.com:Papercusp/papercup.git\n',
      );

      // (a) alias → canonical: allowed, and keyed IDENTICALLY to a direct edit.
      // The key assertion is not decoration: if the alias produced a different
      // repo-relative key, two agents editing the same logical file — one via
      // `papercusp/`, one via `papercup/` — would take non-colliding locks and
      // clobber each other, silently, with the lock system reporting success.
      fs.symlinkSync("papercusp", join(ws, "papercup"));
      nextInner = { ok: true, lock_id: "alias-lock" };
      const viaAlias = await run({
        tool_name: "Edit",
        tool_input: { file_path: join(ws, "papercup", "sub/aliased.ts") },
        tool_use_id: "tu-alias-canonical",
        session_id: "s",
        cwd: join(ws, "papercup"),
      });
      expect(viaAlias.status).toBe(0);
      expect(viaAlias.stdout).toBe(""); // allow = no decision emitted
      expect(lastRequest?.body.params.arguments.paths).toEqual([
        "sub/aliased.ts",
      ]);
      expect(
        fs.readFileSync(join(cache, "tu-alias-canonical.lock"), "utf8"),
      ).toBe("alias-lock");

      // (b) alias → same-origin sibling: still refused. The symlink must not
      // launder the stranding hazard; work left in papercup-release is never
      // committed by git-sync no matter which name it was reached through.
      const release = join(ws, "papercup-release");
      fs.mkdirSync(join(release, "sub"), { recursive: true });
      fs.mkdirSync(join(release, ".git"));
      fs.writeFileSync(join(release, ".git", "HEAD"), "ref: refs/heads/main\n");
      fs.writeFileSync(
        join(release, ".git", "config"),
        '[remote "origin"]\n\turl = https://github.com/Papercusp/papercup.git\n',
      );
      fs.symlinkSync("papercup-release", join(ws, "papercup-rel-alias"));
      const viaHazardAlias = await run({
        tool_name: "Edit",
        tool_input: { file_path: join(ws, "papercup-rel-alias", "sub/x.ts") },
        tool_use_id: "tu-alias-hazard",
        session_id: "s",
        cwd: join(ws, "papercup-rel-alias"),
      });
      expect(viaHazardAlias.status).toBe(0);
      const out = JSON.parse(viaHazardAlias.stdout);
      expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(out.hookSpecificOutput.permissionDecisionReason).toContain(
        "worktree guard",
      );
      expect(fs.existsSync(join(cache, "tu-alias-hazard.lock"))).toBe(false);
    } finally {
      fs.rmSync(join(repo, ".git"), { recursive: true, force: true });
      fs.writeFileSync(join(repo, ".git"), gitBack);
      fs.rmSync(join(ws, "papercup"), { recursive: true, force: true });
      fs.rmSync(join(ws, "papercup-rel-alias"), {
        recursive: true,
        force: true,
      });
      fs.rmSync(join(ws, "papercup-release"), { recursive: true, force: true });
    }
  });

  it("EI-18826235967595309: a sibling cloned from the canonical tree by LOCAL PATH is refused, while a local-path clone of an UNRELATED repo stays allowed", async () => {
    // The real hole behind that filing. WI-5031 proves independence by comparing
    // normalized origin URLs, which assumes every checkout of the canonical
    // project was cloned from the same forge URL. `git clone ../papercup runner`
    // records origin=/abs/path — never equal to github.com/papercusp/papercup —
    // so the sibling earned independence from a string difference and its edits
    // were ALLOWED. git-sync commits only the canonical tree, so that work
    // silently strands: exactly the data loss this guard exists to prevent.
    //
    // Found live as `papercup-improvement-runner` (origin `<ws>/papercup`, itself
    // a symlink to `<ws>/papercusp`), a full checkout of the canonical project
    // sharing its history and holding 22 uncommitted files.
    //
    // The second half is the load-bearing half: the fix must catch a local-path
    // origin that points AT the canonical project WITHOUT re-refusing every
    // local-path origin. Refusing those wholesale would re-break the independent
    // siblings WI-5031 and EI-18825797177551487 were each written to un-break.
    const gitBack = fs.readFileSync(join(repo, ".git"), "utf8");
    fs.rmSync(join(repo, ".git"));
    try {
      fs.mkdirSync(join(repo, ".git"));
      fs.writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/staging\n");
      fs.writeFileSync(
        join(repo, ".git", "config"),
        '[remote "origin"]\n\turl = https://github.com/Papercusp/papercup.git\n',
      );
      // The alias the live origin actually points through, so the fix is exercised
      // against the indirection it has to survive rather than a direct path.
      fs.symlinkSync("papercusp", join(ws, "papercup"));

      // (a) origin = a local path resolving to the canonical tree ⇒ REFUSED.
      const runner = join(ws, "papercup-improvement-runner");
      fs.mkdirSync(join(runner, "sub"), { recursive: true });
      fs.mkdirSync(join(runner, ".git"));
      fs.writeFileSync(
        join(runner, ".git", "HEAD"),
        "ref: refs/heads/master\n",
      );
      fs.writeFileSync(
        join(runner, ".git", "config"),
        `[remote "origin"]\n\turl = ${join(ws, "papercup")}\n`,
      );
      const denied = await run({
        tool_name: "Edit",
        tool_input: { file_path: join(runner, "sub/x.ts") },
        tool_use_id: "tu-local-path-origin",
        session_id: "s",
        cwd: runner,
      });
      expect(denied.status).toBe(0);
      const deniedOut = JSON.parse(denied.stdout);
      expect(deniedOut.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(deniedOut.hookSpecificOutput.permissionDecisionReason).toContain(
        "worktree guard",
      );
      expect(fs.existsSync(join(cache, "tu-local-path-origin.lock"))).toBe(
        false,
      );

      // (b) origin = a local path resolving to an UNRELATED repo ⇒ still ALLOWED.
      const upstream = join(ws, "some-vendor-upstream");
      fs.mkdirSync(join(upstream, ".git"), { recursive: true });
      fs.writeFileSync(
        join(upstream, ".git", "HEAD"),
        "ref: refs/heads/main\n",
      );
      fs.writeFileSync(
        join(upstream, ".git", "config"),
        '[remote "origin"]\n\turl = https://github.com/someone/vendor-lib.git\n',
      );
      const fork = join(ws, "vendor-lib-fork");
      fs.mkdirSync(join(fork, "sub"), { recursive: true });
      fs.mkdirSync(join(fork, ".git"));
      fs.writeFileSync(join(fork, ".git", "HEAD"), "ref: refs/heads/main\n");
      fs.writeFileSync(
        join(fork, ".git", "config"),
        `[remote "origin"]\n\turl = ${upstream}\n`,
      );
      nextInner = { ok: true, lock_id: "fork-lock" };
      const allowed = await run({
        tool_name: "Edit",
        tool_input: { file_path: join(fork, "sub/x.ts") },
        tool_use_id: "tu-local-path-unrelated",
        session_id: "s",
        cwd: fork,
      });
      expect(allowed.status).toBe(0);
      expect(allowed.stdout).toBe("");
      expect(
        fs.readFileSync(join(cache, "tu-local-path-unrelated.lock"), "utf8"),
      ).toBe("fork-lock");
    } finally {
      fs.rmSync(join(repo, ".git"), { recursive: true, force: true });
      fs.writeFileSync(join(repo, ".git"), gitBack);
      for (const d of [
        "papercup",
        "papercup-improvement-runner",
        "some-vendor-upstream",
        "vendor-lib-fork",
      ]) {
        fs.rmSync(join(ws, d), { recursive: true, force: true });
      }
    }
  });

  // ── EI-9478: transient workspace-contention must never be rendered as a foreign hold ──
  // The server's advisory-lock wait can time out without identifying a holder.
  // That is a TRANSIENT serialization miss with UNKNOWN holder identity. Before the fix, acquire.ts
  // returned a bare busy:[], which this hook printed under a "file(s) held by
  // another agent:" header with zero holders — a fabricated attribution that
  // could strand a half-applied multi-edit batch. The hook must instead retry
  // briefly, then (if still contended) deny with plain retry guidance.

  it('EI-9478: workspace_contended (transient) → RETRIES then denies HONESTLY (never "held by another agent", never wake_on_grant)', async () => {
    nextInner = {
      ok: false,
      reason: "workspace_contended",
      transient: true,
      busy: [],
    };
    const r = await run(editOf("sub/contended.ts", "tu-contended"));
    expect(r.status).toBe(0); // deny emits JSON then exits 0
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    const reason: string = out.hookSpecificOutput.permissionDecisionReason;
    expect(reason).toMatch(/transient contention/i);
    expect(reason).toMatch(/RETRY this same edit/i);
    expect(reason).toMatch(/do NOT queue wake_on_grant/i);
    expect(reason).toMatch(/holder identity is unknown/i);
    expect(reason).not.toMatch(/starved|PG pool|NO other agent holds/i);
    // The fabricated-holder wording must NOT appear for a zero-holder condition.
    expect(reason).not.toContain("held by another agent");
    // Nothing was granted, so nothing is cached to release.
    expect(fs.existsSync(join(cache, "tu-contended.lock"))).toBe(false);
  });

  it("EI-9478: transient on attempt 1 but ok on the retry → allow + cache (self-heals a parallel-edit race)", async () => {
    // First operator call reports contention; the retry succeeds. The hook must
    // ride the retry to a grant, not deny.
    nextInnerSeq = [
      { ok: false, reason: "workspace_contended", transient: true, busy: [] },
      { ok: true, lock_id: "healed-lock" },
    ];
    const r = await run(editOf("sub/healed.ts", "tu-healed"));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(""); // allow = no decision
    expect(fs.readFileSync(join(cache, "tu-healed.lock"), "utf8")).toBe(
      "healed-lock",
    );
  });

  it('result-door spill containing a successful grant → allow + cache the lock, without transient retries', async () => {
    const scratchRoot = join(home, '.papercusp', 'scratch');
    const relative = ['papercusp-workspace', 'locks:acquire', 'hook-test', 'result.spill'];
    const spillPath = join(scratchRoot, ...relative);
    const grant = { ok: true, lock_id: 'spilled-hook-lock', newly_held: ['sub/spilled.ts'] };
    fs.mkdirSync(dirname(spillPath), { recursive: true });
    fs.writeFileSync(spillPath, `result-door magic\nmanifest\n${JSON.stringify({
      content: [
        { type: 'text', text: 'See also: locks:release' },
        { type: 'text', text: JSON.stringify(grant) },
      ],
    })}\n`);
    nextInner = {
      schemaVersion: 'papercusp.output-envelope/v1',
      content: [{
        kind: 'reference',
        uri: `papercusp://scratch/${relative.join('/')}`,
        preview: '{"ok":false,"reason":"preview is not authoritative"}',
      }],
    };

    const r = await run(editOf('sub/spilled.ts', 'tu-spilled'), {
      PAPERCUSP_SCRATCH_ROOT: scratchRoot,
    });

    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(requests.filter((request) => request.body.params?.name === 'locks:acquire')).toHaveLength(1);
    expect(fs.readFileSync(join(cache, 'tu-spilled.lock'), 'utf8')).toBe('spilled-hook-lock');
    expect(JSON.parse(fs.readFileSync(join(cache, 'tu-spilled.paths'), 'utf8'))).toEqual([
      'sub/spilled.ts',
    ]);
  });

  it("EI-9478: legacy ok:false with NO reason and an EMPTY busy list is treated as transient (retry+deny), never a foreign hold", async () => {
    // Older servers surfaced the same advisory-lock timeout as a bare empty-busy
    // refusal. The hook must classify that shape as transient too — otherwise the
    // "file(s) held by another agent" header renders with ZERO holders.
    nextInner = { ok: false, busy: [] };
    const r = await run(editOf("sub/legacy.ts", "tu-legacy"));
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    const reason: string = out.hookSpecificOutput.permissionDecisionReason;
    expect(reason).toMatch(/transient contention/i);
    expect(reason).not.toContain("held by another agent");
    expect(fs.existsSync(join(cache, "tu-legacy.lock"))).toBe(false);
  });
});

// ── EI-19324697909459657: "Simply RETRY" is wrong advice once retrying has ──
// already demonstrably failed repeatedly for one owner. A one-off race with
// your own parallel edit self-heals in 1-2 attempts (see the 'heals on retry'
// test above); a run of CONSECUTIVE transient denials for the SAME owner must
// stop telling the agent to blindly retry. The only verified fact is that the
// advisory timeout still did not identify a holder.
describe("EI-19324697909459657: persistent-transient escalation", () => {
  beforeAll(() => {
    // Every test in the OUTER describe above shares owner 's' (editOf's fixed
    // session_id) and this same cache dir — several of them go through the
    // transient-denial path, leaving a streak marker behind. Start this block
    // from a clean streak regardless of what ran before it.
    for (const f of fs.readdirSync(cache)) {
      if (f.includes("transient-streak")) fs.rmSync(join(cache, f));
    }
  });

  afterEach(() => {
    for (const f of fs.readdirSync(cache)) {
      if (f.includes("transient-streak")) fs.rmSync(join(cache, f));
    }
  });

  it('attempts 1-2 still use the plain "Simply RETRY" wording; attempt 3 escalates with the streak count and preserves unknown-holder semantics', async () => {
    nextInner = {
      ok: false,
      reason: "workspace_contended",
      transient: true,
      busy: [],
    };

    for (const id of ["tu-streak-1", "tu-streak-2"]) {
      const r = await run(editOf("sub/streak.ts", id));
      expect(r.status).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(
        /Simply RETRY this same edit/i,
      );
    }

    const r3 = await run(editOf("sub/streak.ts", "tu-streak-3"));
    expect(r3.status).toBe(0);
    const out3 = JSON.parse(r3.stdout);
    const reason: string = out3.hookSpecificOutput.permissionDecisionReason;
    expect(reason).toMatch(/PERSISTENT transient contention/i);
    expect(reason).toMatch(/attempt #3/i);
    expect(reason).not.toMatch(/Simply RETRY this same edit/i);
    expect(reason).toMatch(/holder.*unknown/i);
    expect(reason).not.toMatch(/starved|PG health|saturated|pivot to non-DB/i);
    expect(reason).toMatch(/do NOT queue wake_on_grant/i);
    expect(fs.existsSync(join(cache, "tu-streak-3.lock"))).toBe(false);
  });

  it("does not make an unrelated PG-health claim when escalating an unknown-holder timeout", async () => {
    nextInner = {
      ok: false,
      reason: "workspace_contended",
      transient: true,
      busy: [],
    };

    for (const id of ["tu-streak-neutral-1", "tu-streak-neutral-2"]) {
      await run(editOf("sub/streak-neutral.ts", id));
    }
    const r3 = await run(
      editOf("sub/streak-neutral.ts", "tu-streak-neutral-3"),
    );
    const out3 = JSON.parse(r3.stdout);
    const reason: string = out3.hookSpecificOutput.permissionDecisionReason;
    expect(reason).toMatch(/PERSISTENT transient contention/i);
    expect(reason).toMatch(/holder.*unknown/i);
    expect(reason).not.toMatch(/PG health|starved|saturated/i);
  });

  it("a grant resets the streak — a later transient run starts back at the base wording", async () => {
    nextInner = {
      ok: false,
      reason: "workspace_contended",
      transient: true,
      busy: [],
    };
    for (const id of ["tu-streak-reset-1", "tu-streak-reset-2"]) {
      await run(editOf("sub/streak-reset.ts", id));
    }
    nextInner = { ok: true, lock_id: "reset-lock" };
    const rGrant = await run(
      editOf("sub/streak-reset.ts", "tu-streak-reset-grant"),
    );
    expect(rGrant.stdout).toBe("");

    nextInner = {
      ok: false,
      reason: "workspace_contended",
      transient: true,
      busy: [],
    };
    const r = await run(editOf("sub/streak-reset.ts", "tu-streak-reset-3"));
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(
      /Simply RETRY this same edit/i,
    );
    expect(out.hookSpecificOutput.permissionDecisionReason).not.toMatch(
      /PERSISTENT transient contention/i,
    );
  });
});

// WI-10006390: every lock entry is relative to its OWN repository, and one
// locks:acquire names one coordination_domain. The hook used to send a
// cross-repository path set with NO domain, so the server filed a submodule
// file such as libs/papercusp/libs/db/sql/X under the superproject as
// 'libs/db/sql/X' — a key that never conflicts with a peer's real lock on it.
describe("WI-10006390: cross-repository edits never lock under the wrong domain", () => {
  const SUB_REL = "libs/wi390-sub";
  let sub: string;
  const acquiresOf = () =>
    requests.filter((request) => request.body.params.name === "locks:acquire");
  const patchOf = (paths: string[]) =>
    [
      "*** Begin Patch",
      ...paths.flatMap((path) => [`*** Update File: ${path}`, "@@", "-before", "+after"]),
      "*** End Patch",
    ].join("\n");

  beforeAll(() => {
    sub = join(repo, SUB_REL);
    fs.mkdirSync(join(sub, "sql"), { recursive: true });
    // A submodule's .git is a gitlink FILE, exactly like the fixture superproject's.
    fs.writeFileSync(join(sub, ".git"), "gitdir: /nonexistent-wi390-sub\n");
    for (const rel of ["sql/x.sql", "sql/y.sql"])
      fs.writeFileSync(join(sub, rel), "before\n");
    for (const rel of ["sub/wi390-top.ts", "sub/wi390-batch-top.ts"])
      fs.writeFileSync(join(repo, rel), "before\n");
  });

  it("positive control: a submodule-only Codex patch locks submodule-relative paths in the submodule domain", async () => {
    nextInner = { ok: true, lock_id: "wi390-sub-lock", newly_held: ["sql/x.sql"] };
    const pre = await run(
      {
        tool_name: "apply_patch",
        tool_input: patchOf([`${SUB_REL}/sql/x.sql`]),
        tool_use_id: "tu-wi390-sub-only",
        session_id: "codex-session",
        cwd: repo,
      },
      { PAPERCUSP_LOCK_SID: "wi390-owner", PAPERCUSP_SID: "wi390-owner" },
    );
    expect(pre.status).toBe(0);
    expect(pre.stdout).toBe("");
    const acquires = acquiresOf();
    expect(acquires).toHaveLength(1);
    expect(acquires[0].body.params.arguments.paths).toEqual(["sql/x.sql"]);
    expect(acquires[0].body.params.arguments.coordination_domain).toBe(
      fs.realpathSync(sub),
    );
  });

  it("a Codex patch spanning the superproject and a submodule is refused before any acquire", async () => {
    const pre = await run(
      {
        tool_name: "apply_patch",
        tool_input: patchOf([`${SUB_REL}/sql/x.sql`, "sub/wi390-top.ts"]),
        tool_use_id: "tu-wi390-cross",
        session_id: "codex-session",
        cwd: repo,
      },
      { PAPERCUSP_LOCK_SID: "wi390-owner", PAPERCUSP_SID: "wi390-owner" },
    );
    expect(pre.status).toBe(0); // deny path emits JSON then exits 0
    const out = JSON.parse(pre.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    const reason: string = out.hookSpecificOutput.permissionDecisionReason;
    expect(reason).toContain("2 repositories");
    expect(reason).toContain(`${fs.realpathSync(sub)} -> sql/x.sql`);
    expect(reason).toContain(`${fs.realpathSync(repo)} -> sub/wi390-top.ts`);
    expect(reason).toContain("one apply_patch per repository");
    // The defect was a GRANTED lock under the wrong keys; nothing may be acquired.
    expect(acquiresOf()).toHaveLength(0);
    expect(fs.existsSync(join(cache, "tu-wi390-cross.lock"))).toBe(false);
  });

  it("a Claude native batch spanning two repositories locks each call in its own domain", async () => {
    const transcriptPath = join(home, "wi390-transcript.jsonl");
    const subFile = join(sub, "sql/y.sql");
    const topFile = join(repo, "sub/wi390-batch-top.ts");
    fs.writeFileSync(
      transcriptPath,
      `${JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tu-wi390-b-sub", name: "Edit", input: { file_path: subFile } },
            { type: "tool_use", id: "tu-wi390-b-top", name: "Edit", input: { file_path: topFile } },
          ],
        },
      })}\n`,
    );
    const env = { PAPERCUSP_SID: "wi390-batch", PAPERCUSP_LOCK_SID: "wi390-batch" };
    const [first, second] = await Promise.all([
      run(nativeBatchInput(transcriptPath, `${SUB_REL}/sql/y.sql`, "tu-wi390-b-sub"), env),
      run(nativeBatchInput(transcriptPath, "sub/wi390-batch-top.ts", "tu-wi390-b-top"), env),
    ]);
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(first.stdout).toBe("");
    expect(second.stdout).toBe("");

    const byDomain = Object.fromEntries(
      acquiresOf().map((request) => [
        request.body.params.arguments.coordination_domain,
        request.body.params.arguments.paths,
      ]),
    );
    expect(acquiresOf()).toHaveLength(2);
    expect(byDomain).toEqual({
      [fs.realpathSync(sub)]: ["sql/y.sql"],
      [fs.realpathSync(repo)]: ["sub/wi390-batch-top.ts"],
    });
    // Per-call fallback: each call caches its OWN release token and domain.
    expect(fs.readFileSync(join(cache, "tu-wi390-b-sub.domain"), "utf8").trim()).toBe(
      fs.realpathSync(sub),
    );
    expect(fs.readFileSync(join(cache, "tu-wi390-b-top.domain"), "utf8").trim()).toBe(
      fs.realpathSync(repo),
    );
  });
});
