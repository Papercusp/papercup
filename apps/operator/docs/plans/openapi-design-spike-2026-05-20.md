---
title: OpenAPI surface — design spike
slug: openapi-design-spike-2026-05-20
created: 2026-05-20
updated: 2026-05-30
status: shipped
---

## Now

**State:** aafdsg

**Next:** dsgds


# OpenAPI surface — design spike

**Date:** 2026-05-20
**Phase:** 7 of host-architecture v2 (Extend `tools/list` to OpenAPI). The plan calls for a ~30-minute spike on the wire shape before committing to implementation; this is that spike.
**Status:** Design-review. Implementation gated on §6 questions.

---

## 1. What this is and isn't

**Is:** a written answer to "how do we surface our `events:`-schema-array tool definitions as a valid OpenAPI 3.1 document?" The mapping is non-trivial; spec'ing it on paper before writing the codegen avoids re-doing the mapping when an edge case appears.

**Isn't:** an implementation. No code lands from this doc.

**Isn't:** a typed-client codegen story. That's a separate decision (Phase 7 NOT-shipping line).

## 2. What `tools/list` produces today

From `packages/agent-mcp/src/server.ts:368`:

```jsonc
{
  "tools": [
    {
      "name": "operator:scan",
      "description": "Operator's per-turn workspace scan...",
      "inputSchema": { /* JSON Schema from zod via toJSONSchema */ }
    },
    ...
  ]
}
```

What's there:
- `name` — string
- `description` — string
- `inputSchema` — JSON Schema (drafts 2020-12 from zod 4's `toJSONSchema`)

What's missing for OpenAPI parity:
- **Output schema.** `ToolResult` shape (`{ content: [{type:'text',text:string}, ...] }`) is implicit; clients infer.
- **Events schemas.** A tool with `events: { delta: z.object(...), progress: z.object(...) }` advertises nothing to the client about what SSE chunks to expect.
- **State schema.** Tools with `state: z.object(...)` (the publishState path) advertise nothing.
- **Error responses.** Standard error codes (`invalid_input`, `quota_exceeded`, `unauthorized`, `role_not_allowed`, `missing_capability`, `timeout`, `handler_error`) aren't surfaced.
- **Auth requirement.** No `securitySchemes` entry.

The goal of Phase 7 is to plug those gaps in a way that produces a valid OpenAPI 3.1 document.

## 3. Mapping table — defineTool → OpenAPI

| defineTool field | OpenAPI 3.1 location | Notes |
|---|---|---|
| `name: 'operator:scan'` | `paths['/api/operator/scan'].post.operationId` | Path mirrors `name` with `:` → `/`; HTTP verb is the route's actual verb (most are POST). |
| `description` | `paths['/api/...'].post.description` | Verbatim. |
| `args: z.object(...)` | `paths['/api/...'].post.requestBody.content['application/json'].schema` | JSON Schema from `z.toJSONSchema()`. |
| `events: { name: schema }` | `paths['/api/...'].post.responses['200'].content['text/event-stream'].schema` (oneOf discriminator) | See §4. |
| `state: z.object(...)` | An extra discriminated-union arm in the same response schema | See §4.3. |
| `capability: 'foo:bar'` | `paths['/api/...'].post.security: [{ bearerAuth: ['foo:bar'] }]` | Scopes-style. |
| `roles: ['architect', 'scoper']` | `paths['/api/...'].post['x-papercusp-roles']` | Vendor extension; OpenAPI has no role concept. |
| `timeoutSec`, `idleTimeoutSec`, `replayBufferSize` | `paths['/api/...'].post['x-papercusp-{timeoutSec,idleTimeoutSec,replayBufferSize}']` | Vendor extensions. |
| `ToolResult` (non-streaming return) | `paths['/api/...'].post.responses['200'].content['application/json'].schema` | One of the response variants. |
| Dispatch error codes | `responses['400']` / `'401'` / `'403'` / `'408'` / `'429'` / `'500'` | Per-error mapping in §5. |

## 4. SSE response shape — per-event schemas

This is the load-bearing part. OpenAPI 3.1 supports `text/event-stream` responses, but the `schema` for that content describes the **wire format of each event**, not "an SSE stream over time." The standard pattern is `oneOf` + a discriminator on the `event:` field.

### 4.1. A defineTool with events:

```ts
defineTool({
  name: 'operator:scan',
  args: ScanArgsSchema,
  events: {
    progress: z.object({ done: z.number(), total: z.number() }),
    finding: z.object({ severity: z.enum(['info','warn']), text: z.string() }),
  },
  async handler(input, ctx) {
    ctx.emit('progress', { done: 0, total: 100 });
    ...
    ctx.emit('finding', { severity: 'warn', text: '...' });
    ...
    return { content: [{ type: 'text', text: 'done' }] };
  },
});
```

### 4.2. Becomes this OpenAPI fragment

```yaml
paths:
  /api/operator/scan:
    post:
      operationId: operator:scan
      description: Operator's per-turn workspace scan...
      x-papercusp-roles: [operator]
      x-papercusp-replayBufferSize: 64
      security:
        - bearerAuth: ['operator:scan']
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/operator:scan.Input'
      responses:
        '200':
          description: Tool completed successfully.
          content:
            text/event-stream:
              schema:
                oneOf:
                  - $ref: '#/components/schemas/operator:scan.Event.progress'
                  - $ref: '#/components/schemas/operator:scan.Event.finding'
                  - $ref: '#/components/schemas/operator:scan.Event.done'   # framework-emitted
                  - $ref: '#/components/schemas/operator:scan.Event.chunk'  # framework-emitted (outputRef)
                discriminator:
                  propertyName: event
                  mapping:
                    progress: '#/components/schemas/operator:scan.Event.progress'
                    finding:  '#/components/schemas/operator:scan.Event.finding'
                    done:     '#/components/schemas/operator:scan.Event.done'
                    chunk:    '#/components/schemas/operator:scan.Event.chunk'
            application/json:
              # The terminal result (non-streaming consumers).
              schema:
                $ref: '#/components/schemas/operator:scan.ToolResult'
        '400': { $ref: '#/components/responses/InvalidInput' }
        '401': { $ref: '#/components/responses/Unauthorized' }
        '403': { $ref: '#/components/responses/RoleOrCapabilityDenied' }
        '408': { $ref: '#/components/responses/Timeout' }
        '429': { $ref: '#/components/responses/QuotaExceeded' }
        '500': { $ref: '#/components/responses/HandlerError' }

components:
  schemas:
    'operator:scan.Event.progress':
      type: object
      required: [event, data]
      properties:
        event:
          type: string
          enum: [progress]
        id:
          type: integer
          description: Monotonic event id (replay-buffer key).
        data:
          type: object
          required: [done, total]
          properties:
            done: { type: integer }
            total: { type: integer }
    'operator:scan.Event.finding':
      type: object
      required: [event, data]
      properties:
        event:
          type: string
          enum: [finding]
        id: { type: integer }
        data:
          type: object
          required: [severity, text]
          properties:
            severity: { type: string, enum: [info, warn] }
            text: { type: string }
    'operator:scan.Event.done':
      type: object
      required: [event, data]
      properties:
        event:
          type: string
          enum: [done]
        id: { type: integer }
        data:
          $ref: '#/components/schemas/operator:scan.ToolResult'
    'operator:scan.Event.chunk':
      type: object
      required: [event, data]
      properties:
        event:
          type: string
          enum: [chunk]
        id: { type: integer }
        data:
          type: object
          required: [ref]
          properties:
            ref: { type: string }
            byteSize: { type: integer }
```

### 4.3. State-shaped tools

For tools that declare `state: z.object(...)`, the SSE stream emits `state` events with the snapshot as data. The schema for these is `state: stateSchema` instead of `events: {...}`:

```yaml
text/event-stream:
  schema:
    oneOf:
      - $ref: '#/components/schemas/myTool.Event.state'
      - $ref: '#/components/schemas/myTool.Event.done'
    discriminator:
      propertyName: event
      mapping:
        state: '#/components/schemas/myTool.Event.state'
        done:  '#/components/schemas/myTool.Event.done'
```

`done` is always present (framework-emitted at handler return). `chunk` is conditional on `outputRef` being set on the returned `ToolResult`.

### 4.4. Reserved event names

The framework reserves `done`, `chunk`, `state`. The `define-tool` registry already rejects user-declared events with these names. The OpenAPI emitter relies on this — it adds `done` (always), `chunk` (when `outputRef` is plausible), and `state` (when the tool declares `state:`) to the `oneOf` without collision risk.

## 5. Error response mapping

The dispatcher's `DispatchProjectedErrorCode` is a typed string. Mapping to HTTP status + OpenAPI response component:

| `errorCode` | HTTP | OpenAPI component |
|---|---|---|
| `invalid_input` | 400 | `#/components/responses/InvalidInput` |
| `unauthorized` | 401 | `#/components/responses/Unauthorized` |
| `role_not_allowed` | 403 | `#/components/responses/RoleOrCapabilityDenied` |
| `missing_capability` | 403 | `#/components/responses/RoleOrCapabilityDenied` |
| `quota_exceeded` | 429 | `#/components/responses/QuotaExceeded` |
| `timeout` | 408 | `#/components/responses/Timeout` |
| `handler_error` | 500 | `#/components/responses/HandlerError` |
| `unknown_tool` | 404 | `#/components/responses/UnknownTool` |

Each component is a `{ description, content: { 'application/json': { schema: { type: 'object', properties: { error: ErrorEnvelope } } } } }` shape. `ErrorEnvelope` matches `DispatchProjectedResult.error`.

## 6. Open questions (block implementation)

### Q1. Streaming framing — what does the framework write on the wire?

OpenAPI 3.1's `text/event-stream` schema describes one event's *parsed* JSON shape (`{ event, id?, data }`). The actual wire format is the SSE protocol (`event: <name>\n` `id: <n>\n` `data: <json>\n\n`). Our existing `@restart/sse` library writes this format. The OpenAPI doc would document the parsed schema and rely on the reader's SSE parser to deserialize.

**Recommend:** document the parsed shape. Don't try to encode the SSE prefix grammar; that's outside OpenAPI's vocabulary.

### Q2. Discriminator name — `event` vs `type`?

OpenAPI requires the discriminator field be a real property on every variant. We could:

- **(a)** Add `event: 'progress'` (string literal) to every event payload, so the wire data is `{ event: 'progress', data: {...} }`.
- **(b)** Use `data` as the only payload and put the type in the SSE `event:` line; pre-deserialize the SSE event into `{ event, data }` shape at the client.

**(b)** is what fetches typically do (`EventSource` already exposes `MessageEvent.type`). Schema describes the parsed shape; the discriminator points at the field the parser fills.

**Recommend (b).** Matches existing client conventions; minimal wire overhead.

### Q3. Tool-name as path — colon-in-URL question

`operator:scan` contains a colon. URL-safe but uncommon in paths. Two options:

- **(a)** Keep the colon: `/api/operator:scan`. Hono accepts; tooling varies.
- **(b)** Convert to slash: `/api/operator/scan`. Common but ambiguous when a tool name has multiple colons (`harness:plugins:list`).

**Recommend (a)** — preserves the 1:1 between tool name and operationId. Some OpenAPI codegens (mostly Java) choke on colons in paths; codegen consumers can apply a transform if needed.

### Q4. Should the OpenAPI doc be served at a route or built at compile time?

- **(a) Compile-time:** `npm run build:openapi` produces `apps/operator/dist/openapi.json`. Static file, no runtime overhead.
- **(b) Runtime:** `GET /api/openapi.json` reads from `getCatalog()` + emits live. Always-fresh.

**Recommend hybrid:** both, with the runtime endpoint as canonical and the compile-time build as a CI artifact for snapshot tests. The runtime cost is negligible; the build artifact catches drift in PR review.

### Q5. Vendor extensions namespace

We need a prefix for our custom fields. Existing precedent: `x-papercusp-*`.

**Recommend:** stick with `x-papercusp-*`. Document the full set in this doc when implementation lands.

### Q6. Plugin-supplied tools — same shape?

Plugins ship `defineTool` exports. The runtime mounts them via `mountPluginApiRoutes`. The OpenAPI emitter walks the same registry (`getCatalog()`) for them, no special case. Plugin-private auth scopes get the same `bearerAuth: ['<scope>']` treatment.

**Recommend:** yes, same shape, no plugin-side extension surface needed in v1.

## 7. Implementation order (after RFC sign-off)

1. **JSON Schema fragments emitter.** Given a `ProjectedTool`, produce the components.schemas entries (Input, ToolResult, Event.<name> for each event, Event.done, Event.chunk, Event.state). ~150 LoC + tests. Acceptance: round-trip a sample tool through Zod → JSON Schema → AJV validate against the original sample data.

2. **OpenAPI assembler.** Walk `getCatalog()`, emit the paths + components dict. Compose with a fixed `info` + `components.securitySchemes` + `components.responses`. ~200 LoC. Acceptance: output validates against the OpenAPI 3.1 spec (run `npx @redocly/cli lint` in CI).

3. **Routes**: `GET /api/openapi.json` (runtime) + `apps/operator/scripts/openapi-build.mjs` (compile-time CI artifact).

4. **Integration test.** Pick `dev:ipc_echo` (a small streaming tool with all three event variants). Drive `/api/dev/ipc_echo` with a real client, parse the SSE stream, validate every event against the schema in the openapi.json output.

5. **CI gate.** PR fails if `openapi-build.mjs` produces a different output than the checked-in `apps/operator/openapi.snapshot.json`. Diff-on-PR is the drift detector.

Estimated effort: ~1 week. Lower than the original plan estimate because the dispatcher refactor (Phase 3a) already exposed the typed surfaces needed.

## 8. NOT shipping (Phase 7 boundary)

- **Typed-client codegen.** Consumers can run `openapi-typescript` against `/api/openapi.json` themselves; we don't ship a typed SDK from this phase.
- **Regenerating defineTool from OpenAPI.** Inverse codegen is a different decision; not in scope.
- **Per-event documentation strings.** v1 emits the schema only. Adding `description:` per-event needs `events:` to support a richer shape than `{ name: zodSchema }`; deferred.

## 9. Day-0 benchmark gate

From the prior plan review: openapi-build should not measurably regress the operator's boot or `tools/list` latency. Acceptance gate:

- Build time on a clean repo: < 500ms for the full catalog.
- `tools/list` HTTP response time: indistinguishable from the pre-refactor baseline (which is < 50ms p99). Measured via the existing `tool_invocations.duration_ms`.

If either misses, the build step gets gated behind an env flag (`PAPERCUSP_OPENAPI_BUILD=1`) and runs only in CI / `npm run build`, not on every operator boot.

## 10. References

- OpenAPI 3.1 spec: <https://spec.openapis.org/oas/v3.1.0>
- SSE in OpenAPI (community patterns): the `oneOf` + discriminator approach is the established convention; no spec-level SSE shape was ever added.
- zod 4 `toJSONSchema`: in-tree at `packages/agent-mcp/src/server.ts:376` (current usage).
- Existing schema-surfacing path: `ListToolsRequestSchema` handler in `packages/agent-mcp/src/server.ts:368`.
- Tool definition shape: `packages/agent-mcp/src/define-tool.ts` (args / events / state / capability / roles fields).
