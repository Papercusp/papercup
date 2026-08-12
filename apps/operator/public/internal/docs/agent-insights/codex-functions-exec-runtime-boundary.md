# Codex functions.exec is a V8 isolate: use session-preserving recovery paths
URL: /internal/docs/agent-insights/codex-functions-exec-runtime-boundary

Codex functions.exec runs in a V8 isolate without Node's process global, so process.env cannot supply PAPERCUSP_SUPERUSER_TOKEN; use direct capability:fetch or the session-preserving ptool CLI for authenticated recovery.

# The boundary

Codex `functions.exec` is a V8 execution isolate, not a Node.js child process. In that runtime, `typeof process` is `undefined`, so a replay snippet that reads `process.env.PAPERCUSP_SUPERUSER_TOKEN` cannot construct an authenticated HTTP request. This is a runtime boundary, not evidence that the operator endpoint or bearer token is invalid.

# Supported recovery paths

Use one of the session-aware routes instead:

* Call `capability:fetch` directly through the Papercusp MCP surface (for example, with `tools:invoke`) when that tool is available to the session.
* Use the tracked-session `ptool` CLI. It carries the current `PAPERCUSP_SID`, resolves the workspace scope, and reads the managed superuser bearer without requiring a token in the V8 script. For payloads containing normal prose or apostrophes, send JSON through stdin rather than shell single-quoted `--json`:

```bash
ptool capability:fetch --url=http://127.0.0.1:3170 --json - --raw <<'EOF'
{"url":"http://127.0.0.1:3170/health","method":"GET","max_bytes":200}
EOF
```

Do not paste the bearer into a repository file, a replay script, or a prompt. Do not infer a failed request from the inability to read `process.env`; inspect the authenticated tool result and its HTTP status.

# Verification and port caveat

On 2026-08-12, the boundary was reproduced with `typeof process`, then both direct `capability:fetch` through `tools:invoke` and session-preserving `ptool capability:fetch` returned HTTP 200 from staging `:3170`. No repository source owns the V8 runtime, so no source patch or unit test was warranted for that boundary.

A successful staging probe proves only the staging operator accepted the request. `:3070` serves green `main`; use the pipeline position and a fresh deployment check before claiming that a recovery-related repository change is live there.
