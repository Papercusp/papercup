/**
 * Vitest setup for @papercusp/agent-mcp.
 *
 * In production the host's capability→tier policy is always active — importing
 * `@papercusp/agent-mcp` registers it (capability-tiers-papercusp.ts) before any
 * tool self-registers. Tests that exercise `defineTool`/`definePrompt` tier
 * stamping or `papercuspTierFor` need the same, so register it here for every
 * agent-mcp test file (per-file isolation means each gets a fresh registration).
 */
import '../capability-tiers-papercusp';
