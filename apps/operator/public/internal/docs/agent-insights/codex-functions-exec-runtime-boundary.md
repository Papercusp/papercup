# Codex functions.exec is a V8 isolate: use session-preserving recovery paths
URL: /internal/docs/agent-insights/codex-functions-exec-runtime-boundary

Codex functions.exec has no Node process environment; capability:fetch deliberately does not forward MCP credentials, so use the tracked-session ptool CLI for authenticated local agent-tools staging verification.

# The boundary

Codex `functions.exec` is a V8 execution isolate, not a Node.js child process. In that runtime, `typeof process` is `undefined`, so a replay snippet that reads `process.env.PAPERCUSP_SUPERUSER_TOKEN` cannot construct an authenticated HTTP request. This is a runtime boundary, not evidence that the operator endpoint or bearer token is invalid.

# Supported recovery paths

Use a session-aware route:

* Call `capability:fetch` directly through the Papercusp MCP surface when the target endpoint is public or the caller supplies the target service's own safe headers. `capability:fetch` is a generic outbound request and deliberately does **not** forward the calling MCP/superuser bearer to arbitrary URLs.
* For authenticated local Papercusp HTTP projections, use the tracked-session `ptool` CLI. It carries the current `PAPERCUSP_SID`, resolves workspace scope, and reads the managed superuser bearer inside its transport process. This is the supported way to verify staging `/api/agent-tools/*` routes such as `release:trace`; do not paste the bearer into a replay script or prompt. For payloads containing normal prose or apostrophes, send JSON through stdin:

```bash
ptool release:trace --url=http://127.0.0.1:3170 --json - <<'EOF'
{"path":"packages/operator-core/lib/agent-tools/release/trace.ts"}
EOF
```

# Verification and port caveat

On 2026-08-12, a direct `capability:fetch` POST to staging `/api/agent-tools/release/trace` returned HTTP 500 `handler_error` because the nested request had no verified power-user, principal, or signed-spawn identity. `ptool release:trace --url=http://127.0.0.1:3170` succeeded with the same target, proving the transport/authentication distinction. A direct `capability:fetch` health request can still return HTTP 200; that does not prove an authenticated agent-tools projection will accept the nested request.

`:3070` serves green `main`; use pipeline position and a fresh deployment check before claiming that a recovery-related repository change is live there.
