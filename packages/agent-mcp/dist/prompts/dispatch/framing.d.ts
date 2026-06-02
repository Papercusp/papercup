/**
 * `dispatch:framing` — small template Oracle uses when delegating to
 * an agent role via dispatchToAgent. Args:
 *   - role: target role (architect, orchestrator, …)
 *   - context: short plain-English description of what's being asked
 *   - feature: optional feature/issue id
 *
 * Returns the canonical first-message wording. Centralizing this lets
 * Oracle/delegate emit consistent dispatch messages and lets external
 * agents borrow the convention.
 */
declare const _default: import("@papercusp/tooldef").PromptDefinition;
export default _default;
