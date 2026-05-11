<!--
Concise summary of what the PR does. Link related issues / plans.
-->

## Tool surface change?

If this PR adds, removes, or changes the role-visibility of any
`defineTool` / plugin manifest tool, complete the checklist below
or explain why it doesn't apply.

- [ ] Added `guidance.when` (and `notWhen` / `chaining` if relevant) to every new tool
- [ ] If a new chat surface or role was added/removed: created/updated `<role>.tools.md`
- [ ] If a tool-behavior rule changed (always-call, tier handling): updated `<role>.persona.md`
- [ ] Ran `node apps/operator/__tests__/integration/tools-md-sync.mjs` — green

See `apps/operator/prompts/operator.tools.md` for the playbook shape and
`packages/agent-mcp/src/types.ts` for the `ToolGuidance` interface.

## Verification

<!-- How did you verify this? Tests, manual smoke, dev-server check, etc. -->
