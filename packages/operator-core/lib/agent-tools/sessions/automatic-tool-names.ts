/**
 * The set of tool names classified as AUTOMATIC (hook/status calls a session makes
 * without agent judgment) rather than AGENT-authored. Shared by sessions:timeline's
 * activity audit and loop.ts's cold-wake evidence check (countAgentToolCallsInWindow,
 * EI-19984789589075138) so the two classifications can't drift apart.
 *
 * Deliberately dependency-free (no `@papercusp/agent-mcp`, no DB client). loop.ts is
 * a core routines module reachable from many lightweight import graphs (tests,
 * scripts, the loop-fire path) — EI-19986796515232861 measured that having loop.ts
 * import this constant from `./timeline` instead pulled in agent-mcp's WHOLE
 * bootstrap chain (timeline.ts imports `defineTool`/`SU_ROLES` from
 * `@papercusp/agent-mcp`, whose index.ts unconditionally `import`s `./bootstrap`,
 * which side-effect-registers the full read-tool catalog, several of which read
 * `generated.*` schema exports from `@papercusp/db-org` AT MODULE LOAD — see EI-362).
 * That silently broke any test importing loop.ts whose db-org mock used a bare
 * factory instead of spreading `importOriginal`. Keep this file free of any import
 * that could reintroduce that chain.
 */
export const AUTOMATIC_TOOL_NAMES = ['activity:report', 'coord:glance', 'coord:inbox'] as const;
