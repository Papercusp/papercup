/**
 * Recurrence guard for WI-10002186, extended for P-007.
 *
 * Clause AUTO-BAR-R-10-P-007@2 required that "the prompt text delivered to a
 * freshly launched session states that the agent must promote or dismiss each
 * captured directive, for both the engineer and the power su role", and named
 * its own falsifier: "the instruction is present only in a generated or legacy
 * copy that no live session is launched from." Plan
 * `owner-directive-delivery-redesign-2026-09-22` (D-001) removed the triage, so
 * the instruction this guards is now "every turn lands open and closes only by
 * disposition" — the same live-launch falsifier still applies to it.
 *
 * So the subject here is deliberately the LIVE launch composition: this renders
 * through `renderSuPlaybook`, the same function `role-launch-spec.ts` calls to
 * build a real psu launch, over the same base a real launch supplies.
 *
 * MEASURED LAUNCH FACTS — recorded because two plausible-sounding anti-vacuity
 * controls are structurally IMPOSSIBLE here, and both were tried (and wrongly
 * suspected of being a product bug) before this note existed:
 *
 *  - `baseSource` cannot discriminate the profiles. `SU_BLUEPRINT_PERSONA` is
 *    DEFAULT-ON, so a live launch resolves the base through the blueprint
 *    prompt-resolve chain (`blueprints/base/prompts/su.md`) and passes it
 *    EXPLICITLY, for both profiles alike; `playbookCandidates(profile)` — which
 *    is what would pick `papercusp-su-<profile>.tools.md` — is bypassed on that
 *    path. (It also does not fall back to engineer for `power`: only `generic`
 *    has a fallback candidate, every other profile is single-candidate and
 *    throws on a miss.)
 *  - `overlaySource` cannot discriminate them either: it is the per-AGENT
 *    overlay (`papercusp-su.<agent>.md`), profile-invariant by construction.
 *
 * The one thing `profile` actually changes in this render is
 * `injectSharedBaseNotes({ repoSpecific: profile === 'engineer' })`, which adds
 * the repo-specific deploy-pipeline note for engineer only. That is therefore
 * the real anti-vacuity control, and it is asserted in BOTH directions —
 * present for engineer, ABSENT for power. Without it `power` could silently
 * render as a duplicate engineer case and this file would still be green.
 */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSuPlaybook } from './desktop-install/papercusp-files';
import ordersList from './agent-tools/orders/list';
import ordersDisposition from './agent-tools/orders/disposition';

const REPO_ROOT = join(fileURLToPath(new URL('../../../', import.meta.url)));
const DEFAULT_BLUEPRINT_SU = join(
  REPO_ROOT,
  'libs',
  'papercusp',
  'packages',
  'harness',
  'blueprints',
  'base',
  'prompts',
  'su.md',
);
/**
 * Overridable so a mutation probe can point the subject at a COPY outside the
 * shared checkout (CLAUDE.md "proving a guard is falsifiable", tier 2) instead
 * of mutating a tracked file that git-sync would sweep into a commit.
 */
const BLUEPRINT_SU = process.env.PAPERCUSP_SU_BASE_SOURCE ?? DEFAULT_BLUEPRINT_SU;
const OPERATOR_PROMPTS = join(REPO_ROOT, 'apps', 'operator', 'prompts');

/**
 * The measured profile discriminator (see the header): the repo-specific note
 * `renderDeployPipelineNote()` emits, injected only when `repoSpecific` is true.
 */
const ENGINEER_ONLY_NOTE = '## The deploy pipeline is ASYNC';

const SU_PROFILES = ['engineer', 'power'] as const;

describe('rendered SU persona — owner-directive capture and resolution (WI-10002186, P-007)', () => {
  it.each(SU_PROFILES)(
    'keeps capture and next-turn resolution instructions in the live %s render',
    async (profile) => {
      const rendered = await renderSuPlaybook({
        agent: 'claude',
        profile,
        baseSource: BLUEPRINT_SU,
        overlayDir: OPERATOR_PROMPTS,
        projectGuideSource: '',
        renderWireSchemas: () => '',
      });

      expect(rendered.baseSource).toBe(BLUEPRINT_SU);

      // ANTI-VACUITY, both directions: proves `profile` is load-bearing in THIS
      // render, so the power case is not the engineer case run twice.
      expect(rendered.text.includes(ENGINEER_ONLY_NOTE)).toBe(profile === 'engineer');

      // The clause itself reaches BOTH roles: every turn lands open (D-001),
      // closes only by disposition, and a long one is shown through a summary
      // (D-004). The retired promote/dismiss triage must be gone from both.
      expect(rendered.text).toContain('## Owner directives — durable capture and resolution');
      expect(rendered.text).toContain('records the turn verbatim as an OPEN row, and there is no triage step');
      expect(rendered.text).toContain("orders:disposition { id, status: 'done'|'declined', note }");
      expect(rendered.text).toContain('orders:summarize { id, summary }');
      expect(rendered.text).toContain('orders:clear { id, reason }');
      expect(rendered.text).not.toContain('orders:resolve-pending');
      expect(rendered.text).not.toMatch(/\borders:list\s*\{\s*status\b/);

      // The live prompt and the registered tools must describe the same lifecycle.
      expect(ordersList.name).toBe('orders:list');
      expect(Object.keys(ordersList.args.shape)).toEqual(['open', 'state', 'limit']);
      expect(ordersList.args.shape.state.safeParse('open').success).toBe(true);
      expect(ordersList.args.shape.state.safeParse('pending').success).toBe(false);

      expect(ordersDisposition.name).toBe('orders:disposition');
      expect(Object.keys(ordersDisposition.args.shape)).toEqual(['id', 'status', 'note', 'items']);
      expect(ordersDisposition.args.shape.status.safeParse('done').success).toBe(true);
      expect(ordersDisposition.args.shape.status.safeParse('promote').success).toBe(false);
    },
  );
});
