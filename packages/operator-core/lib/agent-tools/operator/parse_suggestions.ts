/**
 * operator:parse_suggestions — extract `<suggestion>` JSON blocks
 * from raw LLM text, validate via Zod, enrich with authoritative
 * tier and auto_dispatch.
 *
 * Useful for plugin authors / dev tooling to validate the suggestion
 * blocks an LLM is about to emit before they ship through the live
 * scanner stream. Loads OperatorPreferences automatically; pass
 * `preferencesOverride` to test against a hypothetical preferences
 * state.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { parseSuggestions } from '../../operator-suggestion-parser';
import { loadPreferences, type OperatorPreferences } from '../../operator-preferences';

const ALL_ROLES = [
  'scoper',
  'architect',
  'worker',
  'validator',
  'reviewer',
  'debugger',
  'operator',
  'documenter',
  'curator',
] as const;

export default defineTool({
  name: 'operator:parse_suggestions',
  profile: 'engineer',
  description: 'Extract <suggestion> blocks from text, Zod-validate, and enrich with tier + auto_dispatch derivation.',
  capability: 'operator:read',
  guidance: {
    when: `Parse a free-text suggestion list into structured cards. Internal helper for the scanner pipeline.`,
    notWhen: `User-facing tools should not call this directly — it's a scanner-internal step.`,
  },
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  args: z.object({
    text: z.string().min(1),
    preferencesOverride: z.unknown().optional(),
  }),
  async handler(args) {
    const prefs = (args.preferencesOverride as OperatorPreferences | undefined) ?? (await loadPreferences());
    const result = await parseSuggestions(args.text, prefs);
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  },
});
