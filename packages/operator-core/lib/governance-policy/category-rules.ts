/** Shared authored policy vocabulary. Keep this module free of host/store I/O:
 * portable identity parsing and governance control consume the same rules. */
import { z } from 'zod';

/** Processing-route derives providers and regions from the actual API host. */
export const GOVERNED_CATEGORIES = ['models', 'providers', 'regions', 'tools', 'plugins', 'egress', 'dataUse', 'actions', 'resources'] as const;
export type GovernedCategory = (typeof GOVERNED_CATEGORIES)[number];

export const CategoryRuleSchema = z.object({
  /** When present, only matching values pass; an empty list denies everything. */
  allow: z.array(z.string()).optional(),
  /** Deny beats allow within a layer. */
  deny: z.array(z.string()).optional(),
});
export type CategoryRule = z.infer<typeof CategoryRuleSchema>;

/** Portable authoring is closed at both category and rule-key boundaries. The
 * control API keeps its existing separate validation/diagnostic contract. */
export const GovernedRulesSchema = z.partialRecord(z.enum(GOVERNED_CATEGORIES), CategoryRuleSchema.strict());
