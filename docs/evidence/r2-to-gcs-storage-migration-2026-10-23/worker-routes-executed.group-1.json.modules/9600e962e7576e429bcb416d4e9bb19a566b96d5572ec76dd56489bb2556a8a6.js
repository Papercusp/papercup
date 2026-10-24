__vite_ssr_exportName__("WORKSPACE_HOST_AGENT_VERIFICATION_CONTRACT_VERSION", () => { try { return WORKSPACE_HOST_AGENT_VERIFICATION_CONTRACT_VERSION } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_CANARY_AGENTS", () => { try { return WORKSPACE_HOST_CANARY_AGENTS } catch {} });
__vite_ssr_exportName__("resolveWorkspaceHostRequestedAgents", () => { try { return resolveWorkspaceHostRequestedAgents } catch {} });
__vite_ssr_exportName__("workspaceHostAgentSpecSatisfiesReadiness", () => { try { return workspaceHostAgentSpecSatisfiesReadiness } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_OMP_LOCAL_MODEL", () => { try { return WORKSPACE_HOST_OMP_LOCAL_MODEL } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_OMP_LOCAL_INFERENCE_MARKER", () => { try { return WORKSPACE_HOST_OMP_LOCAL_INFERENCE_MARKER } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_CODEX_LIVE_INFERENCE_MARKER", () => { try { return WORKSPACE_HOST_CODEX_LIVE_INFERENCE_MARKER } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_CLAUDE_LIVE_INFERENCE_MARKER", () => { try { return WORKSPACE_HOST_CLAUDE_LIVE_INFERENCE_MARKER } catch {} });
__vite_ssr_exportName__("DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES", () => { try { return DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES } catch {} });
__vite_ssr_exportName__("workspaceHostAgentAllowedVerificationKinds", () => { try { return workspaceHostAgentAllowedVerificationKinds } catch {} });
__vite_ssr_exportName__("workspaceHostAgentVerificationKindIsAllowed", () => { try { return workspaceHostAgentVerificationKindIsAllowed } catch {} });
__vite_ssr_exportName__("DEFAULT_WORKSPACE_HOST_AGENT_PROBE_TIMEOUT_MS", () => { try { return DEFAULT_WORKSPACE_HOST_AGENT_PROBE_TIMEOUT_MS } catch {} });
__vite_ssr_exportName__("DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_TIMEOUT_BUDGET_MS", () => { try { return DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_TIMEOUT_BUDGET_MS } catch {} });
__vite_ssr_exportName__("buildWorkspaceHostAgentProbeProcess", () => { try { return buildWorkspaceHostAgentProbeProcess } catch {} });
__vite_ssr_exportName__("classifyWorkspaceHostAgentProbeFailure", () => { try { return classifyWorkspaceHostAgentProbeFailure } catch {} });
__vite_ssr_exportName__("workspaceHostAgentSubjectDigest", () => { try { return workspaceHostAgentSubjectDigest } catch {} });
__vite_ssr_exportName__("NodeWorkspaceHostAgentProbeRunner", () => { try { return NodeWorkspaceHostAgentProbeRunner } catch {} });
__vite_ssr_exportName__("probeWorkspaceHostAgentVerification", () => { try { return probeWorkspaceHostAgentVerification } catch {} });
__vite_ssr_exportName__("applyWorkspaceHostAgentRuntimePath", () => { try { return applyWorkspaceHostAgentRuntimePath } catch {} });
__vite_ssr_exportName__("probeWorkspaceHostAgents", () => { try { return probeWorkspaceHostAgents } catch {} });
const __vite_ssr_import_0__ = await __vite_ssr_import__("node:child_process", {"importedNames":["spawn"]});
const __vite_ssr_import_1__ = await __vite_ssr_import__("node:crypto", {"importedNames":["createHash"]});
const __vite_ssr_import_2__ = await __vite_ssr_import__("node:path", {"importedNames":["isAbsolute","normalize"]});
const __vite_ssr_import_3__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/libs/generic/deployment-driver/src/workspace-host-test-harness.ts", {"importedNames":["assertWorkspaceHostSecretIsolation"]});




const WORKSPACE_HOST_AGENT_VERIFICATION_CONTRACT_VERSION = "papercusp-workspace-host-agent-verification-v4";
const WORKSPACE_HOST_CANARY_AGENTS = ["claude", "codex", "omp"];
function resolveWorkspaceHostRequestedAgents(value) {
  if (value === void 0) return WORKSPACE_HOST_CANARY_AGENTS;
  if (!Array.isArray(value) || value.length === 0 || Array.from(value).some((agent) => !WORKSPACE_HOST_CANARY_AGENTS.includes(agent)) || new Set(value).size !== value.length) {
    throw new Error("requestedAgents must be a nonempty array of distinct claude, codex, or omp agents");
  };
  return WORKSPACE_HOST_CANARY_AGENTS.filter((agent) => value.includes(agent));
};
function workspaceHostAgentSpecSatisfiesReadiness(spec) {
  return spec.satisfiesReadiness !== false;
};
const SUBJECT_PATTERN = /(?:account|email|organi[sz]ation|org|logged in as|signed in as)\b[^A-Za-z0-9]{0,24}([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|[A-Za-z0-9][A-Za-z0-9._-]{2,63})/i;
const WORKSPACE_HOST_OMP_LOCAL_MODEL = "qwen2.5-coder:0.5b";
const WORKSPACE_HOST_OMP_LOCAL_INFERENCE_MARKER = "P046_OMP_LOCAL_INFERENCE_OK";
const WORKSPACE_HOST_CODEX_LIVE_INFERENCE_MARKER = "P046_CODEX_LIVE_OK";
const WORKSPACE_HOST_CLAUDE_LIVE_INFERENCE_MARKER = "P047_CLAUDE_LIVE_OK";
const DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES = {
  claude: [
    // WI-10001689. `authenticated-account` via `claude auth status` was REMOVED here rather than
    // kept as a first spec with live-inference behind it, and both halves of that are deliberate.
    //
    // It could never PASS. The agent-home bundle ships only `.claude/.credentials.json`, but the
    // subject that command names is read from `~/.claude.json` `oauthAccount.*`, which the bundle
    // does not ship — measured, a config dir holding only the credentials file reports
    // `"email": null` and matches no subject, so claude failed verify-initialization for EVERY
    // account, whatever credential was delivered.
    //
    // And it must NOT be repaired by shipping that identity file, because the check proves nothing
    // even when it is satisfied: `claude auth status` never contacts the endpoint it declares.
    // Measured, an entirely invented access token beside a hand-written oauthAccount block
    // reported `attacker@example.invalid` / `Fabricated Org` and MATCHED SUBJECT_PATTERN. The
    // subject comes from an ordinary writable JSON file, so anything that can write the agent home
    // can name any subject it likes. Shipping the identity file would only have turned the gate
    // green while leaving it forgeable, and would have put a real account's identity on the host
    // in order to do it. Ordering it FIRST would be worse still: a future oauthAccount file would
    // short-circuit the real probe and silently restore the vacuity.
    //
    // This is the conclusion the codex spec below already reached about `codex login status`
    // ("proves nothing about whether the delivered credential authenticates"); claude simply never
    // got the live-inference treatment that replaced it there.
    {
      agent: "claude",
      verificationKind: "live-inference",
      command: "claude",
      // No `--model` here, for the reason the codex spec documents: a model-specific value goes
      // stale under the probe and fails it for a NON-credential reason. `--strict-mcp-config`
      // keeps a host's MCP config out of a readiness probe, and `--no-session-persistence` keeps
      // the probe from writing session state into the agent home it is verifying. This EXACT argv
      // was measured against both a real and a fabricated credential before it shipped.
      args: [
        "-p",
        "--strict-mcp-config",
        "--no-session-persistence",
        `Reply with exactly ${WORKSPACE_HOST_CLAUDE_LIVE_INFERENCE_MARKER} and nothing else.`
      ],
      endpoint: "https://api.anthropic.com",
      // MULTILINE-ANCHORED, mirroring codex. Measured, `claude -p` does NOT echo the prompt (1
      // marker occurrence on a passing run, where codex exec produced 3), so the anchoring is not
      // load-bearing TODAY. It is kept because the codex comment records exactly what an
      // unanchored pattern costs if a CLI ever starts echoing: every credential failure reads as
      // ready. Cheap insurance against a CLI release nobody here controls.
      proofPattern: new RegExp(
        `^\\s*(${WORKSPACE_HOST_CLAUDE_LIVE_INFERENCE_MARKER})\\s*$`,
        "m"
      ),
      subjectDisclosure: "digest",
      timeoutMs: 18e4
    }
  ],
  codex: [
    {
      agent: "codex",
      verificationKind: "authenticated-account",
      command: "codex",
      args: ["login", "status"],
      endpoint: "https://api.openai.com",
      proofPattern: SUBJECT_PATTERN,
      subjectDisclosure: "digest",
      // WI-10001694, superseding D-265's ordering rationale. MEASURED 2026-09-17: against a fully
      // fabricated `$CODEX_HOME/auth.json` — invented email and account_id, placeholder access
      // token, an `alg:RS256` signature nothing signed — this command prints `Logged in using
      // ChatGPT` and exits 0. The REAL credential prints the SAME line at the same exit code, so
      // the outputs are byte-identical and this probe cannot tell a forged credential from a live
      // one. (Two cruder arms WERE rejected `invalid ID token format`, so codex parses the token
      // structurally and simply never verifies it.)
      //
      // It survives, rather than being removed as claude's was in WI-10001689, because it is the
      // only signal naming WHICH account a host authenticated as — and it is safe to keep ONLY
      // because it can no longer decide readiness. What stops the vacuity is this flag, not the
      // fact that `Logged in using ChatGPT` happens to miss SUBJECT_PATTERN today: that miss is a
      // coincidence of one CLI's current output string, and any auth mode or future release that
      // prints an account line would have restored the short-circuit silently.
      satisfiesReadiness: false
    },
    // D-265, as amended by WI-10001694: this is now codex's ONLY readiness-bearing probe, not a
    // fallback behind the account probe. It has to exist because, under ChatGPT OAuth,
    // `codex login status` prints exactly `Logged in using ChatGPT` — no account, no email, and
    // no `--json` to ask for one — so SUBJECT_PATTERN cannot match and codex could never pass.
    //
    // Widening SUBJECT_PATTERN to accept that line was REJECTED: it would digest a PROVIDER name
    // as though it were an account subject, and — measured — that line is printed for a 30-day
    // expired token with garbage access and refresh tokens too, so it proves nothing about
    // whether the delivered credential authenticates.
    {
      agent: "codex",
      verificationKind: "live-inference",
      command: "codex",
      // No `-c` override in this argv. A model-specific value goes stale under the probe and
      // fails it for a NON-credential reason: `-c model_reasoning_effort="minimal"` was measured
      // returning HTTP 400 `Unsupported value: 'minimal' is not supported with the 'gpt-5.6-sol'
      // model`, which is a false RED. `--sandbox read-only` is not such a value — a readiness
      // probe must not need write access, and it measured cheaper (15,883 vs 16,267 tokens).
      args: [
        "exec",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        `Reply with exactly ${WORKSPACE_HOST_CODEX_LIVE_INFERENCE_MARKER} and nothing else.`
      ],
      endpoint: "https://api.openai.com",
      // MULTILINE-ANCHORED, and the anchoring is load-bearing rather than tidy: codex echoes the
      // prompt, so the marker appears in the output of a FAILING run too (measured: once, in the
      // `Reply with exactly …` line). An unanchored pattern would match that echo and report
      // every credential failure as ready. Measured both ways against real captures — positive
      // exit 0 with 3 occurrences MATCHES; negative exit 1 with 1 occurrence does NOT.
      proofPattern: new RegExp(
        `^\\s*(${WORKSPACE_HOST_CODEX_LIVE_INFERENCE_MARKER})\\s*$`,
        "m"
      ),
      subjectDisclosure: "digest",
      timeoutMs: 18e4
    }
  ],
  omp: [
    {
      agent: "omp",
      verificationKind: "authenticated-account",
      command: "omp",
      args: ["usage", "--json", "--redact"],
      endpoint: "papercusp-omp-broker",
      // `--redact` already reduces account ids to a shortest-unique prefix, so the captured value
      // is publishable as-is; this reads the first account id out of the JSON report.
      proofPattern: /"(?:account|accountId|account_id)"\s*:\s*"([^"\\]{1,120})"/,
      subjectDisclosure: "redacted"
    },
    {
      agent: "omp",
      verificationKind: "local-inference",
      command: "omp",
      args: [
        "--model",
        `ollama/${WORKSPACE_HOST_OMP_LOCAL_MODEL}`,
        "--print",
        "--no-tools",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-rules",
        "--mode",
        "text",
        `Reply with exactly ${WORKSPACE_HOST_OMP_LOCAL_INFERENCE_MARKER} and nothing else.`
      ],
      endpoint: "http://127.0.0.1:11434",
      proofPattern: new RegExp(
        `^\\s*(${WORKSPACE_HOST_OMP_LOCAL_INFERENCE_MARKER})\\s*$`
      ),
      subjectDisclosure: "digest",
      timeoutMs: 18e4
    }
  ]
};
function workspaceHostAgentAllowedVerificationKinds(agent, probes = DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES) {
  return new Set(
    (probes[agent] ?? []).filter(workspaceHostAgentSpecSatisfiesReadiness).map((spec) => spec.verificationKind)
  );
};
function workspaceHostAgentVerificationKindIsAllowed(agent, kind, probes) {
  return workspaceHostAgentAllowedVerificationKinds(agent, probes).has(
    kind
  );
};
const DEFAULT_WORKSPACE_HOST_AGENT_PROBE_TIMEOUT_MS = 6e4;
const DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_TIMEOUT_BUDGET_MS = WORKSPACE_HOST_CANARY_AGENTS.reduce(
  (total, agent) => total + DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES[agent].reduce(
    (agentTotal, spec) => agentTotal + (spec.timeoutMs ?? DEFAULT_WORKSPACE_HOST_AGENT_PROBE_TIMEOUT_MS),
    0
  ),
  0
);
const STDERR_CLASSIFY_WINDOW_BYTES = 4096;
const MAX_PROBE_OUTPUT_BYTES = 512 * 1024;
const MAX_PROBE_STDERR_DIAGNOSTIC_BYTES = 64 * 1024;
const WORKSPACE_HOST_PROBE_RUNUSER = "/usr/sbin/runuser";
const WORKSPACE_HOST_PROBE_ENV = "/usr/bin/env";
const WORKSPACE_HOST_PROBE_LAUNCH_PATH = "/usr/sbin:/usr/bin:/sbin:/bin";
const WORKSPACE_HOST_PROBE_ACCOUNT = /^[a-z_][a-z0-9_-]{0,30}$/;
const WORKSPACE_HOST_PROBE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
function buildWorkspaceHostAgentProbeProcess(invocation) {
  if (invocation.cwd !== void 0 && (!(0,__vite_ssr_import_2__.isAbsolute)(invocation.cwd) || (0,__vite_ssr_import_2__.normalize)(invocation.cwd) !== invocation.cwd || containsControlCharacter(invocation.cwd))) {
    throw new Error(
      "agent authentication probe cwd must be an absolute canonical path free of control characters"
    );
  };
  if (!invocation.runAsUser) {
    return {
      command: invocation.command,
      args: invocation.args,
      ...invocation.env ? { env: invocation.env } : {},
      ...invocation.cwd ? { cwd: invocation.cwd } : {}
    };
  };
  if (!WORKSPACE_HOST_PROBE_ACCOUNT.test(invocation.runAsUser) || invocation.runAsUser === "root") {
    throw new Error(
      "agent authentication probe runAsUser must be a non-root Linux account"
    );
  };
  if (!invocation.env) {
    throw new Error(
      "agent authentication probe runAsUser requires a complete environment"
    );
  };
  const agentHome = invocation.env.HOME;
  if (!agentHome?.startsWith("/") || containsControlCharacter(agentHome)) {
    throw new Error(
      "agent authentication probe runAsUser requires an absolute HOME"
    );
  };
  const environment = Object.entries(invocation.env).map(([key, value]) => {
    if (!WORKSPACE_HOST_PROBE_ENV_NAME.test(key) || /\0/.test(value)) {
      throw new Error(
        "agent authentication probe environment is not safe for env -i"
      );
    };
    return `${key}=${value}`;
  });
  return {
    command: WORKSPACE_HOST_PROBE_RUNUSER,
    // SSH enters its own 0700 home. Switching identity does not change cwd;
    // agents must start inside the home their credential binding actually owns.
    cwd: invocation.cwd ?? agentHome,
    args: [
      "--user",
      invocation.runAsUser,
      "--",
      WORKSPACE_HOST_PROBE_ENV,
      "-i",
      "--",
      ...environment,
      invocation.command,
      ...invocation.args
    ],
    // This environment belongs only to the trusted runuser launcher. The target receives the
    // exact allowlist above after env -i; nothing from the initializer process is inherited.
    env: { PATH: WORKSPACE_HOST_PROBE_LAUNCH_PATH }
  };
};
const PROBE_FAILURE_CLASSIFIERS = [
  // Measured r7 failure: retain the cause while discarding all credential text.
  { pattern: /\brefresh token was revoked\b/i, reason: "credential-revoked" },
  // Measured 2026-09-11 (P-305 G6 root cause): a delivered auth.json the CLI cannot deserialize
  // prints serde's `missing field \`<name>\`` and exits 1 — a MALFORMED generation, not a
  // revoked or exhausted one. Name it, so the reader is sent to the projection, not the account.
  { pattern: /\bmissing field\b/i, reason: "credential-malformed" },
  // The provider refused the identity outright (codex exec sends no bearer when auth.json did
  // not parse; an expired/foreign access token lands here too). Distinct from quota, which
  // requires an ACCEPTED identity to be reported at all.
  { pattern: /\b401 unauthorized\b/i, reason: "credential-unauthorized" },
  // Claude's exhaustion names the window instead of saying "usage": weekly (P-318) and the 5-hour
  // session window, measured 2026-10-07 (WI-10007043) as `You've hit your session limit · resets
  // 11pm (America/New_York)` on stdout with exit 1, which was reported as a bare non-zero-exit.
  { pattern: /\bhit your (?:usage|weekly|session) limit\b/i, reason: "provider-usage-limit" },
  { pattern: /\busage limit reached\b/i, reason: "provider-usage-limit" },
  { pattern: /\bquota exceeded\b/i, reason: "provider-usage-limit" },
  { pattern: /\binsufficient_quota\b/i, reason: "provider-usage-limit" },
  { pattern: /\brate limit exceeded\b/i, reason: "provider-usage-limit" }
];
function classifyWorkspaceHostAgentProbeFailure(output) {
  for (const classifier of PROBE_FAILURE_CLASSIFIERS) {
    if (classifier.pattern.test(output)) return classifier.reason;
  };
  return void 0;
};
function workspaceHostAgentSubjectDigest(subject) {
  return (0,__vite_ssr_import_1__.createHash)("sha256").update(subject).digest("hex").slice(0, 16);
};
class NodeWorkspaceHostAgentProbeRunner {
  // Keep the child-process boundary independent of a host application's ambient
  // NodeJS.ProcessEnv augmentation (Next.js makes NODE_ENV required). The child
  // receives the complete allowlisted string map; consumer globals must not change
  // spawn overload resolution or reduce the returned handle to `never`.
  constructor(spawnImpl = __vite_ssr_import_0__.spawn) {
    this.spawnImpl = spawnImpl;
  }
  run(invocation) {
    return new Promise((resolve, reject) => {
      let processInput;
      try {
        processInput = buildWorkspaceHostAgentProbeProcess(invocation);
      } catch (error) {
        reject(error);
        return;
      };
      const ownsProcessGroup = process.platform !== "win32";
      const spawnOptions = {
        stdio: ["ignore", "pipe", "pipe"],
        detached: ownsProcessGroup,
        ...processInput.cwd ? { cwd: processInput.cwd } : {},
        ...processInput.env ? { env: { ...processInput.env } } : {}
      };
      const child = this.spawnImpl(
        processInput.command,
        [...processInput.args],
        spawnOptions
      );
      let stdout = "";
      let bytes = 0;
      let settled = false;
      let stderrWindow = "";
      let stderrByteCount = 0;
      let stderrByteCountTruncated = false;
      let failureHint;
      const killProbe = () => {
        if (ownsProcessGroup && child.pid !== void 0) {
          try {
            process.kill(-child.pid, "SIGKILL");
            return;
          } catch {
          }
        };
        child.kill("SIGKILL");
      };
      const finish = (fn) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        finish(() => {
          killProbe();
          reject(
            new Error(
              `agent authentication probe timed out after ${invocation.timeoutMs}ms`
            )
          );
        });
      }, invocation.timeoutMs);
      child.stdout?.on("data", (chunk) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        bytes += Buffer.byteLength(text);
        if (bytes > MAX_PROBE_OUTPUT_BYTES) {
          finish(() => {
            killProbe();
            reject(
              new Error("agent authentication probe produced too much output")
            );
          });
          return;
        };
        stdout += text;
      });
      child.stderr?.on("data", (chunk) => {
        const chunkBytes = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
        const observedStderrBytes = stderrByteCount + chunkBytes;
        if (observedStderrBytes > MAX_PROBE_STDERR_DIAGNOSTIC_BYTES) {
          stderrByteCount = MAX_PROBE_STDERR_DIAGNOSTIC_BYTES;
          stderrByteCountTruncated = true;
        } else {
          stderrByteCount = observedStderrBytes;
        };
        if (failureHint) return;
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        stderrWindow = (stderrWindow + text).slice(-STDERR_CLASSIFY_WINDOW_BYTES);
        failureHint = classifyWorkspaceHostAgentProbeFailure(stderrWindow);
        if (failureHint) stderrWindow = "";
      });
      child.on("error", (error) => finish(() => reject(error)));
      child.on(
        "close",
        (code) => finish(
          () => resolve({
            exitCode: typeof code === "number" ? code : 1,
            stdout,
            stderrByteCount,
            stderrByteCountTruncated,
            // stdout is classified too: a CLI that reports quota on stdout is just as opaque.
            ...(failureHint ??= classifyWorkspaceHostAgentProbeFailure(stdout)) ? { failureHint } : {}
          })
        )
      );
    });
  }
};
function probeStderrDiagnosticFields(outcome) {
  const count = outcome.stderrByteCount;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
    return {};
  };
  return {
    stderrByteCount: Math.min(count, MAX_PROBE_STDERR_DIAGNOSTIC_BYTES),
    stderrByteCountTruncated: outcome.stderrByteCountTruncated === true || count > MAX_PROBE_STDERR_DIAGNOSTIC_BYTES
  };
}
async function probeWorkspaceHostAgentVerification(input) {
  const { spec, runner, now } = input;
  const base = {
    contractVersion: WORKSPACE_HOST_AGENT_VERIFICATION_CONTRACT_VERSION,
    agent: spec.agent,
    verificationKind: spec.verificationKind,
    endpoint: spec.endpoint,
    subjectDisclosure: spec.subjectDisclosure
  };
  let outcome;
  try {
    outcome = await runner.run({
      command: spec.command,
      args: spec.args,
      timeoutMs: spec.timeoutMs ?? DEFAULT_WORKSPACE_HOST_AGENT_PROBE_TIMEOUT_MS,
      ...input.env ? { env: input.env } : {},
      ...input.cwd ? { cwd: input.cwd } : {},
      ...input.runAsUser ? { runAsUser: input.runAsUser } : {}
    });
  } catch {
    const evidence2 = {
      ...base,
      ready: false,
      exitStatus: -1,
      observedAt: now().toISOString(),
      failure: "probe-error"
    };
    (0,__vite_ssr_import_3__.assertWorkspaceHostSecretIsolation)(
      evidence2,
      `workspaceHost.agentAuthentication.${spec.agent}`
    );
    return evidence2;
  };
  const observedAt = now().toISOString();
  if (outcome.exitCode !== 0) {
    const evidence2 = {
      ...base,
      ...probeStderrDiagnosticFields(outcome),
      ready: false,
      exitStatus: outcome.exitCode,
      observedAt,
      // A classified provider cause outranks the generic shape code: "non-zero-exit" describes
      // HOW the probe failed, "provider-usage-limit" describes WHY, and only the second one tells
      // a reader not to go looking at the credential.
      failure: outcome.failureHint ?? "non-zero-exit"
    };
    (0,__vite_ssr_import_3__.assertWorkspaceHostSecretIsolation)(
      evidence2,
      `workspaceHost.agentAuthentication.${spec.agent}`
    );
    return evidence2;
  };
  const match = spec.proofPattern.exec(outcome.stdout);
  const proof = match?.[1]?.trim();
  if (!proof) {
    const evidence2 = {
      ...base,
      ...probeStderrDiagnosticFields(outcome),
      ready: false,
      exitStatus: outcome.exitCode,
      observedAt,
      // The measured WI-2144034 case lands HERE, not above: `codex exec` exited 0 while printing a
      // usage-limit error, so the marker was simply absent. Without the hint this reads as
      // "no proof" and sends every reader to the credentials.
      failure: outcome.failureHint ?? "no-verification-proof"
    };
    (0,__vite_ssr_import_3__.assertWorkspaceHostSecretIsolation)(
      evidence2,
      `workspaceHost.agentAuthentication.${spec.agent}`
    );
    return evidence2;
  };
  const evidence = {
    ...base,
    ready: true,
    exitStatus: outcome.exitCode,
    observedAt,
    proofDigest: workspaceHostAgentSubjectDigest(proof),
    ...spec.verificationKind === "authenticated-account" && spec.subjectDisclosure === "redacted" ? { subject: proof } : {}
  };
  (0,__vite_ssr_import_3__.assertWorkspaceHostSecretIsolation)(
    evidence,
    `workspaceHost.agentAuthentication.${spec.agent}`
  );
  return evidence;
};
function containsControlCharacter(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  };
  return false;
}
function applyWorkspaceHostAgentRuntimePath(spec, runtimePath) {
  if (runtimePath === void 0) return spec;
  if (!runtimePath.startsWith("/") || runtimePath.length < 2 || containsControlCharacter(runtimePath)) {
    throw new Error(
      `agent '${spec.agent}' runtime path must be an absolute path free of control characters`
    );
  };
  return { ...spec, command: runtimePath };
};
async function probeWorkspaceHostAgents(input) {
  const requestedAgents = resolveWorkspaceHostRequestedAgents(input.requestedAgents);
  const now = input.now ?? (() => /* @__PURE__ */ new Date());
  const agents = {};
  for (const agent of requestedAgents) {
    const specs = input.probes?.[agent] ?? DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES[agent];
    if (specs.length === 0) {
      throw new Error(`agent '${agent}' has no verification probes`);
    };
    for (const spec of specs) {
      if (spec.agent !== agent) {
        throw new Error(
          `agent probe for '${agent}' declares agent '${spec.agent}'`
        );
      }
    };
    if (!specs.some(workspaceHostAgentSpecSatisfiesReadiness)) {
      throw new Error(
        `agent '${agent}' has no readiness-bearing verification probe`
      );
    };
    let readiness;
    let selfReportedSubjectDigest;
    for (const spec of specs) {
      const evidence = await probeWorkspaceHostAgentVerification({
        // Applied AFTER the agent-mismatch check above, so a mis-declared spec is refused as a
        // mis-declared spec rather than silently rewritten to point at another agent's binary.
        spec: applyWorkspaceHostAgentRuntimePath(
          spec,
          input.runtimePaths?.[agent]
        ),
        runner: input.runner,
        now,
        ...input.env ? { env: input.env } : {},
        ...input.cwd ? { cwd: input.cwd } : {},
        ...input.runAsUser ? { runAsUser: input.runAsUser } : {}
      });
      if (!workspaceHostAgentSpecSatisfiesReadiness(spec)) {
        if (evidence.proofDigest) {
          selfReportedSubjectDigest = evidence.proofDigest;
        };
        continue;
      };
      readiness = evidence;
      if (evidence.ready) break;
    };
    if (!readiness) {
      throw new Error(
        `agent '${agent}' produced no readiness-bearing evidence`
      );
    };
    const merged = selfReportedSubjectDigest ? { ...readiness, selfReportedSubjectDigest } : readiness;
    (0,__vite_ssr_import_3__.assertWorkspaceHostSecretIsolation)(
      merged,
      `workspaceHost.agentAuthentication.${agent}`
    );
    agents[agent] = merged;
  };
  const report = {
    contractVersion: WORKSPACE_HOST_AGENT_VERIFICATION_CONTRACT_VERSION,
    observedAt: now().toISOString(),
    allReady: WORKSPACE_HOST_CANARY_AGENTS.every(
      (agent) => agents[agent]?.ready === true
    ),
    ...input.requestedAgents !== void 0 ? { requestedAgents } : {},
    agents
  };
  (0,__vite_ssr_import_3__.assertWorkspaceHostSecretIsolation)(
    report,
    "workspaceHost.agentAuthentication.report"
  );
  return report;
}
//# sourceMappingSource=vite-generated
//# sourceMappingURL=data:application/json;base64,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LEtBQUs7QUFBQSxJQUM1QztBQUNBLFdBQU8sS0FBSyxJQUFJO0FBQUEsRUFDbEI7QUFDQSxRQUFNLFNBQStDO0FBQUEsSUFDbkQsaUJBQWlCO0FBQUEsSUFDakIsWUFBWSxJQUFJLEVBQUUsWUFBWTtBQUFBLElBQzlCLFVBQVUsNkJBQTZCO0FBQUEsTUFDckMsQ0FBQyxVQUFVLE9BQU8sS0FBSyxHQUFHLFVBQVU7QUFBQSxJQUN0QztBQUFBLElBQ0EsR0FBSSxNQUFNLG9CQUFvQixTQUFZLEVBQUUsZ0JBQWdCLElBQUksQ0FBQztBQUFBLElBQ2pFO0FBQUEsRUFDRjtBQUNBO0FBQUEsSUFDRTtBQUFBLElBQ0E7QUFBQSxFQUNGO0FBQ0EsU0FBTztBQUNUIiwibmFtZXMiOlsiZXZpZGVuY2UiXSwiaWdub3JlTGlzdCI6W10sInNvdXJjZXMiOlsid29ya3NwYWNlLWhvc3QtYWdlbnQtYXV0aGVudGljYXRpb24udHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBSZWFsLCBub24taW50ZXJhY3RpdmUgcmVhZGluZXNzIHByb2JlcyBmb3IgdGhlIHRocmVlIGFnZW50cyBhIHdvcmtzcGFjZSBob3N0IG11c3QgYmUgYWJsZSB0b1xuICogZXhlY3V0ZSAoUC0wNDYgLyBXSS00MTcxMSAvIEQtMjMwKS5cbiAqXG4gKiBUSEUgR0FQIFRISVMgQ0xPU0VTLiBgV29ya3NwYWNlSG9zdEluaXRpYWxpemF0aW9uQ2FuYXJ5RXZpZGVuY2UuYWdlbnRzYCBjYXJyaWVzXG4gKiBgeyBjbGF1ZGU6IHsgcmVhZHk6IHRydWUsIHZlcmlmaWNhdGlvbktpbmQ6IOKApiB9LCDigKYgfWAsIGFuZFxuICogYHZhbGlkYXRlV29ya3NwYWNlSG9zdEluaXRpYWxpemF0aW9uQ2FuYXJ5YCBjaGVja3MgdGhhdCByZWFkaW5lc3MuIE5vdGhpbmcgb3JpZ2luYWxseSBkZXJpdmVkXG4gKiB0aGUgb2xkIGF1dGhlbnRpY2F0ZWQgYm9vbGVhbnMgZnJvbSBhbnl0aGluZy4gVGhlIHR5cGUgbWFrZXMgYGZhbHNlYCB1bnJlcHJlc2VudGFibGUsIHNvIHRoZSB2YWxpZGF0b3IncyBhZ2VudFxuICogY2hlY2sgY291bGQgb25seSBldmVyIGZhaWwgaWYgYSBjYWxsZXIgd2VudCBvdXQgb2YgaXRzIHdheSB0byBjb25zdHJ1Y3QgaW52YWxpZCBldmlkZW5jZSDigJRcbiAqIGkuZS4gYSBncmVlbiBjYW5hcnkgdmVyZGljdCBwcm92ZWQgbm90aGluZyBhdCBhbGwgYWJvdXQgd2hldGhlciBDbGF1ZGUsIENvZGV4IG9yIE9NUCBoYWRcbiAqIGFjdHVhbGx5IGF1dGhlbnRpY2F0ZWQuIFRoaXMgbW9kdWxlIG1ha2VzIHJlYWRpbmVzcyB0aGUgT1VUUFVUIG9mIGEgcHJvYmUgdGhhdCBoYXMgdG8gc3VjY2VlZCxcbiAqIGFuZCByZWNvcmRzIHdoZXRoZXIgdGhlIHByb29mIHdhcyBhbiBhdXRoZW50aWNhdGVkIGFjY291bnQgb3IgcmVhbCBsb2NhbCBpbmZlcmVuY2UsIHNvIHRoZVxuICogdmVyZGljdCBiZWNvbWVzIGZhbHNpZmlhYmxlIHdpdGhvdXQgY2xhaW1pbmcgdGhhdCBhIG5vLWF1dGggbG9jYWwgbW9kZWwgaXMgXCJhdXRoZW50aWNhdGVkXCIuXG4gKlxuICogV0hBVCBBIFBST0JFIE1BWSBFTUlULiBPbmx5IHRoZSBmb3VyIGRpc2NyaW1pbmF0b3JzIHRoZSByZWNlaXB0IGNvbnRyYWN0IGFsbG93czogd2hpY2hcbiAqIGFjY291bnQvc3ViamVjdCBhbnN3ZXJlZCwgd2hpY2ggZW5kcG9pbnQgd2FzIHJlYWNoZWQsIHRoZSBleGl0IHN0YXR1cywgYW5kIHdoZW4uIFJhdyBzdGRvdXRcbiAqIE5FVkVSIGVzY2FwZXMgdGhpcyBtb2R1bGUg4oCUIHRoZSBleHRyYWN0aW9uIHJlZ2V4IHJ1bnMgaW4tcHJvY2VzcyBhbmQgb25seSBpdHMgY2FwdHVyZWQgZ3JvdXBcbiAqIGlzIGNvbnNpZGVyZWQsIGFuZCBldmVuIHRoYXQgaXMgZW1pdHRlZCBhcyBhIGRpZ2VzdCB1bmxlc3MgdGhlIHByb2JlIGRlY2xhcmVzIGl0cyBvd24gb3V0cHV0XG4gKiBhbHJlYWR5IHJlZGFjdGVkLiBUaGF0IG9yZGVyaW5nIG1hdHRlcnM6IGEgcHJvYmUgdGhhdCBlbWl0dGVkIHN0ZG91dCBhbmQgcmVkYWN0ZWQgYWZ0ZXJ3YXJkc1xuICogd291bGQgbGVhayBvbiBldmVyeSBwYXRoIHRoYXQgbG9nZ2VkIHRoZSBpbnRlcm1lZGlhdGUgdmFsdWUuXG4gKlxuICogV0hZIFRIRVNFIENPTU1BTkRTLiBFYWNoIGRlZmF1bHQgaXMgYSBkb2N1bWVudGVkIG5vbi1pbnRlcmFjdGl2ZSBzdGF0dXMgdmVyYiBvZiB0aGUgYWdlbnQnc1xuICogT1dOIENMSSwgcmVhZCBmcm9tIGl0cyBgLS1oZWxwYCByYXRoZXIgdGhhbiBhc3N1bWVkOlxuICogICBjbGF1ZGUg4oaSIGBhdXRoIHN0YXR1c2AgICAgICAoXCJTaG93IGF1dGhlbnRpY2F0aW9uIHN0YXR1c1wiKVxuICogICBjb2RleCAg4oaSIGBsb2dpbiBzdGF0dXNgICAgICAoXCJTaG93IGxvZ2luIHN0YXR1c1wiKVxuICogICBvbXAgICAg4oaSIGZpcnN0IGB1c2FnZSAtLWpzb24gLS1yZWRhY3RgIGZvciBhIGhvc3RlZCBhY2NvdW50OyBpZiBubyBhY2NvdW50IGFuc3dlcnMsIGludm9rZVxuICogICAgICAgICAgICBPTVAgaXRzZWxmIG5vbi1pbnRlcmFjdGl2ZWx5IGFnYWluc3QgbG9vcGJhY2sgT2xsYW1hIGFuZCByZXF1aXJlIGEgbW9kZWwtcHJvZHVjZWRcbiAqICAgICAgICAgICAgbWFya2VyLiBBIHZlcnNpb24gY2hlY2ssIG1vZGVsIGxpc3RpbmcsIG9yIGJyb2tlciByZWdpc3RyYXRpb24gaXMgbm90IGluZmVyZW5jZS5cbiAqIEEgcHJvYmUgcmVhY2hlcyB0aGUgYWdlbnQncyByZWFsIGF1dGhlbnRpY2F0ZWQgc3VyZmFjZTsgaXQgaXMgbm90IGEgdmVyc2lvbiBjaGVjay4gYC0tdmVyc2lvbmBcbiAqIHdvdWxkIHBhc3Mgb24gYSBob3N0IHdoZXJlIG5vYm9keSBoYWQgZXZlciBzaWduZWQgaW4sIHdoaWNoIGlzIHRoZSBwcmVjaXNlIGZhaWx1cmUgdGhlIGNhbmFyeVxuICogZXhpc3RzIHRvIGNhdGNoLlxuICovXG5pbXBvcnQgeyBzcGF3biBhcyBub2RlU3Bhd24gfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQgdHlwZSB7IENoaWxkUHJvY2VzcyB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcbmltcG9ydCB7IGNyZWF0ZUhhc2ggfSBmcm9tIFwibm9kZTpjcnlwdG9cIjtcbmltcG9ydCB7IGlzQWJzb2x1dGUsIG5vcm1hbGl6ZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcblxuaW1wb3J0IHsgYXNzZXJ0V29ya3NwYWNlSG9zdFNlY3JldElzb2xhdGlvbiB9IGZyb20gXCIuL3dvcmtzcGFjZS1ob3N0LXRlc3QtaGFybmVzc1wiO1xuXG4vLyB2MyAoRC0yNjUpOiBjb2RleCBnYWluZWQgYSBgbGl2ZS1pbmZlcmVuY2VgIHByb2JlLiBUaGUgYnVtcCBpcyBkZWxpYmVyYXRlIGFuZCBsb2FkLWJlYXJpbmcg4oCUXG4vLyB0aGUgY29udHJvbGxlciBjb21wYXJlcyB0aGlzIGFnYWluc3QgdGhlIHJlcG9ydCB0aGUgSE9TVCBwcm9kdWNlZCBvdXQgb2YgaXRzIHJlbGVhc2UgYnVuZGxlLCBzb1xuLy8gYnVtcGluZyBpdCBpcyB3aGF0IHR1cm5zIFwidGhpcyBob3N0IGlzIHN0aWxsIHJ1bm5pbmcgdGhlIG9sZCBjb2RleCBwcm9iZVwiIGludG8gYSBsb3VkIGNvbnRyYWN0XG4vLyBtaXNtYXRjaCBpbnN0ZWFkIG9mIGEgc2lsZW50IDUvNiB0aGF0IHJlYWRzIGFzIGEgY3JlZGVudGlhbCBmYXVsdC4gVGhhdCBtaXNyZWFkaW5nIGNvc3QgYVxuLy8gY2FuYXJ5IGFuZCBtb3N0IG9mIGEgc2Vzc2lvbiBiZWZvcmUgaXQgd2FzIHRyYWNlZCB0byB0aGUgYnVuZGxlIHJhdGhlciB0aGFuIHRoZSBjcmVkZW50aWFscy5cbi8vXG4vLyB2NCAoV0ktMTAwMDE2OTQpOiByZWFkaW5lc3MgYW5kIGlkZW50aXR5IG5vIGxvbmdlciBjb21wZXRlIGZvciBvbmUgYm9vbGVhbi4gY29kZXgnc1xuLy8gYGF1dGhlbnRpY2F0ZWQtYWNjb3VudGAgcHJvYmUgaXMgYHNhdGlzZmllc1JlYWRpbmVzczogZmFsc2VgIOKAlCBpdCBzdGlsbCByZWNvcmRzIFdITyB0aGVcbi8vIGNyZWRlbnRpYWwgY2xhaW1zIHRvIGJlLCBidXQgb25seSBhbiBpbmZlcmVuY2UgcHJvYmUgY2FuIG1hcmsgYW4gYWdlbnQgcmVhZHkuIFRoZSBidW1wIGlzXG4vLyByZXF1aXJlZCBmb3IgdGhlIHNhbWUgcmVhc29uIHYzJ3Mgd2FzOiBhIGhvc3Qgc3RpbGwgcnVubmluZyB0aGUgdjMgYnVuZGxlIGhhcyB0aGUgU0hPUlQtQ0lSQ1VJVFxuLy8gYXJyYW5nZW1lbnQsIHdoZXJlIGEgZm9yZ2VkIGBhdXRoLmpzb25gIHRoYXQgbWF0Y2hlcyBTVUJKRUNUX1BBVFRFUk4gbWFya3MgY29kZXggcmVhZHkgYW5kXG4vLyBgbGl2ZS1pbmZlcmVuY2VgIG5ldmVyIHJ1bnMuIFRoYXQgaG9zdCBpcyBub3QgZXF1aXZhbGVudCB0byB0aGlzIG9uZSwgYW5kIHRoZSBzdHJpY3QtZXF1YWxpdHlcbi8vIGNvbXBhcmlzb24gaW4gdGhlIGNvbnRyb2xsZXIgaXMgd2hhdCByZWZ1c2VzIGl0IGluc3RlYWQgb2YgdHJ1c3RpbmcgaXRzIHJlcG9ydC5cbmV4cG9ydCBjb25zdCBXT1JLU1BBQ0VfSE9TVF9BR0VOVF9WRVJJRklDQVRJT05fQ09OVFJBQ1RfVkVSU0lPTiA9XG4gIFwicGFwZXJjdXNwLXdvcmtzcGFjZS1ob3N0LWFnZW50LXZlcmlmaWNhdGlvbi12NFwiO1xuXG5leHBvcnQgY29uc3QgV09SS1NQQUNFX0hPU1RfQ0FOQVJZX0FHRU5UUyA9IFtcImNsYXVkZVwiLCBcImNvZGV4XCIsIFwib21wXCJdIGFzIGNvbnN0O1xuZXhwb3J0IHR5cGUgV29ya3NwYWNlSG9zdENhbmFyeUFnZW50ID1cbiAgKHR5cGVvZiBXT1JLU1BBQ0VfSE9TVF9DQU5BUllfQUdFTlRTKVtudW1iZXJdO1xuXG4vKiogVmFsaWRhdGUgY292ZXJhZ2UgYmVmb3JlIGFueSBjcmVkZW50aWFsIHJlYWQgb3IgcnVudGltZSBpbnZvY2F0aW9uLiBPbWlzc2lvbiBtZWFucyBhbGwgYWdlbnRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVXb3Jrc3BhY2VIb3N0UmVxdWVzdGVkQWdlbnRzKHZhbHVlOiB1bmtub3duKTogcmVhZG9ubHkgV29ya3NwYWNlSG9zdENhbmFyeUFnZW50W10ge1xuICBpZiAodmFsdWUgPT09IHVuZGVmaW5lZCkgcmV0dXJuIFdPUktTUEFDRV9IT1NUX0NBTkFSWV9BR0VOVFM7XG4gIGlmICghQXJyYXkuaXNBcnJheSh2YWx1ZSkgfHwgdmFsdWUubGVuZ3RoID09PSAwIHx8XG4gICAgICBBcnJheS5mcm9tKHZhbHVlKS5zb21lKChhZ2VudCkgPT4gIVdPUktTUEFDRV9IT1NUX0NBTkFSWV9BR0VOVFMuaW5jbHVkZXMoYWdlbnQpKSB8fFxuICAgICAgbmV3IFNldCh2YWx1ZSkuc2l6ZSAhPT0gdmFsdWUubGVuZ3RoKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwicmVxdWVzdGVkQWdlbnRzIG11c3QgYmUgYSBub25lbXB0eSBhcnJheSBvZiBkaXN0aW5jdCBjbGF1ZGUsIGNvZGV4LCBvciBvbXAgYWdlbnRzXCIpO1xuICB9XG4gIC8vIENhbm9uaWNhbCBvcmRlciBtYWtlcyBpbW11dGFibGUgc2NvcGUvcmVwbGF5IGNvbXBhcmlzb25zIGluZGVwZW5kZW50IG9mIGNhbGxlciBvcmRlcmluZy5cbiAgcmV0dXJuIFdPUktTUEFDRV9IT1NUX0NBTkFSWV9BR0VOVFMuZmlsdGVyKChhZ2VudCkgPT4gdmFsdWUuaW5jbHVkZXMoYWdlbnQpKTtcbn1cblxuLyoqXG4gKiBgYXV0aGVudGljYXRlZC1hY2NvdW50YCBwcm92ZXMgV0hPIHRoZSBjcmVkZW50aWFsIGJlbG9uZ3MgdG8gYnkgbWFraW5nIHRoZSBDTEkgbmFtZSBhIHN1YmplY3QuXG4gKiBUaGUgdHdvIGluZmVyZW5jZSBraW5kcyBwcm92ZSB0aGUgY3JlZGVudGlhbCBXT1JLUyBieSBtYWtpbmcgdGhlIGFnZW50IGRvIHdvcmsgYW5kIHJldHVybiBhXG4gKiBtYXJrZXIsIGFuZCBleGlzdCBiZWNhdXNlIG5hbWluZyBhIHN1YmplY3QgaXMgbm90IGFsd2F5cyBwb3NzaWJsZSBvciBub3QgYWx3YXlzIG1lYW5pbmdmdWw6XG4gKlxuICogLSBgbG9jYWwtaW5mZXJlbmNlYCByZWFjaGVzIGEgbW9kZWwgb24gdGhlIGhvc3QgaXRzZWxmIChPTVAgYWdhaW5zdCBvbGxhbWEpLiBUaGVyZSBpcyBubyByZW1vdGVcbiAqICAgYWNjb3VudCB0byBuYW1lLCBzbyB0aGUgd29yayBJUyB0aGUgZXZpZGVuY2UuXG4gKiAtIGBsaXZlLWluZmVyZW5jZWAgcmVhY2hlcyB0aGUgYWdlbnQncyBSRU1PVEUgZW5kcG9pbnQuIEl0IGV4aXN0cyBiZWNhdXNlIGEgc3RhdHVzIHN1YmNvbW1hbmRcbiAqICAgY2FuIHJlcG9ydCBhIHNlc3Npb24gaXQgbmV2ZXIgdmFsaWRhdGVkOiBNRUFTVVJFRCAyMDI2LTA5LTAzLCBgY29kZXggbG9naW4gc3RhdHVzYCBwcmludGVkXG4gKiAgIGBMb2dnZWQgaW4gdXNpbmcgQ2hhdEdQVGAgYW5kIGV4aXRlZCAwIGFnYWluc3QgYW4gYXV0aC5qc29uIHdob3NlIGlkX3Rva2VuIHdhcyAzMCBkYXlzXG4gKiAgIGV4cGlyZWQgYW5kIHdob3NlIGFjY2VzcyBhbmQgcmVmcmVzaCB0b2tlbnMgd2VyZSBib3RoIGdhcmJhZ2UuIEEgcHJvYmUgcmVhZGluZyB0aGF0IGxpbmVcbiAqICAgd291bGQgcmV0dXJuIHJlYWR5OnRydWUgZm9yIGEgaG9zdCB0aGF0IGNhbm5vdCBhdXRoZW50aWNhdGUgYXQgYWxsLCB3aGljaCBpcyB0aGUgdW5iYWNrZWRcbiAqICAgYm9vbGVhbiB0aGlzIG1vZHVsZSBleGlzdHMgdG8gcHJldmVudCAoRC0yNjUpLlxuICovXG5leHBvcnQgdHlwZSBXb3Jrc3BhY2VIb3N0QWdlbnRWZXJpZmljYXRpb25LaW5kID1cbiAgfCBcImF1dGhlbnRpY2F0ZWQtYWNjb3VudFwiXG4gIHwgXCJsb2NhbC1pbmZlcmVuY2VcIlxuICB8IFwibGl2ZS1pbmZlcmVuY2VcIjtcblxuLyoqXG4gKiBIb3cgYSBwcm9iZSdzIGV4dHJhY3RlZCBzdWJqZWN0IG1heSBiZSBwdWJsaXNoZWQuXG4gKlxuICogYHJlZGFjdGVkYCBpcyByZXNlcnZlZCBmb3Igb3V0cHV0IHRoZSBUT09MIElUU0VMRiByZWRhY3RlZCAoT01QJ3MgYC0tcmVkYWN0YCk7IGl0IGlzIG5vdCBhXG4gKiBwcm9taXNlIHRoZSBjYWxsZXIgY2FuIG1ha2Ugb24gYSB0b29sJ3MgYmVoYWxmLiBFdmVyeXRoaW5nIGVsc2UgZGlnZXN0cywgYmVjYXVzZSB3ZSBjYW5ub3RcbiAqIGtub3cgd2hldGhlciBhbiBhcmJpdHJhcnkgYWdlbnQgQ0xJIHByaW50cyBhIGZ1bGwgZW1haWwsIGFuIG9yZyBuYW1lLCBvciBhIGtleSBwcmVmaXguXG4gKi9cbmV4cG9ydCB0eXBlIFdvcmtzcGFjZUhvc3RBZ2VudFN1YmplY3REaXNjbG9zdXJlID0gXCJyZWRhY3RlZFwiIHwgXCJkaWdlc3RcIjtcblxuZXhwb3J0IGludGVyZmFjZSBXb3Jrc3BhY2VIb3N0QWdlbnRWZXJpZmljYXRpb25Qcm9iZVNwZWMge1xuICByZWFkb25seSBhZ2VudDogV29ya3NwYWNlSG9zdENhbmFyeUFnZW50O1xuICByZWFkb25seSB2ZXJpZmljYXRpb25LaW5kOiBXb3Jrc3BhY2VIb3N0QWdlbnRWZXJpZmljYXRpb25LaW5kO1xuICAvKiogQWJzb2x1dGUgcGF0aCAob3IgUEFUSC1yZXNvbHZhYmxlIG5hbWUpIG9mIHRoZSBhZ2VudCBDTEkgb24gdGhlIGhvc3QuICovXG4gIHJlYWRvbmx5IGNvbW1hbmQ6IHN0cmluZztcbiAgcmVhZG9ubHkgYXJnczogcmVhZG9ubHkgc3RyaW5nW107XG4gIC8qKiBUaGUgYXV0aGVudGljYXRlZCBzdXJmYWNlIHRoaXMgcHJvYmUgcmVhY2hlczsgcmVjb3JkZWQgYXMgZXZpZGVuY2UsIG5ldmVyIGRlcml2ZWQuICovXG4gIHJlYWRvbmx5IGVuZHBvaW50OiBzdHJpbmc7XG4gIC8qKlxuICAgKiBFeHRyYWN0cyB0aGUgYWNjb3VudC9zdWJqZWN0IGRpc2NyaW1pbmF0b3IgZnJvbSBzdGRvdXQuIFRoZSBGSVJTVCBjYXB0dXJlIGdyb3VwIGlzIHRoZVxuICAgKiBzdWJqZWN0LiBBIHByb2JlIHdob3NlIHBhdHRlcm4gZG9lcyBub3QgbWF0Y2ggaXMgYSBGQUlMRUQgcHJvYmUsIG5vdCBhbiBhdXRoZW50aWNhdGVkIG9uZVxuICAgKiB3aXRoIGFuIHVua25vd24gc3ViamVjdCDigJQgXCJleGl0IDAgYnV0IHVucGFyc2VhYmxlXCIgaXMgdGhlIHNoYXBlIGEgYnJva2VuIG9yIHJld29yZGVkIENMSVxuICAgKiB0YWtlcywgYW5kIHRyZWF0aW5nIGl0IGFzIHN1Y2Nlc3MgaXMgaG93IGFuIHVuYmFja2VkIGJvb2xlYW4gY29tZXMgYmFjay5cbiAgICovXG4gIHJlYWRvbmx5IHByb29mUGF0dGVybjogUmVnRXhwO1xuICByZWFkb25seSBzdWJqZWN0RGlzY2xvc3VyZTogV29ya3NwYWNlSG9zdEFnZW50U3ViamVjdERpc2Nsb3N1cmU7XG4gIHJlYWRvbmx5IHRpbWVvdXRNcz86IG51bWJlcjtcbiAgLyoqXG4gICAqIFdoZXRoZXIgYSBtYXRjaGluZyByZXN1bHQgZnJvbSB0aGlzIHByb2JlIG1heSBtYXJrIHRoZSBhZ2VudCBSRUFEWS4gRGVmYXVsdHMgdG8gdHJ1ZS5cbiAgICpcbiAgICogYGZhbHNlYCBtYWtlcyB0aGUgcHJvYmUgY29udHJpYnV0ZSBTVUJKRUNUIEVWSURFTkNFIE9OTFk6IGl0IHN0aWxsIHJ1bnMsIGFuZCBpdHMgcGFyc2VkXG4gICAqIHN1YmplY3QgaXMgcHVibGlzaGVkIGFzIGBzZWxmUmVwb3J0ZWRTdWJqZWN0RGlnZXN0YCwgYnV0IGl0IGNhbiBuZWl0aGVyIHNldCBgcmVhZHlgIG5vclxuICAgKiBlbmQgdGhlIHByb2JlIGxvb3AuIFVzZSBpdCBmb3IgYW55IHByb2JlIHdob3NlIHByb29mIHRoZSBjcmVkZW50aWFsIGhvbGRlciBjb3VsZCBhdXRob3IuXG4gICAqXG4gICAqIFRoaXMgZXhpc3RzIGJlY2F1c2UgT1JERVJJTkcgY2Fubm90IGV4cHJlc3MgdGhlIGRpc3RpbmN0aW9uIHNhZmVseSAoV0ktMTAwMDE2OTQpLiBUaGUgbG9vcFxuICAgKiBicmVha3Mgb24gdGhlIGZpcnN0IHJlYWR5IHNwZWMsIHNvIGEgZm9yZ2VhYmxlIHByb2JlIHBsYWNlZCBGSVJTVCBzaG9ydC1jaXJjdWl0cyB0aGUgcmVhbFxuICAgKiBvbmU7IGFuZCBwbGFjZWQgU0VDT05EIGl0IHJ1bnMgZXhhY3RseSB3aGVuIHRoZSByZWFsIG9uZSBkaWQgTk9UIHBhc3MsIHNvIGEgZm9yZ2VkXG4gICAqIGNyZWRlbnRpYWwgcGx1cyBhIHRyYW5zaWVudCBlbmRwb2ludCBmYWlsdXJlIHN0aWxsIHJlYWRzIHJlYWR5LiBCb3RoIGFycmFuZ2VtZW50cyBtYWtlXG4gICAqIGZvcmdlcnkgbG9hZC1iZWFyaW5nLiBBIHByb2JlIHRoYXQgY2Fubm90IHNhdGlzZnkgcmVhZGluZXNzIGF0IGFsbCBpcyBzYWZlIGluIEFOWSBwb3NpdGlvbixcbiAgICogd2hpY2ggaXMgd2hhdCB0YWtlcyB0aGUgZGVmZWN0IG91dCBvZiB0aGUgb3JkZXJpbmcgYW5kIG1ha2VzIGl0IHN0cnVjdHVyYWwuXG4gICAqL1xuICByZWFkb25seSBzYXRpc2ZpZXNSZWFkaW5lc3M/OiBib29sZWFuO1xufVxuXG4vKipcbiAqIFRydWUgd2hlbiBhIG1hdGNoaW5nIHJlc3VsdCBmcm9tIHRoaXMgc3BlYyBtYXkgbWFyayB0aGUgYWdlbnQgcmVhZHkuIEFic2VudCBtZWFucyB0cnVlLCBzbyBhXG4gKiBzcGVjIHRoYXQgcHJlZGF0ZXMgdGhlIGZsYWcga2VlcHMgaXRzIG1lYW5pbmc7IGEgcHJvYmUgaXMgb3B0ZWQgT1VUIG9mIHJlYWRpbmVzcyBleHBsaWNpdGx5LlxuICovXG5leHBvcnQgZnVuY3Rpb24gd29ya3NwYWNlSG9zdEFnZW50U3BlY1NhdGlzZmllc1JlYWRpbmVzcyhcbiAgc3BlYzogV29ya3NwYWNlSG9zdEFnZW50VmVyaWZpY2F0aW9uUHJvYmVTcGVjLFxuKTogYm9vbGVhbiB7XG4gIHJldHVybiBzcGVjLnNhdGlzZmllc1JlYWRpbmVzcyAhPT0gZmFsc2U7XG59XG5cbi8qKlxuICogTWF0Y2hlcyBcIjxsYWJlbD48c2VwYXJhdG9yPjxzdWJqZWN0PlwiIGluIGEgc3RhdHVzIGxpbmUsIHdoZXJlIHRoZSBzdWJqZWN0IGlzIGFuIGVtYWlsIG9yIGFcbiAqIGJhcmUgYWNjb3VudCBpZGVudGlmaWVyLlxuICpcbiAqIFRoZSBzZXBhcmF0b3IgY2xhc3MgaXMgYFteQS1aYS16MC05XWAsIE5PVCBgXFxEYC4gYFxcRGAgbWVhbnMgXCJub3QgYSBkaWdpdFwiLCBzbyBpdCBtYXRjaGVzXG4gKiBsZXR0ZXJzIOKAlCBhIGdyZWVkeSBydW4gb2YgaXQgY29uc3VtZXMgdGhlIHN1YmplY3QgYW5kIGJhY2t0cmFja3MgdG8gY2FwdHVyZSBvbmx5IHRoZSB0YWlsXG4gKiAoXCJhaVwiIG9mIFwiY2FuYXJ5QHBhcGVyY3VwLmFpXCIpLCBwcm9kdWNpbmcgYSBzdGFibGUtbG9va2luZyBkaWdlc3Qgb2YgdGhlIHdyb25nIHN0cmluZy4gQSBjbGFzc1xuICogdGhhdCBjYW5ub3QgY29uc3VtZSB0aGUgY2FwdHVyZSdzIG93biBmaXJzdCBjaGFyYWN0ZXIgbWFrZXMgdGhhdCBmYWlsdXJlIGltcG9zc2libGUgcmF0aGVyXG4gKiB0aGFuIG1lcmVseSB1bmxpa2VseS5cbiAqL1xuY29uc3QgU1VCSkVDVF9QQVRURVJOID1cbiAgLyg/OmFjY291bnR8ZW1haWx8b3JnYW5pW3N6XWF0aW9ufG9yZ3xsb2dnZWQgaW4gYXN8c2lnbmVkIGluIGFzKVxcYlteQS1aYS16MC05XXswLDI0fShbQS1aYS16MC05Ll8lKy1dK0BbQS1aYS16MC05Li1dK1xcLltBLVphLXpdezIsfXxbQS1aYS16MC05XVtBLVphLXowLTkuXy1dezIsNjN9KS9pO1xuXG4vKipcbiAqIFRoZSBkZWZhdWx0cywgZ3JvdW5kZWQgaW4gZWFjaCBDTEkncyBvd24gZG9jdW1lbnRlZCBoZWxwIG91dHB1dC5cbiAqXG4gKiBgcHJvb2ZQYXR0ZXJuYCBpcyBkZWxpYmVyYXRlbHkgcGVybWlzc2l2ZSBhYm91dCBzdXJyb3VuZGluZyBwcm9zZSBhbmQgc3RyaWN0IGFib3V0IHRoZSBzaGFwZVxuICogb2YgdGhlIHRoaW5nIGl0IGNhcHR1cmVzLCBiZWNhdXNlIHRoZSBwcm9zZSBpcyB3aGF0IGNodXJucyBiZXR3ZWVuIENMSSByZWxlYXNlcy5cbiAqL1xuZXhwb3J0IGNvbnN0IFdPUktTUEFDRV9IT1NUX09NUF9MT0NBTF9NT0RFTCA9IFwicXdlbjIuNS1jb2RlcjowLjViXCI7XG5leHBvcnQgY29uc3QgV09SS1NQQUNFX0hPU1RfT01QX0xPQ0FMX0lORkVSRU5DRV9NQVJLRVIgPVxuICBcIlAwNDZfT01QX0xPQ0FMX0lORkVSRU5DRV9PS1wiO1xuZXhwb3J0IGNvbnN0IFdPUktTUEFDRV9IT1NUX0NPREVYX0xJVkVfSU5GRVJFTkNFX01BUktFUiA9IFwiUDA0Nl9DT0RFWF9MSVZFX09LXCI7XG5leHBvcnQgY29uc3QgV09SS1NQQUNFX0hPU1RfQ0xBVURFX0xJVkVfSU5GRVJFTkNFX01BUktFUiA9XG4gIFwiUDA0N19DTEFVREVfTElWRV9PS1wiO1xuXG5leHBvcnQgY29uc3QgREVGQVVMVF9XT1JLU1BBQ0VfSE9TVF9BR0VOVF9WRVJJRklDQVRJT05fUFJPQkVTOiBSZWFkb25seTxcbiAgUmVjb3JkPFxuICAgIFdvcmtzcGFjZUhvc3RDYW5hcnlBZ2VudCxcbiAgICByZWFkb25seSBXb3Jrc3BhY2VIb3N0QWdlbnRWZXJpZmljYXRpb25Qcm9iZVNwZWNbXVxuICA+XG4+ID0ge1xuICBjbGF1ZGU6IFtcbiAgICAvLyBXSS0xMDAwMTY4OS4gYGF1dGhlbnRpY2F0ZWQtYWNjb3VudGAgdmlhIGBjbGF1ZGUgYXV0aCBzdGF0dXNgIHdhcyBSRU1PVkVEIGhlcmUgcmF0aGVyIHRoYW5cbiAgICAvLyBrZXB0IGFzIGEgZmlyc3Qgc3BlYyB3aXRoIGxpdmUtaW5mZXJlbmNlIGJlaGluZCBpdCwgYW5kIGJvdGggaGFsdmVzIG9mIHRoYXQgYXJlIGRlbGliZXJhdGUuXG4gICAgLy9cbiAgICAvLyBJdCBjb3VsZCBuZXZlciBQQVNTLiBUaGUgYWdlbnQtaG9tZSBidW5kbGUgc2hpcHMgb25seSBgLmNsYXVkZS8uY3JlZGVudGlhbHMuanNvbmAsIGJ1dCB0aGVcbiAgICAvLyBzdWJqZWN0IHRoYXQgY29tbWFuZCBuYW1lcyBpcyByZWFkIGZyb20gYH4vLmNsYXVkZS5qc29uYCBgb2F1dGhBY2NvdW50LipgLCB3aGljaCB0aGUgYnVuZGxlXG4gICAgLy8gZG9lcyBub3Qgc2hpcCDigJQgbWVhc3VyZWQsIGEgY29uZmlnIGRpciBob2xkaW5nIG9ubHkgdGhlIGNyZWRlbnRpYWxzIGZpbGUgcmVwb3J0c1xuICAgIC8vIGBcImVtYWlsXCI6IG51bGxgIGFuZCBtYXRjaGVzIG5vIHN1YmplY3QsIHNvIGNsYXVkZSBmYWlsZWQgdmVyaWZ5LWluaXRpYWxpemF0aW9uIGZvciBFVkVSWVxuICAgIC8vIGFjY291bnQsIHdoYXRldmVyIGNyZWRlbnRpYWwgd2FzIGRlbGl2ZXJlZC5cbiAgICAvL1xuICAgIC8vIEFuZCBpdCBtdXN0IE5PVCBiZSByZXBhaXJlZCBieSBzaGlwcGluZyB0aGF0IGlkZW50aXR5IGZpbGUsIGJlY2F1c2UgdGhlIGNoZWNrIHByb3ZlcyBub3RoaW5nXG4gICAgLy8gZXZlbiB3aGVuIGl0IGlzIHNhdGlzZmllZDogYGNsYXVkZSBhdXRoIHN0YXR1c2AgbmV2ZXIgY29udGFjdHMgdGhlIGVuZHBvaW50IGl0IGRlY2xhcmVzLlxuICAgIC8vIE1lYXN1cmVkLCBhbiBlbnRpcmVseSBpbnZlbnRlZCBhY2Nlc3MgdG9rZW4gYmVzaWRlIGEgaGFuZC13cml0dGVuIG9hdXRoQWNjb3VudCBibG9ja1xuICAgIC8vIHJlcG9ydGVkIGBhdHRhY2tlckBleGFtcGxlLmludmFsaWRgIC8gYEZhYnJpY2F0ZWQgT3JnYCBhbmQgTUFUQ0hFRCBTVUJKRUNUX1BBVFRFUk4uIFRoZVxuICAgIC8vIHN1YmplY3QgY29tZXMgZnJvbSBhbiBvcmRpbmFyeSB3cml0YWJsZSBKU09OIGZpbGUsIHNvIGFueXRoaW5nIHRoYXQgY2FuIHdyaXRlIHRoZSBhZ2VudCBob21lXG4gICAgLy8gY2FuIG5hbWUgYW55IHN1YmplY3QgaXQgbGlrZXMuIFNoaXBwaW5nIHRoZSBpZGVudGl0eSBmaWxlIHdvdWxkIG9ubHkgaGF2ZSB0dXJuZWQgdGhlIGdhdGVcbiAgICAvLyBncmVlbiB3aGlsZSBsZWF2aW5nIGl0IGZvcmdlYWJsZSwgYW5kIHdvdWxkIGhhdmUgcHV0IGEgcmVhbCBhY2NvdW50J3MgaWRlbnRpdHkgb24gdGhlIGhvc3RcbiAgICAvLyBpbiBvcmRlciB0byBkbyBpdC4gT3JkZXJpbmcgaXQgRklSU1Qgd291bGQgYmUgd29yc2Ugc3RpbGw6IGEgZnV0dXJlIG9hdXRoQWNjb3VudCBmaWxlIHdvdWxkXG4gICAgLy8gc2hvcnQtY2lyY3VpdCB0aGUgcmVhbCBwcm9iZSBhbmQgc2lsZW50bHkgcmVzdG9yZSB0aGUgdmFjdWl0eS5cbiAgICAvL1xuICAgIC8vIFRoaXMgaXMgdGhlIGNvbmNsdXNpb24gdGhlIGNvZGV4IHNwZWMgYmVsb3cgYWxyZWFkeSByZWFjaGVkIGFib3V0IGBjb2RleCBsb2dpbiBzdGF0dXNgXG4gICAgLy8gKFwicHJvdmVzIG5vdGhpbmcgYWJvdXQgd2hldGhlciB0aGUgZGVsaXZlcmVkIGNyZWRlbnRpYWwgYXV0aGVudGljYXRlc1wiKTsgY2xhdWRlIHNpbXBseSBuZXZlclxuICAgIC8vIGdvdCB0aGUgbGl2ZS1pbmZlcmVuY2UgdHJlYXRtZW50IHRoYXQgcmVwbGFjZWQgaXQgdGhlcmUuXG4gICAge1xuICAgICAgYWdlbnQ6IFwiY2xhdWRlXCIsXG4gICAgICB2ZXJpZmljYXRpb25LaW5kOiBcImxpdmUtaW5mZXJlbmNlXCIsXG4gICAgICBjb21tYW5kOiBcImNsYXVkZVwiLFxuICAgICAgLy8gTm8gYC0tbW9kZWxgIGhlcmUsIGZvciB0aGUgcmVhc29uIHRoZSBjb2RleCBzcGVjIGRvY3VtZW50czogYSBtb2RlbC1zcGVjaWZpYyB2YWx1ZSBnb2VzXG4gICAgICAvLyBzdGFsZSB1bmRlciB0aGUgcHJvYmUgYW5kIGZhaWxzIGl0IGZvciBhIE5PTi1jcmVkZW50aWFsIHJlYXNvbi4gYC0tc3RyaWN0LW1jcC1jb25maWdgXG4gICAgICAvLyBrZWVwcyBhIGhvc3QncyBNQ1AgY29uZmlnIG91dCBvZiBhIHJlYWRpbmVzcyBwcm9iZSwgYW5kIGAtLW5vLXNlc3Npb24tcGVyc2lzdGVuY2VgIGtlZXBzXG4gICAgICAvLyB0aGUgcHJvYmUgZnJvbSB3cml0aW5nIHNlc3Npb24gc3RhdGUgaW50byB0aGUgYWdlbnQgaG9tZSBpdCBpcyB2ZXJpZnlpbmcuIFRoaXMgRVhBQ1QgYXJndlxuICAgICAgLy8gd2FzIG1lYXN1cmVkIGFnYWluc3QgYm90aCBhIHJlYWwgYW5kIGEgZmFicmljYXRlZCBjcmVkZW50aWFsIGJlZm9yZSBpdCBzaGlwcGVkLlxuICAgICAgYXJnczogW1xuICAgICAgICBcIi1wXCIsXG4gICAgICAgIFwiLS1zdHJpY3QtbWNwLWNvbmZpZ1wiLFxuICAgICAgICBcIi0tbm8tc2Vzc2lvbi1wZXJzaXN0ZW5jZVwiLFxuICAgICAgICBgUmVwbHkgd2l0aCBleGFjdGx5ICR7V09SS1NQQUNFX0hPU1RfQ0xBVURFX0xJVkVfSU5GRVJFTkNFX01BUktFUn0gYW5kIG5vdGhpbmcgZWxzZS5gLFxuICAgICAgXSxcbiAgICAgIGVuZHBvaW50OiBcImh0dHBzOi8vYXBpLmFudGhyb3BpYy5jb21cIixcbiAgICAgIC8vIE1VTFRJTElORS1BTkNIT1JFRCwgbWlycm9yaW5nIGNvZGV4LiBNZWFzdXJlZCwgYGNsYXVkZSAtcGAgZG9lcyBOT1QgZWNobyB0aGUgcHJvbXB0ICgxXG4gICAgICAvLyBtYXJrZXIgb2NjdXJyZW5jZSBvbiBhIHBhc3NpbmcgcnVuLCB3aGVyZSBjb2RleCBleGVjIHByb2R1Y2VkIDMpLCBzbyB0aGUgYW5jaG9yaW5nIGlzIG5vdFxuICAgICAgLy8gbG9hZC1iZWFyaW5nIFRPREFZLiBJdCBpcyBrZXB0IGJlY2F1c2UgdGhlIGNvZGV4IGNvbW1lbnQgcmVjb3JkcyBleGFjdGx5IHdoYXQgYW5cbiAgICAgIC8vIHVuYW5jaG9yZWQgcGF0dGVybiBjb3N0cyBpZiBhIENMSSBldmVyIHN0YXJ0cyBlY2hvaW5nOiBldmVyeSBjcmVkZW50aWFsIGZhaWx1cmUgcmVhZHMgYXNcbiAgICAgIC8vIHJlYWR5LiBDaGVhcCBpbnN1cmFuY2UgYWdhaW5zdCBhIENMSSByZWxlYXNlIG5vYm9keSBoZXJlIGNvbnRyb2xzLlxuICAgICAgcHJvb2ZQYXR0ZXJuOiBuZXcgUmVnRXhwKFxuICAgICAgICBgXlxcXFxzKigke1dPUktTUEFDRV9IT1NUX0NMQVVERV9MSVZFX0lORkVSRU5DRV9NQVJLRVJ9KVxcXFxzKiRgLFxuICAgICAgICBcIm1cIixcbiAgICAgICksXG4gICAgICBzdWJqZWN0RGlzY2xvc3VyZTogXCJkaWdlc3RcIixcbiAgICAgIHRpbWVvdXRNczogMTgwXzAwMCxcbiAgICB9LFxuICBdLFxuICBjb2RleDogW1xuICAgIHtcbiAgICAgIGFnZW50OiBcImNvZGV4XCIsXG4gICAgICB2ZXJpZmljYXRpb25LaW5kOiBcImF1dGhlbnRpY2F0ZWQtYWNjb3VudFwiLFxuICAgICAgY29tbWFuZDogXCJjb2RleFwiLFxuICAgICAgYXJnczogW1wibG9naW5cIiwgXCJzdGF0dXNcIl0sXG4gICAgICBlbmRwb2ludDogXCJodHRwczovL2FwaS5vcGVuYWkuY29tXCIsXG4gICAgICBwcm9vZlBhdHRlcm46IFNVQkpFQ1RfUEFUVEVSTixcbiAgICAgIHN1YmplY3REaXNjbG9zdXJlOiBcImRpZ2VzdFwiLFxuICAgICAgLy8gV0ktMTAwMDE2OTQsIHN1cGVyc2VkaW5nIEQtMjY1J3Mgb3JkZXJpbmcgcmF0aW9uYWxlLiBNRUFTVVJFRCAyMDI2LTA5LTE3OiBhZ2FpbnN0IGEgZnVsbHlcbiAgICAgIC8vIGZhYnJpY2F0ZWQgYCRDT0RFWF9IT01FL2F1dGguanNvbmAg4oCUIGludmVudGVkIGVtYWlsIGFuZCBhY2NvdW50X2lkLCBwbGFjZWhvbGRlciBhY2Nlc3NcbiAgICAgIC8vIHRva2VuLCBhbiBgYWxnOlJTMjU2YCBzaWduYXR1cmUgbm90aGluZyBzaWduZWQg4oCUIHRoaXMgY29tbWFuZCBwcmludHMgYExvZ2dlZCBpbiB1c2luZ1xuICAgICAgLy8gQ2hhdEdQVGAgYW5kIGV4aXRzIDAuIFRoZSBSRUFMIGNyZWRlbnRpYWwgcHJpbnRzIHRoZSBTQU1FIGxpbmUgYXQgdGhlIHNhbWUgZXhpdCBjb2RlLCBzb1xuICAgICAgLy8gdGhlIG91dHB1dHMgYXJlIGJ5dGUtaWRlbnRpY2FsIGFuZCB0aGlzIHByb2JlIGNhbm5vdCB0ZWxsIGEgZm9yZ2VkIGNyZWRlbnRpYWwgZnJvbSBhIGxpdmVcbiAgICAgIC8vIG9uZS4gKFR3byBjcnVkZXIgYXJtcyBXRVJFIHJlamVjdGVkIGBpbnZhbGlkIElEIHRva2VuIGZvcm1hdGAsIHNvIGNvZGV4IHBhcnNlcyB0aGUgdG9rZW5cbiAgICAgIC8vIHN0cnVjdHVyYWxseSBhbmQgc2ltcGx5IG5ldmVyIHZlcmlmaWVzIGl0LilcbiAgICAgIC8vXG4gICAgICAvLyBJdCBzdXJ2aXZlcywgcmF0aGVyIHRoYW4gYmVpbmcgcmVtb3ZlZCBhcyBjbGF1ZGUncyB3YXMgaW4gV0ktMTAwMDE2ODksIGJlY2F1c2UgaXQgaXMgdGhlXG4gICAgICAvLyBvbmx5IHNpZ25hbCBuYW1pbmcgV0hJQ0ggYWNjb3VudCBhIGhvc3QgYXV0aGVudGljYXRlZCBhcyDigJQgYW5kIGl0IGlzIHNhZmUgdG8ga2VlcCBPTkxZXG4gICAgICAvLyBiZWNhdXNlIGl0IGNhbiBubyBsb25nZXIgZGVjaWRlIHJlYWRpbmVzcy4gV2hhdCBzdG9wcyB0aGUgdmFjdWl0eSBpcyB0aGlzIGZsYWcsIG5vdCB0aGVcbiAgICAgIC8vIGZhY3QgdGhhdCBgTG9nZ2VkIGluIHVzaW5nIENoYXRHUFRgIGhhcHBlbnMgdG8gbWlzcyBTVUJKRUNUX1BBVFRFUk4gdG9kYXk6IHRoYXQgbWlzcyBpcyBhXG4gICAgICAvLyBjb2luY2lkZW5jZSBvZiBvbmUgQ0xJJ3MgY3VycmVudCBvdXRwdXQgc3RyaW5nLCBhbmQgYW55IGF1dGggbW9kZSBvciBmdXR1cmUgcmVsZWFzZSB0aGF0XG4gICAgICAvLyBwcmludHMgYW4gYWNjb3VudCBsaW5lIHdvdWxkIGhhdmUgcmVzdG9yZWQgdGhlIHNob3J0LWNpcmN1aXQgc2lsZW50bHkuXG4gICAgICBzYXRpc2ZpZXNSZWFkaW5lc3M6IGZhbHNlLFxuICAgIH0sXG4gICAgLy8gRC0yNjUsIGFzIGFtZW5kZWQgYnkgV0ktMTAwMDE2OTQ6IHRoaXMgaXMgbm93IGNvZGV4J3MgT05MWSByZWFkaW5lc3MtYmVhcmluZyBwcm9iZSwgbm90IGFcbiAgICAvLyBmYWxsYmFjayBiZWhpbmQgdGhlIGFjY291bnQgcHJvYmUuIEl0IGhhcyB0byBleGlzdCBiZWNhdXNlLCB1bmRlciBDaGF0R1BUIE9BdXRoLFxuICAgIC8vIGBjb2RleCBsb2dpbiBzdGF0dXNgIHByaW50cyBleGFjdGx5IGBMb2dnZWQgaW4gdXNpbmcgQ2hhdEdQVGAg4oCUIG5vIGFjY291bnQsIG5vIGVtYWlsLCBhbmRcbiAgICAvLyBubyBgLS1qc29uYCB0byBhc2sgZm9yIG9uZSDigJQgc28gU1VCSkVDVF9QQVRURVJOIGNhbm5vdCBtYXRjaCBhbmQgY29kZXggY291bGQgbmV2ZXIgcGFzcy5cbiAgICAvL1xuICAgIC8vIFdpZGVuaW5nIFNVQkpFQ1RfUEFUVEVSTiB0byBhY2NlcHQgdGhhdCBsaW5lIHdhcyBSRUpFQ1RFRDogaXQgd291bGQgZGlnZXN0IGEgUFJPVklERVIgbmFtZVxuICAgIC8vIGFzIHRob3VnaCBpdCB3ZXJlIGFuIGFjY291bnQgc3ViamVjdCwgYW5kIOKAlCBtZWFzdXJlZCDigJQgdGhhdCBsaW5lIGlzIHByaW50ZWQgZm9yIGEgMzAtZGF5XG4gICAgLy8gZXhwaXJlZCB0b2tlbiB3aXRoIGdhcmJhZ2UgYWNjZXNzIGFuZCByZWZyZXNoIHRva2VucyB0b28sIHNvIGl0IHByb3ZlcyBub3RoaW5nIGFib3V0XG4gICAgLy8gd2hldGhlciB0aGUgZGVsaXZlcmVkIGNyZWRlbnRpYWwgYXV0aGVudGljYXRlcy5cbiAgICB7XG4gICAgICBhZ2VudDogXCJjb2RleFwiLFxuICAgICAgdmVyaWZpY2F0aW9uS2luZDogXCJsaXZlLWluZmVyZW5jZVwiLFxuICAgICAgY29tbWFuZDogXCJjb2RleFwiLFxuICAgICAgLy8gTm8gYC1jYCBvdmVycmlkZSBpbiB0aGlzIGFyZ3YuIEEgbW9kZWwtc3BlY2lmaWMgdmFsdWUgZ29lcyBzdGFsZSB1bmRlciB0aGUgcHJvYmUgYW5kXG4gICAgICAvLyBmYWlscyBpdCBmb3IgYSBOT04tY3JlZGVudGlhbCByZWFzb246IGAtYyBtb2RlbF9yZWFzb25pbmdfZWZmb3J0PVwibWluaW1hbFwiYCB3YXMgbWVhc3VyZWRcbiAgICAgIC8vIHJldHVybmluZyBIVFRQIDQwMCBgVW5zdXBwb3J0ZWQgdmFsdWU6ICdtaW5pbWFsJyBpcyBub3Qgc3VwcG9ydGVkIHdpdGggdGhlICdncHQtNS42LXNvbCdcbiAgICAgIC8vIG1vZGVsYCwgd2hpY2ggaXMgYSBmYWxzZSBSRUQuIGAtLXNhbmRib3ggcmVhZC1vbmx5YCBpcyBub3Qgc3VjaCBhIHZhbHVlIOKAlCBhIHJlYWRpbmVzc1xuICAgICAgLy8gcHJvYmUgbXVzdCBub3QgbmVlZCB3cml0ZSBhY2Nlc3MsIGFuZCBpdCBtZWFzdXJlZCBjaGVhcGVyICgxNSw4ODMgdnMgMTYsMjY3IHRva2VucykuXG4gICAgICBhcmdzOiBbXG4gICAgICAgIFwiZXhlY1wiLFxuICAgICAgICBcIi0tc2tpcC1naXQtcmVwby1jaGVja1wiLFxuICAgICAgICBcIi0tc2FuZGJveFwiLFxuICAgICAgICBcInJlYWQtb25seVwiLFxuICAgICAgICBgUmVwbHkgd2l0aCBleGFjdGx5ICR7V09SS1NQQUNFX0hPU1RfQ09ERVhfTElWRV9JTkZFUkVOQ0VfTUFSS0VSfSBhbmQgbm90aGluZyBlbHNlLmAsXG4gICAgICBdLFxuICAgICAgZW5kcG9pbnQ6IFwiaHR0cHM6Ly9hcGkub3BlbmFpLmNvbVwiLFxuICAgICAgLy8gTVVMVElMSU5FLUFOQ0hPUkVELCBhbmQgdGhlIGFuY2hvcmluZyBpcyBsb2FkLWJlYXJpbmcgcmF0aGVyIHRoYW4gdGlkeTogY29kZXggZWNob2VzIHRoZVxuICAgICAgLy8gcHJvbXB0LCBzbyB0aGUgbWFya2VyIGFwcGVhcnMgaW4gdGhlIG91dHB1dCBvZiBhIEZBSUxJTkcgcnVuIHRvbyAobWVhc3VyZWQ6IG9uY2UsIGluIHRoZVxuICAgICAgLy8gYFJlcGx5IHdpdGggZXhhY3RseSDigKZgIGxpbmUpLiBBbiB1bmFuY2hvcmVkIHBhdHRlcm4gd291bGQgbWF0Y2ggdGhhdCBlY2hvIGFuZCByZXBvcnRcbiAgICAgIC8vIGV2ZXJ5IGNyZWRlbnRpYWwgZmFpbHVyZSBhcyByZWFkeS4gTWVhc3VyZWQgYm90aCB3YXlzIGFnYWluc3QgcmVhbCBjYXB0dXJlcyDigJQgcG9zaXRpdmVcbiAgICAgIC8vIGV4aXQgMCB3aXRoIDMgb2NjdXJyZW5jZXMgTUFUQ0hFUzsgbmVnYXRpdmUgZXhpdCAxIHdpdGggMSBvY2N1cnJlbmNlIGRvZXMgTk9ULlxuICAgICAgcHJvb2ZQYXR0ZXJuOiBuZXcgUmVnRXhwKFxuICAgICAgICBgXlxcXFxzKigke1dPUktTUEFDRV9IT1NUX0NPREVYX0xJVkVfSU5GRVJFTkNFX01BUktFUn0pXFxcXHMqJGAsXG4gICAgICAgIFwibVwiLFxuICAgICAgKSxcbiAgICAgIHN1YmplY3REaXNjbG9zdXJlOiBcImRpZ2VzdFwiLFxuICAgICAgdGltZW91dE1zOiAxODBfMDAwLFxuICAgIH0sXG4gIF0sXG4gIG9tcDogW1xuICAgIHtcbiAgICAgIGFnZW50OiBcIm9tcFwiLFxuICAgICAgdmVyaWZpY2F0aW9uS2luZDogXCJhdXRoZW50aWNhdGVkLWFjY291bnRcIixcbiAgICAgIGNvbW1hbmQ6IFwib21wXCIsXG4gICAgICBhcmdzOiBbXCJ1c2FnZVwiLCBcIi0tanNvblwiLCBcIi0tcmVkYWN0XCJdLFxuICAgICAgZW5kcG9pbnQ6IFwicGFwZXJjdXNwLW9tcC1icm9rZXJcIixcbiAgICAgIC8vIGAtLXJlZGFjdGAgYWxyZWFkeSByZWR1Y2VzIGFjY291bnQgaWRzIHRvIGEgc2hvcnRlc3QtdW5pcXVlIHByZWZpeCwgc28gdGhlIGNhcHR1cmVkIHZhbHVlXG4gICAgICAvLyBpcyBwdWJsaXNoYWJsZSBhcy1pczsgdGhpcyByZWFkcyB0aGUgZmlyc3QgYWNjb3VudCBpZCBvdXQgb2YgdGhlIEpTT04gcmVwb3J0LlxuICAgICAgcHJvb2ZQYXR0ZXJuOlxuICAgICAgICAvXCIoPzphY2NvdW50fGFjY291bnRJZHxhY2NvdW50X2lkKVwiXFxzKjpcXHMqXCIoW15cIlxcXFxdezEsMTIwfSlcIi8sXG4gICAgICBzdWJqZWN0RGlzY2xvc3VyZTogXCJyZWRhY3RlZFwiLFxuICAgIH0sXG4gICAge1xuICAgICAgYWdlbnQ6IFwib21wXCIsXG4gICAgICB2ZXJpZmljYXRpb25LaW5kOiBcImxvY2FsLWluZmVyZW5jZVwiLFxuICAgICAgY29tbWFuZDogXCJvbXBcIixcbiAgICAgIGFyZ3M6IFtcbiAgICAgICAgXCItLW1vZGVsXCIsXG4gICAgICAgIGBvbGxhbWEvJHtXT1JLU1BBQ0VfSE9TVF9PTVBfTE9DQUxfTU9ERUx9YCxcbiAgICAgICAgXCItLXByaW50XCIsXG4gICAgICAgIFwiLS1uby10b29sc1wiLFxuICAgICAgICBcIi0tbm8tc2Vzc2lvblwiLFxuICAgICAgICBcIi0tbm8tZXh0ZW5zaW9uc1wiLFxuICAgICAgICBcIi0tbm8tc2tpbGxzXCIsXG4gICAgICAgIFwiLS1uby1ydWxlc1wiLFxuICAgICAgICBcIi0tbW9kZVwiLFxuICAgICAgICBcInRleHRcIixcbiAgICAgICAgYFJlcGx5IHdpdGggZXhhY3RseSAke1dPUktTUEFDRV9IT1NUX09NUF9MT0NBTF9JTkZFUkVOQ0VfTUFSS0VSfSBhbmQgbm90aGluZyBlbHNlLmAsXG4gICAgICBdLFxuICAgICAgZW5kcG9pbnQ6IFwiaHR0cDovLzEyNy4wLjAuMToxMTQzNFwiLFxuICAgICAgcHJvb2ZQYXR0ZXJuOiBuZXcgUmVnRXhwKFxuICAgICAgICBgXlxcXFxzKigke1dPUktTUEFDRV9IT1NUX09NUF9MT0NBTF9JTkZFUkVOQ0VfTUFSS0VSfSlcXFxccyokYCxcbiAgICAgICksXG4gICAgICBzdWJqZWN0RGlzY2xvc3VyZTogXCJkaWdlc3RcIixcbiAgICAgIHRpbWVvdXRNczogMTgwXzAwMCxcbiAgICB9LFxuICBdLFxufTtcblxuLyoqXG4gKiBUaGUgdmVyaWZpY2F0aW9uIGtpbmRzIGEgUkVBRFkgdmVyZGljdCBmb3IgYGFnZW50YCBtYXkgbGVnaXRpbWF0ZWx5IGNhcnJ5LCBERVJJVkVEIGZyb20gdGhlXG4gKiBwcm9iZSB0YWJsZSBhYm92ZSByYXRoZXIgdGhhbiByZXN0YXRlZCBieSBlYWNoIGNvbnN1bWVyLlxuICpcbiAqIFdJLTEwMDAyNDAyLiBGb3VyIGNhbGwgc2l0ZXMgaGFkIGVhY2ggaGFuZC1jb3BpZWQgdGhpcyBydWxlIGFzIGEgbGl0ZXJhbFxuICogKGBhdXRoZW50aWNhdGVkLWFjY291bnRgLCBvciBgbG9jYWwtaW5mZXJlbmNlYCB3aGVuIHRoZSBhZ2VudCBpcyBvbXApLCBhbmQgdGhlIGNvcGllcyBoYWRcbiAqIGRyaWZ0ZWQgZnJvbSB0aGUgdGFibGUgdGhleSBkZXNjcmliZSDigJQgaW4gb3Bwb3NpdGUgZGlyZWN0aW9ucywgc28gbm8gdHdvIGFncmVlZDpcbiAqXG4gKiAtIFRocmVlIG9mIHRoZW0gKHRoZSBjYW5hcnkgZXZpZGVuY2UgdmFsaWRhdG9yLCB0aGUgcmVtb3RlIGluaXRpYWxpemVyJ3MgZXZpZGVuY2UgYXNzZW1ibGVyLFxuICogICBhbmQgdGhlIGluaXRpYWxpemF0aW9uIHZlcmlmaWVyKSBkZW1hbmRlZCBgYXV0aGVudGljYXRlZC1hY2NvdW50YCBmb3IgY2xhdWRlLiBDbGF1ZGUncyBzcGVjXG4gKiAgIHNldCBDQU5OT1QgZW1pdCB0aGF0IGtpbmQgYXQgYWxsOiBpdHMgYGF1dGhlbnRpY2F0ZWQtYWNjb3VudGAgcHJvYmUgd2FzIGRlbGliZXJhdGVseSByZW1vdmVkXG4gKiAgIChXSS0xMDAwMTY4OSkgYmVjYXVzZSBpdCBjb3VsZCBuZXZlciBwYXNzIEFORCB3YXMgZm9yZ2VhYmxlIOKAlCBgY2xhdWRlIGF1dGggc3RhdHVzYCByZWFkcyBpdHNcbiAqICAgc3ViamVjdCBmcm9tIGFuIG9yZGluYXJ5IHdyaXRhYmxlIEpTT04gZmlsZSBhbmQgbmV2ZXIgY29udGFjdHMgdGhlIGVuZHBvaW50IGl0IG5hbWVzLCBzbyBhblxuICogICBpbnZlbnRlZCB0b2tlbiBiZXNpZGUgYSBoYW5kLXdyaXR0ZW4gYG9hdXRoQWNjb3VudGAgYmxvY2sgbWF0Y2hlZCBTVUJKRUNUX1BBVFRFUk4uIFRob3NlXG4gKiAgIHRocmVlIHNpdGVzIHRoZXJlZm9yZSByZWplY3RlZCBhIGxpdmUgR0NQIGNhbmFyeSBmb3IgcHJlc2VudGluZyB0aGUgU1RST05HRVIgZXZpZGVuY2UgdGhhdFxuICogICBkZWxpYmVyYXRlbHkgcmVwbGFjZWQgaXQsIGFuZCBubyBjcmVkZW50aWFsIGNvdWxkIGV2ZXIgaGF2ZSBzYXRpc2ZpZWQgdGhlbS5cbiAqIC0gVGhlIGZvdXJ0aCAoYWdlbnQgY3JlZGVudGlhbCBhZG1pc3Npb24pIGFscmVhZHkgYWxsb3dlZCBgbGl2ZS1pbmZlcmVuY2VgIGZvciBub24tb21wIGFnZW50cyxcbiAqICAgd2hpY2ggaXMgd2h5IHRoZSBkaXNhZ3JlZW1lbnQgc3VyZmFjZWQgYSBsYXllciBsYXRlciBpbnN0ZWFkIG9mIGF0IGFkbWlzc2lvbi5cbiAqXG4gKiBEZXJpdmluZyBpdCByZW1vdmVzIHRoZSBjbGFzczogYSBwcm9iZSBhZGRlZCwgcmV0aXJlZCwgb3IgcmUta2V5ZWQgbW92ZXMgZXZlcnkgY29uc3VtZXIgd2l0aFxuICogaXQsIGFuZCBhIHNwZWMgdGhhdCBjYW5ub3QgbWFyayByZWFkaW5lc3MgY2Fubm90IGJlIHByZXNlbnRlZCBhcyByZWFkaW5lc3MgZXZpZGVuY2UuIFJlYWRpbmVzc1xuICogaXMgdGhlIGZpbHRlciAodjQgLyBXSS0xMDAwMTY5NCk6IGNvZGV4J3MgYGF1dGhlbnRpY2F0ZWQtYWNjb3VudGAgcHJvYmUgaXNcbiAqIGBzYXRpc2ZpZXNSZWFkaW5lc3M6IGZhbHNlYCDigJQgaXQgcmVjb3JkcyBXSE8gdGhlIGNyZWRlbnRpYWwgY2xhaW1zIHRvIGJlLCBhbmQgb25seSBhblxuICogaW5mZXJlbmNlIHByb2JlIG1heSBtYXJrIHRoZSBhZ2VudCByZWFkeSDigJQgc28gaXQgaXMgY29ycmVjdGx5IGFic2VudCBmcm9tIHRoaXMgc2V0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gd29ya3NwYWNlSG9zdEFnZW50QWxsb3dlZFZlcmlmaWNhdGlvbktpbmRzKFxuICBhZ2VudDogV29ya3NwYWNlSG9zdENhbmFyeUFnZW50LFxuICBwcm9iZXM6IFJlYWRvbmx5PFxuICAgIFJlY29yZDxcbiAgICAgIFdvcmtzcGFjZUhvc3RDYW5hcnlBZ2VudCxcbiAgICAgIHJlYWRvbmx5IFdvcmtzcGFjZUhvc3RBZ2VudFZlcmlmaWNhdGlvblByb2JlU3BlY1tdXG4gICAgPlxuICA+ID0gREVGQVVMVF9XT1JLU1BBQ0VfSE9TVF9BR0VOVF9WRVJJRklDQVRJT05fUFJPQkVTLFxuKTogUmVhZG9ubHlTZXQ8V29ya3NwYWNlSG9zdEFnZW50VmVyaWZpY2F0aW9uS2luZD4ge1xuICByZXR1cm4gbmV3IFNldChcbiAgICAocHJvYmVzW2FnZW50XSA/PyBbXSlcbiAgICAgIC5maWx0ZXIod29ya3NwYWNlSG9zdEFnZW50U3BlY1NhdGlzZmllc1JlYWRpbmVzcylcbiAgICAgIC5tYXAoKHNwZWMpID0+IHNwZWMudmVyaWZpY2F0aW9uS2luZCksXG4gICk7XG59XG5cbi8qKlxuICogVHJ1ZSB3aGVuIGBraW5kYCBpcyBhIHJlYWRpbmVzcy1jYXBhYmxlIHZlcmlmaWNhdGlvbiBraW5kIGZvciBgYWdlbnRgLlxuICpcbiAqIENvbnN1bWVycyBzaG91bGQgcHJlZmVyIHRoaXMgb3ZlciBhbiBpbmxpbmUgbGl0ZXJhbCBjb21wYXJpc29uOyBzZWVcbiAqIHtAbGluayB3b3Jrc3BhY2VIb3N0QWdlbnRBbGxvd2VkVmVyaWZpY2F0aW9uS2luZHN9IGZvciB3aHkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB3b3Jrc3BhY2VIb3N0QWdlbnRWZXJpZmljYXRpb25LaW5kSXNBbGxvd2VkKFxuICBhZ2VudDogV29ya3NwYWNlSG9zdENhbmFyeUFnZW50LFxuICBraW5kOiB1bmtub3duLFxuICBwcm9iZXM/OiBSZWFkb25seTxcbiAgICBSZWNvcmQ8XG4gICAgICBXb3Jrc3BhY2VIb3N0Q2FuYXJ5QWdlbnQsXG4gICAgICByZWFkb25seSBXb3Jrc3BhY2VIb3N0QWdlbnRWZXJpZmljYXRpb25Qcm9iZVNwZWNbXVxuICAgID5cbiAgPixcbik6IGJvb2xlYW4ge1xuICByZXR1cm4gd29ya3NwYWNlSG9zdEFnZW50QWxsb3dlZFZlcmlmaWNhdGlvbktpbmRzKGFnZW50LCBwcm9iZXMpLmhhcyhcbiAgICBraW5kIGFzIFdvcmtzcGFjZUhvc3RBZ2VudFZlcmlmaWNhdGlvbktpbmQsXG4gICk7XG59XG5cbmV4cG9ydCBjb25zdCBERUZBVUxUX1dPUktTUEFDRV9IT1NUX0FHRU5UX1BST0JFX1RJTUVPVVRfTVMgPSA2MF8wMDA7XG5cbi8qKlxuICogTG9uZ2VzdCBsZWdhbCBkZWZhdWx0IHByb2JlIHNlcXVlbmNlIHdoZW4gZXZlcnkgc3Ryb25nZXIgcHJvYmUgZmFsbHMgdGhyb3VnaC5cbiAqXG4gKiBBZ2VudCBwcm9iZXMgcnVuIHNlcXVlbnRpYWxseSBieSBkZXNpZ24sIGluY2x1ZGluZyB0aGUgMTgwcyBDb2RleCBhbmQgT01QIGluZmVyZW5jZVxuICogZmFsbGJhY2tzLiBUcmFuc3BvcnQgYWRhcHRlcnMgdXNlIHRoaXMgZGVyaXZlZCBidWRnZXQgdG8ga2VlcCB0aGVpciBvd24gb3V0ZXIgZGVhZGxpbmVcbiAqIGZyb20gZXhwaXJpbmcgYmVmb3JlIHRoZSBpbm5lciBjb250cmFjdCBoYXMgaGFkIHRpbWUgdG8gZmluaXNoLlxuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9XT1JLU1BBQ0VfSE9TVF9BR0VOVF9WRVJJRklDQVRJT05fVElNRU9VVF9CVURHRVRfTVMgPVxuICBXT1JLU1BBQ0VfSE9TVF9DQU5BUllfQUdFTlRTLnJlZHVjZShcbiAgICAodG90YWwsIGFnZW50KSA9PlxuICAgICAgdG90YWwgK1xuICAgICAgREVGQVVMVF9XT1JLU1BBQ0VfSE9TVF9BR0VOVF9WRVJJRklDQVRJT05fUFJPQkVTW2FnZW50XS5yZWR1Y2UoXG4gICAgICAgIChhZ2VudFRvdGFsLCBzcGVjKSA9PlxuICAgICAgICAgIGFnZW50VG90YWwgK1xuICAgICAgICAgIChzcGVjLnRpbWVvdXRNcyA/PyBERUZBVUxUX1dPUktTUEFDRV9IT1NUX0FHRU5UX1BST0JFX1RJTUVPVVRfTVMpLFxuICAgICAgICAwLFxuICAgICAgKSxcbiAgICAwLFxuICApO1xuLyoqXG4gKiBCb3VuZGVkIHN0ZGVyciB0YWlsIGtlcHQgd2hpbGUgY2xhc3NpZnlpbmcuIExhcmdlIGVub3VnaCB0aGF0IGEgcmVjb2duaXplZCBwaHJhc2Ugc3BsaXQgYWNyb3NzXG4gKiB0d28gY2h1bmsgYm91bmRhcmllcyBzdGlsbCBtYXRjaGVzLCBzbWFsbCBlbm91Z2ggdGhhdCBub3RoaW5nIGFjY3VtdWxhdGVzLlxuICovXG5jb25zdCBTVERFUlJfQ0xBU1NJRllfV0lORE9XX0JZVEVTID0gNDA5NjtcblxuY29uc3QgTUFYX1BST0JFX09VVFBVVF9CWVRFUyA9IDUxMiAqIDEwMjQ7XG5jb25zdCBNQVhfUFJPQkVfU1RERVJSX0RJQUdOT1NUSUNfQllURVMgPSA2NCAqIDEwMjQ7XG5cbmV4cG9ydCBpbnRlcmZhY2UgV29ya3NwYWNlSG9zdEFnZW50UHJvYmVJbnZvY2F0aW9uIHtcbiAgcmVhZG9ubHkgY29tbWFuZDogc3RyaW5nO1xuICByZWFkb25seSBhcmdzOiByZWFkb25seSBzdHJpbmdbXTtcbiAgcmVhZG9ubHkgdGltZW91dE1zOiBudW1iZXI7XG4gIC8qKiBXaGVuIHN1cHBsaWVkLCB0aGlzIGlzIHRoZSBDT01QTEVURSBjaGlsZCBlbnZpcm9ubWVudCwgbm90IGFuIG92ZXJsYXkgb24gdGhlIHBhcmVudC4gKi9cbiAgcmVhZG9ubHkgZW52PzogUmVhZG9ubHk8UmVjb3JkPHN0cmluZywgc3RyaW5nPj47XG4gIC8qKlxuICAgKiBFeHBsaWNpdCB3b3JraW5nIGRpcmVjdG9yeSBmb3IgY29udHJvbGxlci1zaWRlIGlzb2xhdGVkIHByb2Jlcy5cbiAgICpcbiAgICogSE9NRSBhbG9uZSBkb2VzIG5vdCBjaGFuZ2UgYSBwcm9jZXNzJ3MgY3dkLiBXaXRob3V0IHRoaXMgZmllbGQgYSBwcm9iZSBvdmVyIGEgdGVtcG9yYXJ5XG4gICAqIGNyZWRlbnRpYWwgaG9tZSBjYW4gc3RpbGwgZGlzY292ZXIgcmVwby1sb2NhbCBjb25maWcgZnJvbSB0aGUgY29udHJvbGxlcidzIGluaGVyaXRlZCBjd2QsXG4gICAqIHdoaWNoIG1lYW5zIGl0IGlzIG5vIGxvbmdlciBwcm92aW5nIG9ubHkgdGhlIG1hdGVyaWFsIHRoZSBjYWxsZXIgc3VwcGxpZWQuXG4gICAqL1xuICByZWFkb25seSBjd2Q/OiBzdHJpbmc7XG4gIC8qKiBFeGVjdXRlIHRoZSBwcm9iZSBhcyB0aGlzIHJlYWwgbm9uLXJvb3QgYWNjb3VudCwgbm90IG1lcmVseSB3aXRoIGlkZW50aXR5LXNoYXBlZCBlbnYgdmFycy4gKi9cbiAgcmVhZG9ubHkgcnVuQXNVc2VyPzogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFdvcmtzcGFjZUhvc3RBZ2VudFByb2JlT3V0Y29tZSB7XG4gIHJlYWRvbmx5IGV4aXRDb2RlOiBudW1iZXI7XG4gIC8qKiBDb25zdW1lZCBpbi1wcm9jZXNzIG9ubHkuIEl0IGlzIG5ldmVyIGNvcGllZCBpbnRvIGV2aWRlbmNlLiAqL1xuICByZWFkb25seSBzdGRvdXQ6IHN0cmluZztcbiAgLyoqIE51bWJlciBvZiBzdGRlcnIgYnl0ZXMgb2JzZXJ2ZWQsIHNhdHVyYXRlZCBhdCB0aGUgZGlhZ25vc3RpYyBsaW1pdC4gKi9cbiAgcmVhZG9ubHkgc3RkZXJyQnl0ZUNvdW50PzogbnVtYmVyO1xuICAvKiogVHJ1ZSB3aGVuIHN0ZGVyciBjb250aW51ZWQgYmV5b25kIHRoZSBzYXR1cmF0ZWQgZGlhZ25vc3RpYyBjb3VudC4gKi9cbiAgcmVhZG9ubHkgc3RkZXJyQnl0ZUNvdW50VHJ1bmNhdGVkPzogYm9vbGVhbjtcbiAgLyoqXG4gICAqIEEgQ0xBU1NJRklFRCBjYXVzZSwgd2hlbiB0aGUgcHJvYmUncyBvd24gb3V0cHV0IG5hbWVkIG9uZSDigJQgYSBmaXhlZCByZWFzb24gY29kZSwgbmV2ZXIgdGV4dC5cbiAgICpcbiAgICogVGhlIHJ1bm5lciBtYXRjaGVzIG91dHB1dCBhZ2FpbnN0IGBQUk9CRV9GQUlMVVJFX0NMQVNTSUZJRVJTYCBhbmQga2VlcHMgb25seSB0aGUgcmVzdWx0aW5nXG4gICAqIGVudW0gdmFsdWU7IHRoZSB0ZXh0IHRoYXQgcHJvZHVjZWQgaXQgaXMgZHJvcHBlZCBpbiB0aGUgc2FtZSB0aWNrLiBUaGF0IGlzIHdoYXQgbGV0cyBhXG4gICAqIGRpYWdub3NpcyBzdXJ2aXZlIHdpdGhvdXQgd2Vha2VuaW5nIHRoZSBydWxlIHRoYXQgQ0xJIG91dHB1dCBuZXZlciByZWFjaGVzIGV2aWRlbmNlLlxuICAgKi9cbiAgcmVhZG9ubHkgZmFpbHVyZUhpbnQ/OiBXb3Jrc3BhY2VIb3N0QWdlbnRQcm9iZUZhaWx1cmVSZWFzb247XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgV29ya3NwYWNlSG9zdEFnZW50UHJvYmVSdW5uZXIge1xuICBydW4oXG4gICAgaW52b2NhdGlvbjogV29ya3NwYWNlSG9zdEFnZW50UHJvYmVJbnZvY2F0aW9uLFxuICApOiBQcm9taXNlPFdvcmtzcGFjZUhvc3RBZ2VudFByb2JlT3V0Y29tZT47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgV29ya3NwYWNlSG9zdEFnZW50UHJvYmVQcm9jZXNzIHtcbiAgcmVhZG9ubHkgY29tbWFuZDogc3RyaW5nO1xuICByZWFkb25seSBhcmdzOiByZWFkb25seSBzdHJpbmdbXTtcbiAgcmVhZG9ubHkgZW52PzogUmVhZG9ubHk8UmVjb3JkPHN0cmluZywgc3RyaW5nPj47XG4gIHJlYWRvbmx5IGN3ZD86IHN0cmluZztcbn1cblxuY29uc3QgV09SS1NQQUNFX0hPU1RfUFJPQkVfUlVOVVNFUiA9IFwiL3Vzci9zYmluL3J1bnVzZXJcIjtcbmNvbnN0IFdPUktTUEFDRV9IT1NUX1BST0JFX0VOViA9IFwiL3Vzci9iaW4vZW52XCI7XG5jb25zdCBXT1JLU1BBQ0VfSE9TVF9QUk9CRV9MQVVOQ0hfUEFUSCA9IFwiL3Vzci9zYmluOi91c3IvYmluOi9zYmluOi9iaW5cIjtcbmNvbnN0IFdPUktTUEFDRV9IT1NUX1BST0JFX0FDQ09VTlQgPSAvXlthLXpfXVthLXowLTlfLV17MCwzMH0kLztcbmNvbnN0IFdPUktTUEFDRV9IT1NUX1BST0JFX0VOVl9OQU1FID0gL15bQS1aYS16X11bQS1aYS16MC05X10qJC87XG5cbi8qKlxuICogQnVpbGQgdGhlIGV4YWN0IHByb2Nlc3MgYm91bmRhcnkgZm9yIGEgcHJvYmUuXG4gKlxuICogYEhPTUVgL2BVU0VSYCBhbG9uZSBkbyBub3QgY2hhbmdlIGEgVW5peCBpZGVudGl0eS4gUHJvZHVjdGlvbiBwcm9iZXMgZW50ZXIgdGhyb3VnaCBhIHJvb3Qtb3duZWRcbiAqIGluaXRpYWxpemVyLCBzbyB0aGUgcnVubmVyIG11c3QgZHJvcCB0byB0aGUgd29ya3NwYWNlIGFjY291bnQgYmVmb3JlIHRoZSBDTEkgcmVhZHMgaXRzIDA2MDBcbiAqIGZpbGVzLiBgZW52IC1pYCB0aGVuIGdpdmVzIHRoYXQgYWNjb3VudCB0aGUgY2FsbGVyJ3MgY29tcGxldGUgYWxsb3dsaXN0ZWQgZW52aXJvbm1lbnQgYW5kIG1ha2VzXG4gKiBhbWJpZW50IGNvbnRyb2xsZXIvc2VydmljZSBjcmVkZW50aWFscyB1bmF2YWlsYWJsZSBldmVuIGlmIFBBTSBvciBydW51c2VyIHdvdWxkIHByZXNlcnZlIHRoZW0uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWlsZFdvcmtzcGFjZUhvc3RBZ2VudFByb2JlUHJvY2VzcyhcbiAgaW52b2NhdGlvbjogV29ya3NwYWNlSG9zdEFnZW50UHJvYmVJbnZvY2F0aW9uLFxuKTogV29ya3NwYWNlSG9zdEFnZW50UHJvYmVQcm9jZXNzIHtcbiAgaWYgKFxuICAgIGludm9jYXRpb24uY3dkICE9PSB1bmRlZmluZWQgJiZcbiAgICAoIWlzQWJzb2x1dGUoaW52b2NhdGlvbi5jd2QpIHx8XG4gICAgICBub3JtYWxpemUoaW52b2NhdGlvbi5jd2QpICE9PSBpbnZvY2F0aW9uLmN3ZCB8fFxuICAgICAgY29udGFpbnNDb250cm9sQ2hhcmFjdGVyKGludm9jYXRpb24uY3dkKSlcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJhZ2VudCBhdXRoZW50aWNhdGlvbiBwcm9iZSBjd2QgbXVzdCBiZSBhbiBhYnNvbHV0ZSBjYW5vbmljYWwgcGF0aCBmcmVlIG9mIGNvbnRyb2wgY2hhcmFjdGVyc1wiLFxuICAgICk7XG4gIH1cbiAgaWYgKCFpbnZvY2F0aW9uLnJ1bkFzVXNlcikge1xuICAgIHJldHVybiB7XG4gICAgICBjb21tYW5kOiBpbnZvY2F0aW9uLmNvbW1hbmQsXG4gICAgICBhcmdzOiBpbnZvY2F0aW9uLmFyZ3MsXG4gICAgICAuLi4oaW52b2NhdGlvbi5lbnYgPyB7IGVudjogaW52b2NhdGlvbi5lbnYgfSA6IHt9KSxcbiAgICAgIC4uLihpbnZvY2F0aW9uLmN3ZCA/IHsgY3dkOiBpbnZvY2F0aW9uLmN3ZCB9IDoge30pLFxuICAgIH07XG4gIH1cbiAgaWYgKFxuICAgICFXT1JLU1BBQ0VfSE9TVF9QUk9CRV9BQ0NPVU5ULnRlc3QoaW52b2NhdGlvbi5ydW5Bc1VzZXIpIHx8XG4gICAgaW52b2NhdGlvbi5ydW5Bc1VzZXIgPT09IFwicm9vdFwiXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiYWdlbnQgYXV0aGVudGljYXRpb24gcHJvYmUgcnVuQXNVc2VyIG11c3QgYmUgYSBub24tcm9vdCBMaW51eCBhY2NvdW50XCIsXG4gICAgKTtcbiAgfVxuICBpZiAoIWludm9jYXRpb24uZW52KSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJhZ2VudCBhdXRoZW50aWNhdGlvbiBwcm9iZSBydW5Bc1VzZXIgcmVxdWlyZXMgYSBjb21wbGV0ZSBlbnZpcm9ubWVudFwiLFxuICAgICk7XG4gIH1cbiAgY29uc3QgYWdlbnRIb21lID0gaW52b2NhdGlvbi5lbnYuSE9NRTtcbiAgaWYgKCFhZ2VudEhvbWU/LnN0YXJ0c1dpdGgoXCIvXCIpIHx8IGNvbnRhaW5zQ29udHJvbENoYXJhY3RlcihhZ2VudEhvbWUpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJhZ2VudCBhdXRoZW50aWNhdGlvbiBwcm9iZSBydW5Bc1VzZXIgcmVxdWlyZXMgYW4gYWJzb2x1dGUgSE9NRVwiLFxuICAgICk7XG4gIH1cbiAgY29uc3QgZW52aXJvbm1lbnQgPSBPYmplY3QuZW50cmllcyhpbnZvY2F0aW9uLmVudikubWFwKChba2V5LCB2YWx1ZV0pID0+IHtcbiAgICBpZiAoIVdPUktTUEFDRV9IT1NUX1BST0JFX0VOVl9OQU1FLnRlc3Qoa2V5KSB8fCAvXFwwLy50ZXN0KHZhbHVlKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcImFnZW50IGF1dGhlbnRpY2F0aW9uIHByb2JlIGVudmlyb25tZW50IGlzIG5vdCBzYWZlIGZvciBlbnYgLWlcIixcbiAgICAgICk7XG4gICAgfVxuICAgIHJldHVybiBgJHtrZXl9PSR7dmFsdWV9YDtcbiAgfSk7XG4gIHJldHVybiB7XG4gICAgY29tbWFuZDogV09SS1NQQUNFX0hPU1RfUFJPQkVfUlVOVVNFUixcbiAgICAvLyBTU0ggZW50ZXJzIGl0cyBvd24gMDcwMCBob21lLiBTd2l0Y2hpbmcgaWRlbnRpdHkgZG9lcyBub3QgY2hhbmdlIGN3ZDtcbiAgICAvLyBhZ2VudHMgbXVzdCBzdGFydCBpbnNpZGUgdGhlIGhvbWUgdGhlaXIgY3JlZGVudGlhbCBiaW5kaW5nIGFjdHVhbGx5IG93bnMuXG4gICAgY3dkOiBpbnZvY2F0aW9uLmN3ZCA/PyBhZ2VudEhvbWUsXG4gICAgYXJnczogW1xuICAgICAgXCItLXVzZXJcIixcbiAgICAgIGludm9jYXRpb24ucnVuQXNVc2VyLFxuICAgICAgXCItLVwiLFxuICAgICAgV09SS1NQQUNFX0hPU1RfUFJPQkVfRU5WLFxuICAgICAgXCItaVwiLFxuICAgICAgXCItLVwiLFxuICAgICAgLi4uZW52aXJvbm1lbnQsXG4gICAgICBpbnZvY2F0aW9uLmNvbW1hbmQsXG4gICAgICAuLi5pbnZvY2F0aW9uLmFyZ3MsXG4gICAgXSxcbiAgICAvLyBUaGlzIGVudmlyb25tZW50IGJlbG9uZ3Mgb25seSB0byB0aGUgdHJ1c3RlZCBydW51c2VyIGxhdW5jaGVyLiBUaGUgdGFyZ2V0IHJlY2VpdmVzIHRoZVxuICAgIC8vIGV4YWN0IGFsbG93bGlzdCBhYm92ZSBhZnRlciBlbnYgLWk7IG5vdGhpbmcgZnJvbSB0aGUgaW5pdGlhbGl6ZXIgcHJvY2VzcyBpcyBpbmhlcml0ZWQuXG4gICAgZW52OiB7IFBBVEg6IFdPUktTUEFDRV9IT1NUX1BST0JFX0xBVU5DSF9QQVRIIH0sXG4gIH07XG59XG5cbi8qKiBQdWJsaWMsIHNlY3JldC1pc29sYXRlZCBldmlkZW5jZSBmb3Igb25lIGFnZW50LiAqL1xuZXhwb3J0IGludGVyZmFjZSBXb3Jrc3BhY2VIb3N0QWdlbnRWZXJpZmljYXRpb25FdmlkZW5jZSB7XG4gIHJlYWRvbmx5IGNvbnRyYWN0VmVyc2lvbjogdHlwZW9mIFdPUktTUEFDRV9IT1NUX0FHRU5UX1ZFUklGSUNBVElPTl9DT05UUkFDVF9WRVJTSU9OO1xuICByZWFkb25seSBhZ2VudDogV29ya3NwYWNlSG9zdENhbmFyeUFnZW50O1xuICByZWFkb25seSByZWFkeTogYm9vbGVhbjtcbiAgcmVhZG9ubHkgdmVyaWZpY2F0aW9uS2luZDogV29ya3NwYWNlSG9zdEFnZW50VmVyaWZpY2F0aW9uS2luZDtcbiAgcmVhZG9ubHkgZW5kcG9pbnQ6IHN0cmluZztcbiAgcmVhZG9ubHkgZXhpdFN0YXR1czogbnVtYmVyO1xuICByZWFkb25seSBvYnNlcnZlZEF0OiBzdHJpbmc7XG4gIC8qKiBCb3VuZGVkIHN0ZGVyciB2b2x1bWUgb24gZmFpbHVyZTsgdGhlIGJ5dGVzIHRoZW1zZWx2ZXMgYXJlIG5ldmVyIHJldGFpbmVkIG9yIHB1Ymxpc2hlZC4gKi9cbiAgcmVhZG9ubHkgc3RkZXJyQnl0ZUNvdW50PzogbnVtYmVyO1xuICByZWFkb25seSBzdGRlcnJCeXRlQ291bnRUcnVuY2F0ZWQ/OiBib29sZWFuO1xuICAvKiogUHJlc2VudCBvbmx5IGZvciBhIGByZWRhY3RlZGAgcHJvYmU7IHRoZSB0b29sIHByb2R1Y2VkIHRoZSByZWRhY3Rpb24sIG5vdCB1cy4gKi9cbiAgcmVhZG9ubHkgc3ViamVjdD86IHN0cmluZztcbiAgLyoqIEFsd2F5cyBwcmVzZW50IG9uIGEgc3VjY2Vzc2Z1bCBwcm9iZTogYSBzdGFibGUgZGlnZXN0IG9mIHRoZSBwYXJzZWQgcHJvb2YgdmFsdWUuICovXG4gIHJlYWRvbmx5IHByb29mRGlnZXN0Pzogc3RyaW5nO1xuICAvKipcbiAgICogVGhlIHN1YmplY3QgYSBgc2F0aXNmaWVzUmVhZGluZXNzOiBmYWxzZWAgcHJvYmUgcmVwb3J0ZWQsIGRpZ2VzdGVkIOKAlCBTRUxGLVJFUE9SVEVEIEFORFxuICAgKiBVTlZFUklGSUVELCBhbmQgbmFtZWQgdGhhdCB3YXkgc28gbm8gcmVhZGVyIGNhbiBtaXN0YWtlIGl0IGZvciBhIHByb3ZlbiBpZGVudGl0eS5cbiAgICpcbiAgICogSXQgaXMgZGVsaWJlcmF0ZWx5IGEgU0VQQVJBVEUgZmllbGQgZnJvbSBgc3ViamVjdGAvYHByb29mRGlnZXN0YCByYXRoZXIgdGhhbiBhIGZsYWcgYmVzaWRlXG4gICAqIHRoZW0uIFRob3NlIHR3byBhcmUgcG9wdWxhdGVkIGJ5IHRoZSBwcm9iZSB0aGF0IGRlY2lkZWQgYHJlYWR5YDsgdGhpcyBvbmUgaXMgcG9wdWxhdGVkIGJ5IGFcbiAgICogcHJvYmUgdGhhdCBpcyBub3QgYWxsb3dlZCB0byBkZWNpZGUgYW55dGhpbmcuIE1lYXN1cmVkIDIwMjYtMDktMTcgKFdJLTEwMDAxNjk0KTogYSBmdWxseVxuICAgKiBmYWJyaWNhdGVkIGNvZGV4IGBhdXRoLmpzb25gIG1ha2VzIGBjb2RleCBsb2dpbiBzdGF0dXNgIHByaW50IG91dHB1dCBCWVRFLUlERU5USUNBTCB0byB0aGVcbiAgICogcmVhbCBjcmVkZW50aWFsJ3MsIHNvIGFueSB2YWx1ZSBkZXJpdmVkIGZyb20gaXQgaXMgYW4gdW52ZXJpZmlhYmxlIGNsYWltLiBJdHMgcHJlc2VuY2Ugc2F5c1xuICAgKiB0aGUgQ0xJIG5hbWVkIGEgc3ViamVjdDsgaXQgbmV2ZXIgc2F5cyB0aGUgY3JlZGVudGlhbCBhdXRoZW50aWNhdGVzLiBSZWFkIGByZWFkeWAgZm9yIHRoYXQuXG4gICAqL1xuICByZWFkb25seSBzZWxmUmVwb3J0ZWRTdWJqZWN0RGlnZXN0Pzogc3RyaW5nO1xuICByZWFkb25seSBzdWJqZWN0RGlzY2xvc3VyZTogV29ya3NwYWNlSG9zdEFnZW50U3ViamVjdERpc2Nsb3N1cmU7XG4gIC8qKiBQb3B1bGF0ZWQgb25seSBvbiBmYWlsdXJlLCBhbmQgb25seSB3aXRoIGEgZml4ZWQgcmVhc29uIGNvZGUg4oCUIG5ldmVyIENMSSBvdXRwdXQuICovXG4gIHJlYWRvbmx5IGZhaWx1cmU/OiBXb3Jrc3BhY2VIb3N0QWdlbnRQcm9iZUZhaWx1cmVSZWFzb247XG59XG5cbmV4cG9ydCB0eXBlIFdvcmtzcGFjZUhvc3RBZ2VudFByb2JlRmFpbHVyZVJlYXNvbiA9XG4gIHwgXCJub24temVyby1leGl0XCJcbiAgfCBcIm5vLXZlcmlmaWNhdGlvbi1wcm9vZlwiXG4gIHwgXCJwcm9iZS1lcnJvclwiXG4gIHwgXCJjcmVkZW50aWFsLXJldm9rZWRcIlxuICB8IFwiY3JlZGVudGlhbC1tYWxmb3JtZWRcIlxuICB8IFwiY3JlZGVudGlhbC11bmF1dGhvcml6ZWRcIlxuICB8IFwicHJvdmlkZXItdXNhZ2UtbGltaXRcIjtcblxuLyoqXG4gKiBGaXhlZCBwYXR0ZXJucyB0aGF0IHR1cm4gYSBwcm9iZSdzIG93biBmYWlsdXJlIG91dHB1dCBpbnRvIGEgUkVBU09OIENPREUuXG4gKlxuICogV2h5IHRoaXMgZXhpc3RzOiBhIG1ldGVyZWQgdGhpcmQtcGFydHkgYWNjb3VudCB0aGF0IGhhcyBydW4gb3V0IG9mIHF1b3RhIGZhaWxzIGEgcHJvYmUgaW4gYSB3YXlcbiAqIHRoYXQgaXMgaW5kaXN0aW5ndWlzaGFibGUsIGZyb20gZXZpZGVuY2UgYWxvbmUsIGZyb20gYSBicm9rZW4gY3JlZGVudGlhbC4gTUVBU1VSRUQgMjAyNi0wOS0wNFxuICogKFdJLTIxNDQwMzQpOiBgY29kZXggZXhlY2AgcHJpbnRlZCBgWW91J3ZlIGhpdCB5b3VyIHVzYWdlIGxpbWl0YCBhbmQgKipleGl0ZWQgMCoqLCBzbyB0aGUgcHJvYmVcbiAqIHJlY29yZGVkIGBuby12ZXJpZmljYXRpb24tcHJvb2ZgIOKAlCBhIGNvZGUgdGhhdCBzYXlzIFwidGhlIG1hcmtlciB3YXMgYWJzZW50XCIgYW5kIHBvaW50cyBldmVyeVxuICogcmVhZGVyIGF0IHRoZSBjcmVkZW50aWFscy4gRGlhZ25vc2luZyB0aGF0IGNvc3QgdHdvIEdDUCBjYW5hcmllcyBhbmQgbW9zdCBvZiB0d28gc2Vzc2lvbnM7IHRoZVxuICogb25lIGxpbmUgdGhhdCBleHBsYWluZWQgaXQgd2VudCB0byBzdGRlcnIsIHdoaWNoIHRoaXMgbW9kdWxlIGRyYWlucyBhbmQgZGlzY2FyZHMgb24gcHVycG9zZS5cbiAqXG4gKiBUaGUgaXNvbGF0aW9uIHJ1bGUgaXMgdW5jaGFuZ2VkIGFuZCBkZWxpYmVyYXRlbHkgc286IG1hdGNoaW5nIGhhcHBlbnMgaW4tcHJvY2VzcywgdGhlIG1hdGNoZWRcbiAqIHRleHQgaXMgZHJvcHBlZCBpbiB0aGUgc2FtZSB0aWNrLCBhbmQgb25seSB0aGUgZW51bSB2YWx1ZSBiZWxvdyBjYW4gbGVhdmUuIEEgY2xhc3NpZmllciBtYXlcbiAqIHRoZXJlZm9yZSBuZXZlciBjYXB0dXJlIGEgZ3JvdXAgb3IgaW50ZXJwb2xhdGUgd2hhdCBpdCBtYXRjaGVkIOKAlCB0aGF0IHdvdWxkIGJlIGEgcm91dGUgZm9yIENMSVxuICogdGV4dCB0byByZWFjaCBldmlkZW5jZSwgd2hpY2ggaXMgZXhhY3RseSB3aGF0IGBmYWlsdXJlYCBmb3JiaWRzLlxuICpcbiAqIEtlZXAgdGhlc2UgcGF0dGVybnMgbmFycm93IGFuZCBwcm92aWRlci1hZ25vc3RpYyBpbiB3b3JkaW5nLiBBIHBhdHRlcm4gdGhhdCBtYXRjaGVkIGJyb2FkbHlcbiAqIHdvdWxkIHJlbGFiZWwgb3JkaW5hcnkgY3JlZGVudGlhbCBmYWlsdXJlcyBhcyBxdW90YSBleGhhdXN0aW9uLCB3aGljaCBpcyB0aGUgbW9yZSBkYW5nZXJvdXNcbiAqIGVycm9yOiBpdCB3b3VsZCBzZW5kIGEgcmVhZGVyIHRvIHRoZSBiaWxsaW5nIHBhZ2Ugd2hpbGUgdGhlIHJlYWwgZmF1bHQgaXMgYW4gZXhwaXJlZCB0b2tlbi5cbiAqL1xuY29uc3QgUFJPQkVfRkFJTFVSRV9DTEFTU0lGSUVSUzogcmVhZG9ubHkge1xuICByZWFkb25seSBwYXR0ZXJuOiBSZWdFeHA7XG4gIHJlYWRvbmx5IHJlYXNvbjogV29ya3NwYWNlSG9zdEFnZW50UHJvYmVGYWlsdXJlUmVhc29uO1xufVtdID0gW1xuICAvLyBNZWFzdXJlZCByNyBmYWlsdXJlOiByZXRhaW4gdGhlIGNhdXNlIHdoaWxlIGRpc2NhcmRpbmcgYWxsIGNyZWRlbnRpYWwgdGV4dC5cbiAgeyBwYXR0ZXJuOiAvXFxicmVmcmVzaCB0b2tlbiB3YXMgcmV2b2tlZFxcYi9pLCByZWFzb246IFwiY3JlZGVudGlhbC1yZXZva2VkXCIgfSxcbiAgLy8gTWVhc3VyZWQgMjAyNi0wOS0xMSAoUC0zMDUgRzYgcm9vdCBjYXVzZSk6IGEgZGVsaXZlcmVkIGF1dGguanNvbiB0aGUgQ0xJIGNhbm5vdCBkZXNlcmlhbGl6ZVxuICAvLyBwcmludHMgc2VyZGUncyBgbWlzc2luZyBmaWVsZCBcXGA8bmFtZT5cXGBgIGFuZCBleGl0cyAxIOKAlCBhIE1BTEZPUk1FRCBnZW5lcmF0aW9uLCBub3QgYVxuICAvLyByZXZva2VkIG9yIGV4aGF1c3RlZCBvbmUuIE5hbWUgaXQsIHNvIHRoZSByZWFkZXIgaXMgc2VudCB0byB0aGUgcHJvamVjdGlvbiwgbm90IHRoZSBhY2NvdW50LlxuICB7IHBhdHRlcm46IC9cXGJtaXNzaW5nIGZpZWxkXFxiL2ksIHJlYXNvbjogXCJjcmVkZW50aWFsLW1hbGZvcm1lZFwiIH0sXG4gIC8vIFRoZSBwcm92aWRlciByZWZ1c2VkIHRoZSBpZGVudGl0eSBvdXRyaWdodCAoY29kZXggZXhlYyBzZW5kcyBubyBiZWFyZXIgd2hlbiBhdXRoLmpzb24gZGlkXG4gIC8vIG5vdCBwYXJzZTsgYW4gZXhwaXJlZC9mb3JlaWduIGFjY2VzcyB0b2tlbiBsYW5kcyBoZXJlIHRvbykuIERpc3RpbmN0IGZyb20gcXVvdGEsIHdoaWNoXG4gIC8vIHJlcXVpcmVzIGFuIEFDQ0VQVEVEIGlkZW50aXR5IHRvIGJlIHJlcG9ydGVkIGF0IGFsbC5cbiAgeyBwYXR0ZXJuOiAvXFxiNDAxIHVuYXV0aG9yaXplZFxcYi9pLCByZWFzb246IFwiY3JlZGVudGlhbC11bmF1dGhvcml6ZWRcIiB9LFxuICAvLyBDbGF1ZGUncyBleGhhdXN0aW9uIG5hbWVzIHRoZSB3aW5kb3cgaW5zdGVhZCBvZiBzYXlpbmcgXCJ1c2FnZVwiOiB3ZWVrbHkgKFAtMzE4KSBhbmQgdGhlIDUtaG91clxuICAvLyBzZXNzaW9uIHdpbmRvdywgbWVhc3VyZWQgMjAyNi0xMC0wNyAoV0ktMTAwMDcwNDMpIGFzIGBZb3UndmUgaGl0IHlvdXIgc2Vzc2lvbiBsaW1pdCDCtyByZXNldHNcbiAgLy8gMTFwbSAoQW1lcmljYS9OZXdfWW9yaylgIG9uIHN0ZG91dCB3aXRoIGV4aXQgMSwgd2hpY2ggd2FzIHJlcG9ydGVkIGFzIGEgYmFyZSBub24temVyby1leGl0LlxuICB7IHBhdHRlcm46IC9cXGJoaXQgeW91ciAoPzp1c2FnZXx3ZWVrbHl8c2Vzc2lvbikgbGltaXRcXGIvaSwgcmVhc29uOiBcInByb3ZpZGVyLXVzYWdlLWxpbWl0XCIgfSxcbiAgeyBwYXR0ZXJuOiAvXFxidXNhZ2UgbGltaXQgcmVhY2hlZFxcYi9pLCByZWFzb246IFwicHJvdmlkZXItdXNhZ2UtbGltaXRcIiB9LFxuICB7IHBhdHRlcm46IC9cXGJxdW90YSBleGNlZWRlZFxcYi9pLCByZWFzb246IFwicHJvdmlkZXItdXNhZ2UtbGltaXRcIiB9LFxuICB7IHBhdHRlcm46IC9cXGJpbnN1ZmZpY2llbnRfcXVvdGFcXGIvaSwgcmVhc29uOiBcInByb3ZpZGVyLXVzYWdlLWxpbWl0XCIgfSxcbiAgeyBwYXR0ZXJuOiAvXFxicmF0ZSBsaW1pdCBleGNlZWRlZFxcYi9pLCByZWFzb246IFwicHJvdmlkZXItdXNhZ2UtbGltaXRcIiB9LFxuXTtcblxuLyoqXG4gKiBSZWR1Y2UgcHJvYmUgb3V0cHV0IHRvIGEgZml4ZWQgcmVhc29uIGNvZGUsIG9yIHVuZGVmaW5lZCB3aGVuIG5vdGhpbmcgaXMgcmVjb2duaXplZC5cbiAqXG4gKiBSZXR1cm5zIG9ubHkgYSB2YWx1ZSBmcm9tIHRoZSBjbG9zZWQgdW5pb24gYWJvdmU7IHRoZSBpbnB1dCBzdHJpbmcgaXMgbmV2ZXIgcmV0YWluZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjbGFzc2lmeVdvcmtzcGFjZUhvc3RBZ2VudFByb2JlRmFpbHVyZShcbiAgb3V0cHV0OiBzdHJpbmcsXG4pOiBXb3Jrc3BhY2VIb3N0QWdlbnRQcm9iZUZhaWx1cmVSZWFzb24gfCB1bmRlZmluZWQge1xuICBmb3IgKGNvbnN0IGNsYXNzaWZpZXIgb2YgUFJPQkVfRkFJTFVSRV9DTEFTU0lGSUVSUykge1xuICAgIGlmIChjbGFzc2lmaWVyLnBhdHRlcm4udGVzdChvdXRwdXQpKSByZXR1cm4gY2xhc3NpZmllci5yZWFzb247XG4gIH1cbiAgcmV0dXJuIHVuZGVmaW5lZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHdvcmtzcGFjZUhvc3RBZ2VudFN1YmplY3REaWdlc3Qoc3ViamVjdDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGNyZWF0ZUhhc2goXCJzaGEyNTZcIikudXBkYXRlKHN1YmplY3QpLmRpZ2VzdChcImhleFwiKS5zbGljZSgwLCAxNik7XG59XG5cbi8qKlxuICogTm9kZSBydW5uZXI6IGNsb3NlcyBzdGRpbiBzbyBhbiBpbnRlcmFjdGl2ZSBwcm9tcHQgY2Fubm90IGJsb2NrLCBib3VuZHMgdGhlIG91dHB1dCwgYW5kIGtpbGxzXG4gKiB0aGUgdHJlZSBvbiB0aW1lb3V0LlxuICpcbiAqIENsb3Npbmcgc3RkaW4gaXMgdGhlIGxvYWQtYmVhcmluZyBwYXJ0LiBBIENMSSB0aGF0IGRlY2lkZXMgdG8gcHJvbXB0IGZvciBhIGxvZ2luIGZpbmRzIEVPRiBhbmRcbiAqIGV4aXRzIG5vbi16ZXJvIGluc3RlYWQgb2YgaGFuZ2luZyB1bnRpbCB0aGUgdGltZW91dCwgc28gXCJub2JvZHkgaXMgc2lnbmVkIGluXCIgaXMgcmVwb3J0ZWQgYXMgYVxuICogY2xlYW4gZmFpbHVyZSByYXRoZXIgdGhhbiBhcyBhIHByb2JlIHRoYXQgbXlzdGVyaW91c2x5IHRvb2sgYSBtaW51dGUuXG4gKi9cbmV4cG9ydCBjbGFzcyBOb2RlV29ya3NwYWNlSG9zdEFnZW50UHJvYmVSdW5uZXIgaW1wbGVtZW50cyBXb3Jrc3BhY2VIb3N0QWdlbnRQcm9iZVJ1bm5lciB7XG4gIC8vIEtlZXAgdGhlIGNoaWxkLXByb2Nlc3MgYm91bmRhcnkgaW5kZXBlbmRlbnQgb2YgYSBob3N0IGFwcGxpY2F0aW9uJ3MgYW1iaWVudFxuICAvLyBOb2RlSlMuUHJvY2Vzc0VudiBhdWdtZW50YXRpb24gKE5leHQuanMgbWFrZXMgTk9ERV9FTlYgcmVxdWlyZWQpLiBUaGUgY2hpbGRcbiAgLy8gcmVjZWl2ZXMgdGhlIGNvbXBsZXRlIGFsbG93bGlzdGVkIHN0cmluZyBtYXA7IGNvbnN1bWVyIGdsb2JhbHMgbXVzdCBub3QgY2hhbmdlXG4gIC8vIHNwYXduIG92ZXJsb2FkIHJlc29sdXRpb24gb3IgcmVkdWNlIHRoZSByZXR1cm5lZCBoYW5kbGUgdG8gYG5ldmVyYC5cbiAgY29uc3RydWN0b3IoXG4gICAgcHJpdmF0ZSByZWFkb25seSBzcGF3bkltcGw6IChcbiAgICAgIGNvbW1hbmQ6IHN0cmluZyxcbiAgICAgIGFyZ3M6IHN0cmluZ1tdLFxuICAgICAgb3B0aW9uczoge1xuICAgICAgICBjd2Q/OiBzdHJpbmc7XG4gICAgICAgIGRldGFjaGVkOiBib29sZWFuO1xuICAgICAgICBlbnY/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuICAgICAgICBzdGRpbzogW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcInBpcGVcIl07XG4gICAgICB9LFxuICAgICkgPT4gQ2hpbGRQcm9jZXNzID0gbm9kZVNwYXduIGFzIHVua25vd24gYXMgKFxuICAgICAgY29tbWFuZDogc3RyaW5nLFxuICAgICAgYXJnczogc3RyaW5nW10sXG4gICAgICBvcHRpb25zOiB7XG4gICAgICAgIGN3ZD86IHN0cmluZztcbiAgICAgICAgZGV0YWNoZWQ6IGJvb2xlYW47XG4gICAgICAgIGVudj86IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG4gICAgICAgIHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJwaXBlXCIsIFwicGlwZVwiXTtcbiAgICAgIH0sXG4gICAgKSA9PiBDaGlsZFByb2Nlc3MsXG4gICkge31cblxuICBydW4oXG4gICAgaW52b2NhdGlvbjogV29ya3NwYWNlSG9zdEFnZW50UHJvYmVJbnZvY2F0aW9uLFxuICApOiBQcm9taXNlPFdvcmtzcGFjZUhvc3RBZ2VudFByb2JlT3V0Y29tZT4ge1xuICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICBsZXQgcHJvY2Vzc0lucHV0OiBXb3Jrc3BhY2VIb3N0QWdlbnRQcm9iZVByb2Nlc3M7XG4gICAgICB0cnkge1xuICAgICAgICBwcm9jZXNzSW5wdXQgPSBidWlsZFdvcmtzcGFjZUhvc3RBZ2VudFByb2JlUHJvY2VzcyhpbnZvY2F0aW9uKTtcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIHJlamVjdChlcnJvcik7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIC8vIHJ1bnVzZXIgaXMgYSBsYXVuY2hlcjoga2lsbGluZyBvbmx5IGl0cyBQSUQgbGVhdmVzIHRoZSBhZ2VudCBob2xkaW5nIG91clxuICAgICAgLy8gb3V0cHV0IHBpcGVzIG9wZW4uIFRoaXMgYXdhaXRlZCBwcm9iZSBvd25zIG9uZSBQT1NJWCBwcm9jZXNzIGdyb3VwIHNvIGl0c1xuICAgICAgLy8gZGVhZGxpbmUgYW5kIG91dHB1dCBib3VuZCBjb3ZlciB0aGUgbGF1bmNoZXIgYW5kIGl0cyBkZXNjZW5kYW50cyB0b2dldGhlci5cbiAgICAgIGNvbnN0IG93bnNQcm9jZXNzR3JvdXAgPSBwcm9jZXNzLnBsYXRmb3JtICE9PSBcIndpbjMyXCI7XG4gICAgICBjb25zdCBzcGF3bk9wdGlvbnM6IHtcbiAgICAgICAgY3dkPzogc3RyaW5nO1xuICAgICAgICBkZXRhY2hlZDogYm9vbGVhbjtcbiAgICAgICAgZW52PzogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcbiAgICAgICAgc3RkaW86IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgXCJwaXBlXCJdO1xuICAgICAgfSA9IHtcbiAgICAgICAgc3RkaW86IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgXCJwaXBlXCJdLFxuICAgICAgICBkZXRhY2hlZDogb3duc1Byb2Nlc3NHcm91cCxcbiAgICAgICAgLi4uKHByb2Nlc3NJbnB1dC5jd2QgPyB7IGN3ZDogcHJvY2Vzc0lucHV0LmN3ZCB9IDoge30pLFxuICAgICAgICAuLi4ocHJvY2Vzc0lucHV0LmVudiA/IHsgZW52OiB7IC4uLnByb2Nlc3NJbnB1dC5lbnYgfSB9IDoge30pLFxuICAgICAgfTtcbiAgICAgIGNvbnN0IGNoaWxkID0gdGhpcy5zcGF3bkltcGwoXG4gICAgICAgIHByb2Nlc3NJbnB1dC5jb21tYW5kLFxuICAgICAgICBbLi4ucHJvY2Vzc0lucHV0LmFyZ3NdLFxuICAgICAgICBzcGF3bk9wdGlvbnMsXG4gICAgICApO1xuICAgICAgbGV0IHN0ZG91dCA9IFwiXCI7XG4gICAgICBsZXQgYnl0ZXMgPSAwO1xuICAgICAgbGV0IHNldHRsZWQgPSBmYWxzZTtcbiAgICAgIGxldCBzdGRlcnJXaW5kb3cgPSBcIlwiO1xuICAgICAgbGV0IHN0ZGVyckJ5dGVDb3VudCA9IDA7XG4gICAgICBsZXQgc3RkZXJyQnl0ZUNvdW50VHJ1bmNhdGVkID0gZmFsc2U7XG4gICAgICBsZXQgZmFpbHVyZUhpbnQ6IFdvcmtzcGFjZUhvc3RBZ2VudFByb2JlRmFpbHVyZVJlYXNvbiB8IHVuZGVmaW5lZDtcblxuICAgICAgY29uc3Qga2lsbFByb2JlID0gKCk6IHZvaWQgPT4ge1xuICAgICAgICBpZiAob3duc1Byb2Nlc3NHcm91cCAmJiBjaGlsZC5waWQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBwcm9jZXNzLmtpbGwoLWNoaWxkLnBpZCwgXCJTSUdLSUxMXCIpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgLy8gVGhlIGdyb3VwIG1heSBhbHJlYWR5IGhhdmUgZXhpdGVkOyByZXRhaW4gdGhlIGNoaWxkLWhhbmRsZSBmYWxsYmFjay5cbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgY2hpbGQua2lsbChcIlNJR0tJTExcIik7XG4gICAgICB9O1xuXG4gICAgICBjb25zdCBmaW5pc2ggPSAoZm46ICgpID0+IHZvaWQpOiB2b2lkID0+IHtcbiAgICAgICAgaWYgKHNldHRsZWQpIHJldHVybjtcbiAgICAgICAgc2V0dGxlZCA9IHRydWU7XG4gICAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICAgIGZuKCk7XG4gICAgICB9O1xuXG4gICAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICBmaW5pc2goKCkgPT4ge1xuICAgICAgICAgIGtpbGxQcm9iZSgpO1xuICAgICAgICAgIHJlamVjdChcbiAgICAgICAgICAgIG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgYGFnZW50IGF1dGhlbnRpY2F0aW9uIHByb2JlIHRpbWVkIG91dCBhZnRlciAke2ludm9jYXRpb24udGltZW91dE1zfW1zYCxcbiAgICAgICAgICAgICksXG4gICAgICAgICAgKTtcbiAgICAgICAgfSk7XG4gICAgICB9LCBpbnZvY2F0aW9uLnRpbWVvdXRNcyk7XG5cbiAgICAgIGNoaWxkLnN0ZG91dD8ub24oXCJkYXRhXCIsIChjaHVuazogQnVmZmVyIHwgc3RyaW5nKSA9PiB7XG4gICAgICAgIGNvbnN0IHRleHQgPSB0eXBlb2YgY2h1bmsgPT09IFwic3RyaW5nXCIgPyBjaHVuayA6IGNodW5rLnRvU3RyaW5nKFwidXRmOFwiKTtcbiAgICAgICAgYnl0ZXMgKz0gQnVmZmVyLmJ5dGVMZW5ndGgodGV4dCk7XG4gICAgICAgIGlmIChieXRlcyA+IE1BWF9QUk9CRV9PVVRQVVRfQllURVMpIHtcbiAgICAgICAgICBmaW5pc2goKCkgPT4ge1xuICAgICAgICAgICAga2lsbFByb2JlKCk7XG4gICAgICAgICAgICByZWplY3QoXG4gICAgICAgICAgICAgIG5ldyBFcnJvcihcImFnZW50IGF1dGhlbnRpY2F0aW9uIHByb2JlIHByb2R1Y2VkIHRvbyBtdWNoIG91dHB1dFwiKSxcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIHN0ZG91dCArPSB0ZXh0O1xuICAgICAgfSk7XG4gICAgICAvLyBzdGRlcnIgaXMgZHJhaW5lZCBzbyB0aGUgY2hpbGQgbmV2ZXIgYmxvY2tzIG9uIGEgZnVsbCBwaXBlLCBhbmQgc3RpbGwgbmV2ZXIgcmVhY2hlc1xuICAgICAgLy8gZXZpZGVuY2UgYXMgVEVYVC4gSXQgaXMgY2xhc3NpZmllZCBhcyBpdCBhcnJpdmVzIChhIGZpeGVkIHJlYXNvbiBjb2RlLCBkcm9wcGVkIHRleHQpIHNvIGFcbiAgICAgIC8vIHByb3ZpZGVyLXNpZGUgY2F1c2Ugc3VjaCBhcyBhbiBleGhhdXN0ZWQgcXVvdGEgc3Vydml2ZXMgYXMgYGZhaWx1cmVIaW50YCBpbnN0ZWFkIG9mIGJlaW5nXG4gICAgICAvLyBkZXN0cm95ZWQgaGVyZSBhbmQgbWlzLXJlYWQgbGF0ZXIgYXMgYSBjcmVkZW50aWFsIGZhdWx0IOKAlCBXSS0yMTQ0MDM0LCB3aGVyZSB0aGUgb25lIGxpbmVcbiAgICAgIC8vIHRoYXQgZXhwbGFpbmVkIGEgdHdvLWNhbmFyeSBmYWlsdXJlIHdlbnQgb3V0IG9uIHRoaXMgZXhhY3Qgc3RyZWFtLlxuICAgICAgY2hpbGQuc3RkZXJyPy5vbihcImRhdGFcIiwgKGNodW5rOiBCdWZmZXIgfCBzdHJpbmcpID0+IHtcbiAgICAgICAgY29uc3QgY2h1bmtCeXRlcyA9XG4gICAgICAgICAgdHlwZW9mIGNodW5rID09PSBcInN0cmluZ1wiID8gQnVmZmVyLmJ5dGVMZW5ndGgoY2h1bmspIDogY2h1bmsuYnl0ZUxlbmd0aDtcbiAgICAgICAgY29uc3Qgb2JzZXJ2ZWRTdGRlcnJCeXRlcyA9IHN0ZGVyckJ5dGVDb3VudCArIGNodW5rQnl0ZXM7XG4gICAgICAgIGlmIChvYnNlcnZlZFN0ZGVyckJ5dGVzID4gTUFYX1BST0JFX1NUREVSUl9ESUFHTk9TVElDX0JZVEVTKSB7XG4gICAgICAgICAgc3RkZXJyQnl0ZUNvdW50ID0gTUFYX1BST0JFX1NUREVSUl9ESUFHTk9TVElDX0JZVEVTO1xuICAgICAgICAgIHN0ZGVyckJ5dGVDb3VudFRydW5jYXRlZCA9IHRydWU7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgc3RkZXJyQnl0ZUNvdW50ID0gb2JzZXJ2ZWRTdGRlcnJCeXRlcztcbiAgICAgICAgfVxuICAgICAgICBpZiAoZmFpbHVyZUhpbnQpIHJldHVybjtcbiAgICAgICAgY29uc3QgdGV4dCA9IHR5cGVvZiBjaHVuayA9PT0gXCJzdHJpbmdcIiA/IGNodW5rIDogY2h1bmsudG9TdHJpbmcoXCJ1dGY4XCIpO1xuICAgICAgICAvLyBDYXJyeSBhIGJvdW5kZWQgdGFpbCBhY3Jvc3MgY2h1bmsgYm91bmRhcmllcyBzbyBhIHBhdHRlcm4gc3BsaXQgYWNyb3NzIHR3byByZWFkcyBpc1xuICAgICAgICAvLyBzdGlsbCBtYXRjaGVkLCB3aXRob3V0IGFjY3VtdWxhdGluZyB0aGUgd2hvbGUgc3RyZWFtLlxuICAgICAgICBzdGRlcnJXaW5kb3cgPSAoc3RkZXJyV2luZG93ICsgdGV4dCkuc2xpY2UoLVNUREVSUl9DTEFTU0lGWV9XSU5ET1dfQllURVMpO1xuICAgICAgICBmYWlsdXJlSGludCA9IGNsYXNzaWZ5V29ya3NwYWNlSG9zdEFnZW50UHJvYmVGYWlsdXJlKHN0ZGVycldpbmRvdyk7XG4gICAgICAgIGlmIChmYWlsdXJlSGludCkgc3RkZXJyV2luZG93ID0gXCJcIjtcbiAgICAgIH0pO1xuICAgICAgY2hpbGQub24oXCJlcnJvclwiLCAoZXJyb3IpID0+IGZpbmlzaCgoKSA9PiByZWplY3QoZXJyb3IpKSk7XG4gICAgICBjaGlsZC5vbihcImNsb3NlXCIsIChjb2RlKSA9PlxuICAgICAgICBmaW5pc2goKCkgPT5cbiAgICAgICAgICByZXNvbHZlKHtcbiAgICAgICAgICAgIGV4aXRDb2RlOiB0eXBlb2YgY29kZSA9PT0gXCJudW1iZXJcIiA/IGNvZGUgOiAxLFxuICAgICAgICAgICAgc3Rkb3V0LFxuICAgICAgICAgICAgc3RkZXJyQnl0ZUNvdW50LFxuICAgICAgICAgICAgc3RkZXJyQnl0ZUNvdW50VHJ1bmNhdGVkLFxuICAgICAgICAgICAgLy8gc3Rkb3V0IGlzIGNsYXNzaWZpZWQgdG9vOiBhIENMSSB0aGF0IHJlcG9ydHMgcXVvdGEgb24gc3Rkb3V0IGlzIGp1c3QgYXMgb3BhcXVlLlxuICAgICAgICAgICAgLi4uKChmYWlsdXJlSGludCA/Pz0gY2xhc3NpZnlXb3Jrc3BhY2VIb3N0QWdlbnRQcm9iZUZhaWx1cmUoc3Rkb3V0KSlcbiAgICAgICAgICAgICAgPyB7IGZhaWx1cmVIaW50IH1cbiAgICAgICAgICAgICAgOiB7fSksXG4gICAgICAgICAgfSksXG4gICAgICAgICksXG4gICAgICApO1xuICAgIH0pO1xuICB9XG59XG5cbnR5cGUgV29ya3NwYWNlSG9zdEFnZW50UHJvYmVTdGRlcnJEaWFnbm9zdGljcyA9IFBpY2s8XG4gIFdvcmtzcGFjZUhvc3RBZ2VudFZlcmlmaWNhdGlvbkV2aWRlbmNlLFxuICBcInN0ZGVyckJ5dGVDb3VudFwiIHwgXCJzdGRlcnJCeXRlQ291bnRUcnVuY2F0ZWRcIlxuPjtcblxuZnVuY3Rpb24gcHJvYmVTdGRlcnJEaWFnbm9zdGljRmllbGRzKFxuICBvdXRjb21lOiBXb3Jrc3BhY2VIb3N0QWdlbnRQcm9iZU91dGNvbWUsXG4pOiBXb3Jrc3BhY2VIb3N0QWdlbnRQcm9iZVN0ZGVyckRpYWdub3N0aWNzIHtcbiAgY29uc3QgY291bnQgPSBvdXRjb21lLnN0ZGVyckJ5dGVDb3VudDtcbiAgaWYgKFxuICAgIHR5cGVvZiBjb3VudCAhPT0gXCJudW1iZXJcIiB8fFxuICAgICFOdW1iZXIuaXNTYWZlSW50ZWdlcihjb3VudCkgfHxcbiAgICBjb3VudCA8IDBcbiAgKSB7XG4gICAgcmV0dXJuIHt9O1xuICB9XG4gIHJldHVybiB7XG4gICAgc3RkZXJyQnl0ZUNvdW50OiBNYXRoLm1pbihjb3VudCwgTUFYX1BST0JFX1NUREVSUl9ESUFHTk9TVElDX0JZVEVTKSxcbiAgICBzdGRlcnJCeXRlQ291bnRUcnVuY2F0ZWQ6XG4gICAgICBvdXRjb21lLnN0ZGVyckJ5dGVDb3VudFRydW5jYXRlZCA9PT0gdHJ1ZSB8fFxuICAgICAgY291bnQgPiBNQVhfUFJPQkVfU1RERVJSX0RJQUdOT1NUSUNfQllURVMsXG4gIH07XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgUHJvYmVXb3Jrc3BhY2VIb3N0QWdlbnRJbnB1dCB7XG4gIHJlYWRvbmx5IHNwZWM6IFdvcmtzcGFjZUhvc3RBZ2VudFZlcmlmaWNhdGlvblByb2JlU3BlYztcbiAgcmVhZG9ubHkgcnVubmVyOiBXb3Jrc3BhY2VIb3N0QWdlbnRQcm9iZVJ1bm5lcjtcbiAgcmVhZG9ubHkgbm93OiAoKSA9PiBEYXRlO1xuICByZWFkb25seSBlbnY/OiBSZWFkb25seTxSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+PjtcbiAgcmVhZG9ubHkgY3dkPzogc3RyaW5nO1xuICByZWFkb25seSBydW5Bc1VzZXI/OiBzdHJpbmc7XG59XG5cbi8qKiBSdW4gb25lIHByb2JlIGFuZCByZWR1Y2UgaXQgdG8gcHVibGlzaGFibGUgZXZpZGVuY2UuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcHJvYmVXb3Jrc3BhY2VIb3N0QWdlbnRWZXJpZmljYXRpb24oXG4gIGlucHV0OiBQcm9iZVdvcmtzcGFjZUhvc3RBZ2VudElucHV0LFxuKTogUHJvbWlzZTxXb3Jrc3BhY2VIb3N0QWdlbnRWZXJpZmljYXRpb25FdmlkZW5jZT4ge1xuICBjb25zdCB7IHNwZWMsIHJ1bm5lciwgbm93IH0gPSBpbnB1dDtcbiAgY29uc3QgYmFzZSA9IHtcbiAgICBjb250cmFjdFZlcnNpb246IFdPUktTUEFDRV9IT1NUX0FHRU5UX1ZFUklGSUNBVElPTl9DT05UUkFDVF9WRVJTSU9OLFxuICAgIGFnZW50OiBzcGVjLmFnZW50LFxuICAgIHZlcmlmaWNhdGlvbktpbmQ6IHNwZWMudmVyaWZpY2F0aW9uS2luZCxcbiAgICBlbmRwb2ludDogc3BlYy5lbmRwb2ludCxcbiAgICBzdWJqZWN0RGlzY2xvc3VyZTogc3BlYy5zdWJqZWN0RGlzY2xvc3VyZSxcbiAgfSBhcyBjb25zdDtcblxuICBsZXQgb3V0Y29tZTogV29ya3NwYWNlSG9zdEFnZW50UHJvYmVPdXRjb21lO1xuICB0cnkge1xuICAgIG91dGNvbWUgPSBhd2FpdCBydW5uZXIucnVuKHtcbiAgICAgIGNvbW1hbmQ6IHNwZWMuY29tbWFuZCxcbiAgICAgIGFyZ3M6IHNwZWMuYXJncyxcbiAgICAgIHRpbWVvdXRNczpcbiAgICAgICAgc3BlYy50aW1lb3V0TXMgPz8gREVGQVVMVF9XT1JLU1BBQ0VfSE9TVF9BR0VOVF9QUk9CRV9USU1FT1VUX01TLFxuICAgICAgLi4uKGlucHV0LmVudiA/IHsgZW52OiBpbnB1dC5lbnYgfSA6IHt9KSxcbiAgICAgIC4uLihpbnB1dC5jd2QgPyB7IGN3ZDogaW5wdXQuY3dkIH0gOiB7fSksXG4gICAgICAuLi4oaW5wdXQucnVuQXNVc2VyID8geyBydW5Bc1VzZXI6IGlucHV0LnJ1bkFzVXNlciB9IDoge30pLFxuICAgIH0pO1xuICB9IGNhdGNoIHtcbiAgICAvLyBUaGUgdGhyb3duIGVycm9yIG1heSBjYXJyeSBhIGNvbW1hbmQgbGluZSBvciBDTEkgdGV4dCwgc28gaXQgaXMgcmVkdWNlZCB0byBhIGNvZGUgaGVyZSBhbmRcbiAgICAvLyBuZXZlciBzdXJmYWNlZC4gQSBjYWxsZXIgdGhhdCBuZWVkcyB0byBkZWJ1ZyByZWFkcyB0aGUgaG9zdCdzIG93biBsb2dzLlxuICAgIGNvbnN0IGV2aWRlbmNlOiBXb3Jrc3BhY2VIb3N0QWdlbnRWZXJpZmljYXRpb25FdmlkZW5jZSA9IHtcbiAgICAgIC4uLmJhc2UsXG4gICAgICByZWFkeTogZmFsc2UsXG4gICAgICBleGl0U3RhdHVzOiAtMSxcbiAgICAgIG9ic2VydmVkQXQ6IG5vdygpLnRvSVNPU3RyaW5nKCksXG4gICAgICBmYWlsdXJlOiBcInByb2JlLWVycm9yXCIsXG4gICAgfTtcbiAgICBhc3NlcnRXb3Jrc3BhY2VIb3N0U2VjcmV0SXNvbGF0aW9uKFxuICAgICAgZXZpZGVuY2UsXG4gICAgICBgd29ya3NwYWNlSG9zdC5hZ2VudEF1dGhlbnRpY2F0aW9uLiR7c3BlYy5hZ2VudH1gLFxuICAgICk7XG4gICAgcmV0dXJuIGV2aWRlbmNlO1xuICB9XG5cbiAgY29uc3Qgb2JzZXJ2ZWRBdCA9IG5vdygpLnRvSVNPU3RyaW5nKCk7XG4gIGlmIChvdXRjb21lLmV4aXRDb2RlICE9PSAwKSB7XG4gICAgY29uc3QgZXZpZGVuY2U6IFdvcmtzcGFjZUhvc3RBZ2VudFZlcmlmaWNhdGlvbkV2aWRlbmNlID0ge1xuICAgICAgLi4uYmFzZSxcbiAgICAgIC4uLnByb2JlU3RkZXJyRGlhZ25vc3RpY0ZpZWxkcyhvdXRjb21lKSxcbiAgICAgIHJlYWR5OiBmYWxzZSxcbiAgICAgIGV4aXRTdGF0dXM6IG91dGNvbWUuZXhpdENvZGUsXG4gICAgICBvYnNlcnZlZEF0LFxuICAgICAgLy8gQSBjbGFzc2lmaWVkIHByb3ZpZGVyIGNhdXNlIG91dHJhbmtzIHRoZSBnZW5lcmljIHNoYXBlIGNvZGU6IFwibm9uLXplcm8tZXhpdFwiIGRlc2NyaWJlc1xuICAgICAgLy8gSE9XIHRoZSBwcm9iZSBmYWlsZWQsIFwicHJvdmlkZXItdXNhZ2UtbGltaXRcIiBkZXNjcmliZXMgV0hZLCBhbmQgb25seSB0aGUgc2Vjb25kIG9uZSB0ZWxsc1xuICAgICAgLy8gYSByZWFkZXIgbm90IHRvIGdvIGxvb2tpbmcgYXQgdGhlIGNyZWRlbnRpYWwuXG4gICAgICBmYWlsdXJlOiBvdXRjb21lLmZhaWx1cmVIaW50ID8/IFwibm9uLXplcm8tZXhpdFwiLFxuICAgIH07XG4gICAgYXNzZXJ0V29ya3NwYWNlSG9zdFNlY3JldElzb2xhdGlvbihcbiAgICAgIGV2aWRlbmNlLFxuICAgICAgYHdvcmtzcGFjZUhvc3QuYWdlbnRBdXRoZW50aWNhdGlvbi4ke3NwZWMuYWdlbnR9YCxcbiAgICApO1xuICAgIHJldHVybiBldmlkZW5jZTtcbiAgfVxuXG4gIGNvbnN0IG1hdGNoID0gc3BlYy5wcm9vZlBhdHRlcm4uZXhlYyhvdXRjb21lLnN0ZG91dCk7XG4gIGNvbnN0IHByb29mID0gbWF0Y2g/LlsxXT8udHJpbSgpO1xuICBpZiAoIXByb29mKSB7XG4gICAgY29uc3QgZXZpZGVuY2U6IFdvcmtzcGFjZUhvc3RBZ2VudFZlcmlmaWNhdGlvbkV2aWRlbmNlID0ge1xuICAgICAgLi4uYmFzZSxcbiAgICAgIC4uLnByb2JlU3RkZXJyRGlhZ25vc3RpY0ZpZWxkcyhvdXRjb21lKSxcbiAgICAgIHJlYWR5OiBmYWxzZSxcbiAgICAgIGV4aXRTdGF0dXM6IG91dGNvbWUuZXhpdENvZGUsXG4gICAgICBvYnNlcnZlZEF0LFxuICAgICAgLy8gVGhlIG1lYXN1cmVkIFdJLTIxNDQwMzQgY2FzZSBsYW5kcyBIRVJFLCBub3QgYWJvdmU6IGBjb2RleCBleGVjYCBleGl0ZWQgMCB3aGlsZSBwcmludGluZyBhXG4gICAgICAvLyB1c2FnZS1saW1pdCBlcnJvciwgc28gdGhlIG1hcmtlciB3YXMgc2ltcGx5IGFic2VudC4gV2l0aG91dCB0aGUgaGludCB0aGlzIHJlYWRzIGFzXG4gICAgICAvLyBcIm5vIHByb29mXCIgYW5kIHNlbmRzIGV2ZXJ5IHJlYWRlciB0byB0aGUgY3JlZGVudGlhbHMuXG4gICAgICBmYWlsdXJlOiBvdXRjb21lLmZhaWx1cmVIaW50ID8/IFwibm8tdmVyaWZpY2F0aW9uLXByb29mXCIsXG4gICAgfTtcbiAgICBhc3NlcnRXb3Jrc3BhY2VIb3N0U2VjcmV0SXNvbGF0aW9uKFxuICAgICAgZXZpZGVuY2UsXG4gICAgICBgd29ya3NwYWNlSG9zdC5hZ2VudEF1dGhlbnRpY2F0aW9uLiR7c3BlYy5hZ2VudH1gLFxuICAgICk7XG4gICAgcmV0dXJuIGV2aWRlbmNlO1xuICB9XG5cbiAgY29uc3QgZXZpZGVuY2U6IFdvcmtzcGFjZUhvc3RBZ2VudFZlcmlmaWNhdGlvbkV2aWRlbmNlID0ge1xuICAgIC4uLmJhc2UsXG4gICAgcmVhZHk6IHRydWUsXG4gICAgZXhpdFN0YXR1czogb3V0Y29tZS5leGl0Q29kZSxcbiAgICBvYnNlcnZlZEF0LFxuICAgIHByb29mRGlnZXN0OiB3b3Jrc3BhY2VIb3N0QWdlbnRTdWJqZWN0RGlnZXN0KHByb29mKSxcbiAgICAuLi4oc3BlYy52ZXJpZmljYXRpb25LaW5kID09PSBcImF1dGhlbnRpY2F0ZWQtYWNjb3VudFwiICYmXG4gICAgc3BlYy5zdWJqZWN0RGlzY2xvc3VyZSA9PT0gXCJyZWRhY3RlZFwiXG4gICAgICA/IHsgc3ViamVjdDogcHJvb2YgfVxuICAgICAgOiB7fSksXG4gIH07XG4gIGFzc2VydFdvcmtzcGFjZUhvc3RTZWNyZXRJc29sYXRpb24oXG4gICAgZXZpZGVuY2UsXG4gICAgYHdvcmtzcGFjZUhvc3QuYWdlbnRBdXRoZW50aWNhdGlvbi4ke3NwZWMuYWdlbnR9YCxcbiAgKTtcbiAgcmV0dXJuIGV2aWRlbmNlO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFdvcmtzcGFjZUhvc3RBZ2VudFZlcmlmaWNhdGlvblJlcG9ydCB7XG4gIHJlYWRvbmx5IGNvbnRyYWN0VmVyc2lvbjogdHlwZW9mIFdPUktTUEFDRV9IT1NUX0FHRU5UX1ZFUklGSUNBVElPTl9DT05UUkFDVF9WRVJTSU9OO1xuICByZWFkb25seSBvYnNlcnZlZEF0OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGFsbFJlYWR5OiBib29sZWFuO1xuICAvKiogRXhwbGljaXQgY292ZXJhZ2U7IG9taXR0ZWQgb24gbGVnYWN5L2RlZmF1bHQgYWxsLWFnZW50IHJlcG9ydHMuIEV4Y2x1ZGVkIGFnZW50cyBoYXZlIG5vIGV2aWRlbmNlLiAqL1xuICByZWFkb25seSByZXF1ZXN0ZWRBZ2VudHM/OiByZWFkb25seSBXb3Jrc3BhY2VIb3N0Q2FuYXJ5QWdlbnRbXTtcbiAgcmVhZG9ubHkgYWdlbnRzOiBSZWFkb25seTxcbiAgICBQYXJ0aWFsPFJlY29yZDxXb3Jrc3BhY2VIb3N0Q2FuYXJ5QWdlbnQsIFdvcmtzcGFjZUhvc3RBZ2VudFZlcmlmaWNhdGlvbkV2aWRlbmNlPj5cbiAgPjtcbn1cblxuLyoqXG4gKiBUcnVlIHdoZW4gYW55IGNvZGUgdW5pdCBpcyBhIEMwIGNvbnRyb2wgb3IgREVMLlxuICpcbiAqIEEgY29kZXBvaW50IHNjYW4gcmF0aGVyIHRoYW4gYSBjaGFyYWN0ZXItY2xhc3MgcmVnZXggb24gcHVycG9zZTogdGhlIGNsYXNzIGhhcyB0byBiZSB3cml0dGVuXG4gKiB3aXRoIHRoZSBjb250cm9sIGNoYXJhY3RlcnMgdGhlbXNlbHZlcywgYW5kIGEgcmF3IGNvbnRyb2wgYnl0ZSBpbiBzb3VyY2UgbWFrZXMgcmlwZ3JlcCB0cmVhdCB0aGVcbiAqIGZpbGUgYXMgYmluYXJ5IGFuZCBza2lwIGl0IOKAlCBzbyB0aGUgb25lIGd1YXJkIG5vYm9keSBjYW4gZ3JlcCBmb3IgaXMgdGhlIGd1YXJkIGFib3V0IHVuZ3JlcHBhYmxlXG4gKiBieXRlcy4gVGhpcyBzYXlzIHRoZSBzYW1lIHRoaW5nIGluIGNoYXJhY3RlcnMgdGhhdCBzdXJ2aXZlIGEgZGlmZi5cbiAqL1xuZnVuY3Rpb24gY29udGFpbnNDb250cm9sQ2hhcmFjdGVyKHZhbHVlOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgZm9yIChsZXQgaW5kZXggPSAwOyBpbmRleCA8IHZhbHVlLmxlbmd0aDsgaW5kZXggKz0gMSkge1xuICAgIGNvbnN0IGNvZGUgPSB2YWx1ZS5jaGFyQ29kZUF0KGluZGV4KTtcbiAgICBpZiAoY29kZSA8IDB4MjAgfHwgY29kZSA9PT0gMHg3ZikgcmV0dXJuIHRydWU7XG4gIH1cbiAgcmV0dXJuIGZhbHNlO1xufVxuXG4vKipcbiAqIFBvaW50IG9uZSBwcm9iZSBzcGVjIGF0IHRoZSB2ZW5kb3IgcnVudGltZSBwYXRoIHJlY29yZGVkIGZvciBpdHMgYWdlbnQgKEQtMjU5IERlZmVjdCAyKS5cbiAqXG4gKiBUaGUgZGVmYXVsdCBzcGVjcyBuYW1lIGVhY2ggQ0xJIGJ5IEJBUkUgTkFNRSwgd2hpY2ggdGhlIHByb2JlIHJlc29sdmVzIGFnYWluc3QgaXRzIHNlYXJjaCBwYXRoLlxuICogT24gYSByZWFsIHdvcmtzcGFjZSBob3N0IHRoYXQgcGF0aCBsZWFkcyB3aXRoIHRoZSByZWxlYXNlIGJ1bmRsZSdzIG93biBgYmluL2AsIGFuZCB0aGUgZmlsZXNcbiAqIHRoZXJlIGFyZSBsYXVuY2hlciBXUkFQUEVSUyBuYW1lZCBhZnRlciB0aGUgYWdlbnQgQ0xJcyDigJQgdGhleSBkbyBub3QgaW1wbGVtZW50IGBhdXRoIHN0YXR1c2AsIHNvXG4gKiBhIHByb2JlIHRoYXQgZm91bmQgb25lIG1lYXN1cmVkIHRoZSB3cmFwcGVyIGFuZCByZXBvcnRlZCBhIGNyZWRlbnRpYWwgZmF1bHQgdGhhdCBubyBjcmVkZW50aWFsXG4gKiBjb3VsZCBmaXguIFRoYXQgaXMgRC0yNDcsIGFuZCBpdCByZWFkIGFzIGEgcHJvYmUgYnVnIGFjcm9zcyB0aHJlZSBzZXNzaW9ucyBwcmVjaXNlbHkgYmVjYXVzZSB0aGVcbiAqIHByb2JlIGxvb2tlZCBjb3JyZWN0OiBpdCByYW4gdGhlIG5hbWUgaXQgbWVhbnQgdG8gcnVuLiBQcm92aXNpb25pbmcgcmVzb2x2ZXMgZWFjaCB2ZW5kb3IgYmluYXJ5XG4gKiBhZnRlciBpbnN0YWxsaW5nIGl0IGFuZCByZWNvcmRzIHRoZSBBQlNPTFVURSBwYXRoOyBzdWJzdGl0dXRpbmcgdGhhdCBwYXRoIGhlcmUgaXMgd2hhdCBtYWtlcyB0aGVcbiAqIHByb2JlIGV4ZWMgdGhlIHZlbmRvciBDTEkgaW5zdGVhZCBvZiB3aGF0ZXZlciB0aGUgc2VhcmNoIHBhdGggaGFwcGVucyB0byBmaW5kIGZpcnN0LlxuICpcbiAqIEEgTUlTU0lORyBwYXRoIGlzIGRlbGliZXJhdGVseSBub3QgYW4gZXJyb3IuIEEgaG9zdCBwcm92aXNpb25lZCBiZWZvcmUgdGhvc2UgaW5zdGFsbHMgZXhpc3RlZFxuICogZ2VudWluZWx5IGhhcyBubyB2ZW5kb3IgcnVudGltZSwgYW5kIHRoZSBob25lc3Qgb3V0Y29tZSB0aGVyZSBpcyBhIHByb2JlIHRoYXQgcnVucyBhbmQgRkFJTFMg4oCUXG4gKiBcInRoaXMgaG9zdCBjYW5ub3QgYXV0aGVudGljYXRlIGFuIGFnZW50XCIgaXMgdGhlIGZpbmRpbmcgdGhlIGNhbmFyeSBleGlzdHMgdG8gc3VyZmFjZS4gVGhyb3dpbmdcbiAqIGluc3RlYWQgd291bGQgcmUtZmlsZSB0aGF0IGZpbmRpbmcgYXMgYW4gaW5mcmFzdHJ1Y3R1cmUgZXJyb3IgYW5kIGhpZGUgaXQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhcHBseVdvcmtzcGFjZUhvc3RBZ2VudFJ1bnRpbWVQYXRoKFxuICBzcGVjOiBXb3Jrc3BhY2VIb3N0QWdlbnRWZXJpZmljYXRpb25Qcm9iZVNwZWMsXG4gIHJ1bnRpbWVQYXRoOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4pOiBXb3Jrc3BhY2VIb3N0QWdlbnRWZXJpZmljYXRpb25Qcm9iZVNwZWMge1xuICBpZiAocnVudGltZVBhdGggPT09IHVuZGVmaW5lZCkgcmV0dXJuIHNwZWM7XG4gIC8vIENvbnRyb2wgY2hhcmFjdGVycyBhcmUgcmVqZWN0ZWQgcmF0aGVyIHRoYW4gZXNjYXBlZDogdGhlIHBhdGggaXMgaW50ZXJwb2xhdGVkIGludG8gdGhlXG4gIC8vIGBlbnYgLWkgLS1gIGFyZ3YgdGhlIHByb2JlIGxhdW5jaGVzIHdpdGgsIHNvIGEgdmFsdWUgY2FycnlpbmcgYSBOVUwgb3IgYSBuZXdsaW5lIGlzIGFcbiAgLy8gdHJ1bmNhdGVkIG9yIHNwbGl0IEFSR1VNRU5ULCBub3QgYSBwYXRoIHRoYXQgbWVyZWx5IGZhaWxzIHRvIGV4aXN0LlxuICBpZiAoXG4gICAgIXJ1bnRpbWVQYXRoLnN0YXJ0c1dpdGgoXCIvXCIpIHx8XG4gICAgcnVudGltZVBhdGgubGVuZ3RoIDwgMiB8fFxuICAgIGNvbnRhaW5zQ29udHJvbENoYXJhY3RlcihydW50aW1lUGF0aClcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYGFnZW50ICcke3NwZWMuYWdlbnR9JyBydW50aW1lIHBhdGggbXVzdCBiZSBhbiBhYnNvbHV0ZSBwYXRoIGZyZWUgb2YgY29udHJvbCBjaGFyYWN0ZXJzYCxcbiAgICApO1xuICB9XG4gIHJldHVybiB7IC4uLnNwZWMsIGNvbW1hbmQ6IHJ1bnRpbWVQYXRoIH07XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgUHJvYmVXb3Jrc3BhY2VIb3N0QWdlbnRzSW5wdXQge1xuICByZWFkb25seSBydW5uZXI6IFdvcmtzcGFjZUhvc3RBZ2VudFByb2JlUnVubmVyO1xuICByZWFkb25seSByZXF1ZXN0ZWRBZ2VudHM/OiByZWFkb25seSBXb3Jrc3BhY2VIb3N0Q2FuYXJ5QWdlbnRbXTtcbiAgcmVhZG9ubHkgcHJvYmVzPzogUGFydGlhbDxcbiAgICBSZWNvcmQ8XG4gICAgICBXb3Jrc3BhY2VIb3N0Q2FuYXJ5QWdlbnQsXG4gICAgICByZWFkb25seSBXb3Jrc3BhY2VIb3N0QWdlbnRWZXJpZmljYXRpb25Qcm9iZVNwZWNbXVxuICAgID5cbiAgPjtcbiAgcmVhZG9ubHkgbm93PzogKCkgPT4gRGF0ZTtcbiAgLyoqIEV4YWN0IGVudmlyb25tZW50IHNoYXJlZCBieSBhbGwgdGhyZWUgc2VxdWVudGlhbCBwcm9iZXMuICovXG4gIHJlYWRvbmx5IGVudj86IFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIHN0cmluZz4+O1xuICAvKiogRXhwbGljaXQgY3dkIHNoYXJlZCBieSBhbGwgdGhyZWUgcHJvYmVzOyBjb250cm9sbGVyLXNpZGUgY2FsbGVycyB1c2UgdGhlIGlzb2xhdGVkIGhvbWUuICovXG4gIHJlYWRvbmx5IGN3ZD86IHN0cmluZztcbiAgLyoqIFJlYWwgVW5peCBhY2NvdW50IHNoYXJlZCBieSBhbGwgdGhyZWUgc2VxdWVudGlhbCBwcm9iZXMuICovXG4gIHJlYWRvbmx5IHJ1bkFzVXNlcj86IHN0cmluZztcbiAgLyoqXG4gICAqIEFic29sdXRlIHBhdGggb2YgZWFjaCBhZ2VudCdzIFZFTkRPUiBydW50aW1lLCBhcyByZXNvbHZlZCBvbiB0aGUgaG9zdCBhZnRlciBpbnN0YWxsLlxuICAgKlxuICAgKiBXaGVuIHByZXNlbnQgZm9yIGFuIGFnZW50IGl0IFJFUExBQ0VTIHRoYXQgYWdlbnQncyBwcm9iZSBgY29tbWFuZGAg4oCUIGV2ZXJ5IHNwZWMgZm9yIHRoYXRcbiAgICogYWdlbnQsIHNvIE9NUCdzIGhvc3RlZC1hY2NvdW50IGFuZCBsb2NhbC1pbmZlcmVuY2UgcHJvYmVzIGJvdGggZXhlYyB0aGUgc2FtZSBiaW5hcnkuIEFic2VudFxuICAgKiBlbnRyaWVzIGZhbGwgYmFjayB0byB0aGUgc3BlYydzIG93biBjb21tYW5kOyBzZWUgYGFwcGx5V29ya3NwYWNlSG9zdEFnZW50UnVudGltZVBhdGhgIGZvciB3aHlcbiAgICogdGhhdCBmYWxsYmFjayBpcyBhIGZhbGxiYWNrIGFuZCBub3QgYSBmYWlsdXJlLlxuICAgKi9cbiAgcmVhZG9ubHkgcnVudGltZVBhdGhzPzogUGFydGlhbDxSZWNvcmQ8V29ya3NwYWNlSG9zdENhbmFyeUFnZW50LCBzdHJpbmc+Pjtcbn1cblxuLyoqXG4gKiBQcm9iZSB0aGUgcmVxdWVzdGVkIGFnZW50cywgZGVmYXVsdGluZyB0byBhbGwgdGhyZWUuXG4gKlxuICogU2VxdWVudGlhbCwgbm90IHBhcmFsbGVsOiB0aHJlZSBDTElzIHJhY2luZyBmb3IgdGhlIHNhbWUgY3JlZGVudGlhbCBzdG9yZSBvciBrZXljaGFpbiBpcyBhXG4gKiBzb3VyY2Ugb2Ygc3B1cmlvdXMgZmFpbHVyZXMsIGFuZCBhIHByb2JlIHN1aXRlIHRoYXQgaXMgZmxha3kgaXMgd29yc2UgdGhhbiBubyBwcm9iZSBzdWl0ZSDigJRcbiAqIGl0IHRlYWNoZXMgd2hvZXZlciByZWFkcyB0aGUgY2FuYXJ5IHRvIHJlLXJ1biB1bnRpbCBpdCBwYXNzZXMuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBwcm9iZVdvcmtzcGFjZUhvc3RBZ2VudHMoXG4gIGlucHV0OiBQcm9iZVdvcmtzcGFjZUhvc3RBZ2VudHNJbnB1dCxcbik6IFByb21pc2U8V29ya3NwYWNlSG9zdEFnZW50VmVyaWZpY2F0aW9uUmVwb3J0PiB7XG4gIGNvbnN0IHJlcXVlc3RlZEFnZW50cyA9IHJlc29sdmVXb3Jrc3BhY2VIb3N0UmVxdWVzdGVkQWdlbnRzKGlucHV0LnJlcXVlc3RlZEFnZW50cyk7XG4gIGNvbnN0IG5vdyA9IGlucHV0Lm5vdyA/PyAoKCkgPT4gbmV3IERhdGUoKSk7XG4gIGNvbnN0IGFnZW50czogUGFydGlhbDxcbiAgICBSZWNvcmQ8V29ya3NwYWNlSG9zdENhbmFyeUFnZW50LCBXb3Jrc3BhY2VIb3N0QWdlbnRWZXJpZmljYXRpb25FdmlkZW5jZT5cbiAgPiA9IHt9O1xuICBmb3IgKGNvbnN0IGFnZW50IG9mIHJlcXVlc3RlZEFnZW50cykge1xuICAgIGNvbnN0IHNwZWNzID1cbiAgICAgIGlucHV0LnByb2Jlcz8uW2FnZW50XSA/P1xuICAgICAgREVGQVVMVF9XT1JLU1BBQ0VfSE9TVF9BR0VOVF9WRVJJRklDQVRJT05fUFJPQkVTW2FnZW50XTtcbiAgICBpZiAoc3BlY3MubGVuZ3RoID09PSAwKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYGFnZW50ICcke2FnZW50fScgaGFzIG5vIHZlcmlmaWNhdGlvbiBwcm9iZXNgKTtcbiAgICB9XG4gICAgLy8gT3JkZXJlZCBCRUZPUkUgdGhlIHJlYWRpbmVzcyBndWFyZCBiZWxvdywgZm9yIHRoZSBzYW1lIHJlYXNvbiB0aGUgcnVudGltZSBwYXRoIGlzIGFwcGxpZWRcbiAgICAvLyBhZnRlciBpdDogYSBtaXMtZGVjbGFyZWQgc3BlYyBtdXN0IGJlIHJlZnVzZWQgQVMgbWlzLWRlY2xhcmVkLiBDaGVja2luZyByZWFkaW5lc3MgZmlyc3RcbiAgICAvLyB3b3VsZCByZXBvcnQgYSBib3Jyb3dlZCBgc2F0aXNmaWVzUmVhZGluZXNzOiBmYWxzZWAgc3BlYyBhcyBcInRoaXMgYWdlbnQgaGFzIG5vIHJlYWRpbmVzc1xuICAgIC8vIHByb2JlXCIsIHdoaWNoIGlzIGEgdHJ1ZSBzdGF0ZW1lbnQgYWJvdXQgdGhlIHdyb25nIHByb2JsZW0gYW5kIGhpZGVzIHRoZSBhY3R1YWwgbWlzdGFrZS5cbiAgICBmb3IgKGNvbnN0IHNwZWMgb2Ygc3BlY3MpIHtcbiAgICAgIGlmIChzcGVjLmFnZW50ICE9PSBhZ2VudCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgYGFnZW50IHByb2JlIGZvciAnJHthZ2VudH0nIGRlY2xhcmVzIGFnZW50ICcke3NwZWMuYWdlbnR9J2AsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuICAgIC8vIFNUUlVDVFVSQUwgR1VBUkQgKFdJLTEwMDAxNjk0KS4gQSBwcm9iZSBzZXQgd2hvc2UgZXZlcnkgc3BlYyBpcyBgc2F0aXNmaWVzUmVhZGluZXNzOiBmYWxzZWBcbiAgICAvLyBjb3VsZCBuZXZlciBtYXJrIHRoZSBhZ2VudCByZWFkeSwgYW5kIHRoZSBzaGFwZSB0aGF0IHByb2R1Y2VzIGl0IOKAlCBvcHRpbmcgdGhlIGxhc3QgcmVhZGluZXNzXG4gICAgLy8gcHJvYmUgb3V0IHdoaWxlIG1lYW5pbmcgdG8ga2VlcCB0aGUgYWNjb3VudCBvbmUgZm9yIGV2aWRlbmNlIOKAlCBmYWlscyBTSUxFTlRMWSBpbiB0aGVcbiAgICAvLyBkaXJlY3Rpb24gdGhhdCByZWFkcyBhcyBhIGNyZWRlbnRpYWwgZmF1bHQuIFJlZnVzaW5nIHRoZSBTRVQgaXMgd2hhdCBtYWtlcyB0aGUgZGVmZWN0XG4gICAgLy8gaW1wb3NzaWJsZSB0byBleHByZXNzLCByYXRoZXIgdGhhbiBtZXJlbHkgYWJzZW50IGZyb20gdGhlIGN1cnJlbnQgYXJyYW5nZW1lbnQuXG4gICAgaWYgKCFzcGVjcy5zb21lKHdvcmtzcGFjZUhvc3RBZ2VudFNwZWNTYXRpc2ZpZXNSZWFkaW5lc3MpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBhZ2VudCAnJHthZ2VudH0nIGhhcyBubyByZWFkaW5lc3MtYmVhcmluZyB2ZXJpZmljYXRpb24gcHJvYmVgLFxuICAgICAgKTtcbiAgICB9XG4gICAgbGV0IHJlYWRpbmVzczogV29ya3NwYWNlSG9zdEFnZW50VmVyaWZpY2F0aW9uRXZpZGVuY2UgfCB1bmRlZmluZWQ7XG4gICAgbGV0IHNlbGZSZXBvcnRlZFN1YmplY3REaWdlc3Q6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICBmb3IgKGNvbnN0IHNwZWMgb2Ygc3BlY3MpIHtcbiAgICAgIGNvbnN0IGV2aWRlbmNlID0gYXdhaXQgcHJvYmVXb3Jrc3BhY2VIb3N0QWdlbnRWZXJpZmljYXRpb24oe1xuICAgICAgICAvLyBBcHBsaWVkIEFGVEVSIHRoZSBhZ2VudC1taXNtYXRjaCBjaGVjayBhYm92ZSwgc28gYSBtaXMtZGVjbGFyZWQgc3BlYyBpcyByZWZ1c2VkIGFzIGFcbiAgICAgICAgLy8gbWlzLWRlY2xhcmVkIHNwZWMgcmF0aGVyIHRoYW4gc2lsZW50bHkgcmV3cml0dGVuIHRvIHBvaW50IGF0IGFub3RoZXIgYWdlbnQncyBiaW5hcnkuXG4gICAgICAgIHNwZWM6IGFwcGx5V29ya3NwYWNlSG9zdEFnZW50UnVudGltZVBhdGgoXG4gICAgICAgICAgc3BlYyxcbiAgICAgICAgICBpbnB1dC5ydW50aW1lUGF0aHM/LlthZ2VudF0sXG4gICAgICAgICksXG4gICAgICAgIHJ1bm5lcjogaW5wdXQucnVubmVyLFxuICAgICAgICBub3csXG4gICAgICAgIC4uLihpbnB1dC5lbnYgPyB7IGVudjogaW5wdXQuZW52IH0gOiB7fSksXG4gICAgICAgIC4uLihpbnB1dC5jd2QgPyB7IGN3ZDogaW5wdXQuY3dkIH0gOiB7fSksXG4gICAgICAgIC4uLihpbnB1dC5ydW5Bc1VzZXIgPyB7IHJ1bkFzVXNlcjogaW5wdXQucnVuQXNVc2VyIH0gOiB7fSksXG4gICAgICB9KTtcbiAgICAgIGlmICghd29ya3NwYWNlSG9zdEFnZW50U3BlY1NhdGlzZmllc1JlYWRpbmVzcyhzcGVjKSkge1xuICAgICAgICAvLyBDb250cmlidXRlcyBpZGVudGl0eSwgbmV2ZXIgcmVhZGluZXNzOiBpdCBjYW5ub3QgYXNzaWduIGByZWFkaW5lc3NgIGFuZCBjYW5ub3QgYGJyZWFrYCxcbiAgICAgICAgLy8gc28gaXQgaXMgaW5lcnQgaW4gRVZFUlkgcG9zaXRpb24uIEEgcHJvYmUgdGhhdCBkaWQgbm90IG1hdGNoIGxlYXZlcyBubyBkaWdlc3QsIHdoaWNoIGlzXG4gICAgICAgIC8vIHRoZSBDaGF0R1BULU9BdXRoIGNhc2UgdG9kYXkg4oCUIGFic2VudCwgcmF0aGVyIHRoYW4gYW4gZW1wdHktc3RyaW5nIGNsYWltIG9mIGlkZW50aXR5LlxuICAgICAgICBpZiAoZXZpZGVuY2UucHJvb2ZEaWdlc3QpIHtcbiAgICAgICAgICBzZWxmUmVwb3J0ZWRTdWJqZWN0RGlnZXN0ID0gZXZpZGVuY2UucHJvb2ZEaWdlc3Q7XG4gICAgICAgIH1cbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICByZWFkaW5lc3MgPSBldmlkZW5jZTtcbiAgICAgIGlmIChldmlkZW5jZS5yZWFkeSkgYnJlYWs7XG4gICAgfVxuICAgIGlmICghcmVhZGluZXNzKSB7XG4gICAgICAvLyBVbnJlYWNoYWJsZSB2aWEgdGhlIHN0cnVjdHVyYWwgZ3VhcmQgYWJvdmU7IGtlcHQgYmVjYXVzZSB0aGUgYWx0ZXJuYXRpdmUgdG8gdGhyb3dpbmcgaGVyZVxuICAgICAgLy8gaXMgYSBub24tbnVsbCBhc3NlcnRpb24sIGFuZCB0aGlzIG1vZHVsZSdzIHdob2xlIHB1cnBvc2UgaXMgcmVmdXNpbmcgdW5iYWNrZWQgYm9vbGVhbnMuXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBhZ2VudCAnJHthZ2VudH0nIHByb2R1Y2VkIG5vIHJlYWRpbmVzcy1iZWFyaW5nIGV2aWRlbmNlYCxcbiAgICAgICk7XG4gICAgfVxuICAgIGNvbnN0IG1lcmdlZDogV29ya3NwYWNlSG9zdEFnZW50VmVyaWZpY2F0aW9uRXZpZGVuY2UgPVxuICAgICAgc2VsZlJlcG9ydGVkU3ViamVjdERpZ2VzdFxuICAgICAgICA/IHsgLi4ucmVhZGluZXNzLCBzZWxmUmVwb3J0ZWRTdWJqZWN0RGlnZXN0IH1cbiAgICAgICAgOiByZWFkaW5lc3M7XG4gICAgLy8gVGhlIG1lcmdlIGJ1aWxkcyBhIG5ldyBvYmplY3QgdGhhdCBsZWF2ZXMgdGhpcyBmdW5jdGlvbiwgc28gaXQgZmFjZXMgdGhlIHNhbWUgZ2F0ZSB0aGVcbiAgICAvLyBwcm9iZSdzIG93biBldmlkZW5jZSBkaWQgcmF0aGVyIHRoYW4gaW5oZXJpdGluZyBhIHBhc3MgZnJvbSBiZWZvcmUgdGhlIGZpZWxkIHdhcyBhZGRlZC5cbiAgICBhc3NlcnRXb3Jrc3BhY2VIb3N0U2VjcmV0SXNvbGF0aW9uKFxuICAgICAgbWVyZ2VkLFxuICAgICAgYHdvcmtzcGFjZUhvc3QuYWdlbnRBdXRoZW50aWNhdGlvbi4ke2FnZW50fWAsXG4gICAgKTtcbiAgICBhZ2VudHNbYWdlbnRdID0gbWVyZ2VkO1xuICB9XG4gIGNvbnN0IHJlcG9ydDogV29ya3NwYWNlSG9zdEFnZW50VmVyaWZpY2F0aW9uUmVwb3J0ID0ge1xuICAgIGNvbnRyYWN0VmVyc2lvbjogV09SS1NQQUNFX0hPU1RfQUdFTlRfVkVSSUZJQ0FUSU9OX0NPTlRSQUNUX1ZFUlNJT04sXG4gICAgb2JzZXJ2ZWRBdDogbm93KCkudG9JU09TdHJpbmcoKSxcbiAgICBhbGxSZWFkeTogV09SS1NQQUNFX0hPU1RfQ0FOQVJZX0FHRU5UUy5ldmVyeShcbiAgICAgIChhZ2VudCkgPT4gYWdlbnRzW2FnZW50XT8ucmVhZHkgPT09IHRydWUsXG4gICAgKSxcbiAgICAuLi4oaW5wdXQucmVxdWVzdGVkQWdlbnRzICE9PSB1bmRlZmluZWQgPyB7IHJlcXVlc3RlZEFnZW50cyB9IDoge30pLFxuICAgIGFnZW50cyxcbiAgfTtcbiAgYXNzZXJ0V29ya3NwYWNlSG9zdFNlY3JldElzb2xhdGlvbihcbiAgICByZXBvcnQsXG4gICAgXCJ3b3Jrc3BhY2VIb3N0LmFnZW50QXV0aGVudGljYXRpb24ucmVwb3J0XCIsXG4gICk7XG4gIHJldHVybiByZXBvcnQ7XG59XG4iXSwiZmlsZSI6Ii9AZnMvaG9tZS9tYXJzaC1vZmZpY2UvcGFwZXJjdXBhaS13b3Jrc3BhY2UvcGFwZXJjdXNwL2xpYnMvZ2VuZXJpYy9kZXBsb3ltZW50LWRyaXZlci9zcmMvd29ya3NwYWNlLWhvc3QtYWdlbnQtYXV0aGVudGljYXRpb24udHMifQ==

//# vitestCache=W3siZmlsZSI6IjEiLCJpZCI6IjEiLCJ1cmwiOiIyIiwiaW1wb3J0ZWRVcmxzIjoiMyIsIm1hcHBpbmdzIjpmYWxzZX0sIi9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvbGlicy9nZW5lcmljL2RlcGxveW1lbnQtZHJpdmVyL3NyYy93b3Jrc3BhY2UtaG9zdC1hZ2VudC1hdXRoZW50aWNhdGlvbi50cyIsIi9AZnMvaG9tZS9tYXJzaC1vZmZpY2UvcGFwZXJjdXBhaS13b3Jrc3BhY2UvcGFwZXJjdXNwL2xpYnMvZ2VuZXJpYy9kZXBsb3ltZW50LWRyaXZlci9zcmMvd29ya3NwYWNlLWhvc3QtYWdlbnQtYXV0aGVudGljYXRpb24udHMiLFtdXQ==