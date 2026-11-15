/** Explicit local-work attribution through the existing admission transaction. */
import { pinModuleState } from '@papercusp/module-singleton';
import type { Sql } from 'postgres';
import { githubRepoOf } from '../harness/git-sync/standing-pr';
import { harnessSlugMatches, pickPhysicalSlug } from '../work-items-physical-row';
import {
  EXISTING_WORK_KINDS, registerAdmissionSource, type AdmissionSourceResolver,
  type AdmissionRefusal,
} from './admission-sources';
import { checkPrDelivery, type PrDeliveryDeps } from './pr-delivery';

export interface ExistingWorkRef {
  workItemId: string;
  workItemHarness: string;
  forkRemote: string;
}

const refused = (code: string, message: string): AdmissionRefusal => ({ refused: true, code, message });

export function createExistingWorkAdmissionSource(deps: { prDelivery?: PrDeliveryDeps } = {}): AdmissionSourceResolver<ExistingWorkRef> {
  return {
    kind: 'work-item',
    parseRef(raw) {
      const read = (key: keyof ExistingWorkRef) => {
        const value = typeof raw[key] === 'string' ? raw[key].trim() : '';
        if (!value || value.length > 500) throw new Error(`admission_source_invalid: work-item source needs ${key}`);
        return value;
      };
      const ref = { workItemId: read('workItemId'), workItemHarness: read('workItemHarness'), forkRemote: read('forkRemote') };
      if (!githubRepoOf(ref.forkRemote)) throw new Error('admission_source_invalid: forkRemote must name a GitHub repository');
      return ref;
    },
    async resolve(ctx, ref) {
      if (ctx.admitter.via !== 'person') return refused('existing_work_requires_person', 'Local work requires explicit person admission.');
      const route = await checkPrDelivery(ctx.workspaceId, ctx.harness, { sql: ctx.db as Sql, deps: deps.prDelivery });
      if (!route.ok) return { refused: true, ...route };
      const fork = githubRepoOf(route.forkRemote)?.toLowerCase();
      if (!fork || fork !== githubRepoOf(ref.forkRemote)?.toLowerCase()) {
        return refused('existing_work_route_conflict', 'forkRemote does not match the target harness review repository.');
      }
      // Count every physical candidate before filtering nature/kind. The row lock
      // serializes concurrent adoptions of this item even when the target differs.
      const rows = await ctx.db<Array<{
        feature_id: string; harness_slug: string; item_kind: string; nature: string;
        title: string; summary: string | null; origin: string | null;
      }>>`SELECT feature_id, harness_slug, item_kind, nature, title, summary, origin
          FROM harness_shared.work_items
         WHERE workspace_id = ${ctx.workspaceId} AND feature_id = ${ref.workItemId}
         ORDER BY harness_slug FOR UPDATE`;
      let home: string | null;
      try { home = pickPhysicalSlug(rows.map(row => row.harness_slug), ref.workItemHarness, { id: ref.workItemId, workspaceId: ctx.workspaceId }); }
      catch (error) { return refused('work_item_id_ambiguous', String(error)); }
      const row = rows.find(candidate => candidate.harness_slug === home);
      if (!row) return refused('source_not_found', 'No existing work item in this workspace.');
      if (!harnessSlugMatches(row.harness_slug, ref.workItemHarness)) return refused('existing_work_home_conflict', 'The requested physical home does not match the work item.');
      if (row.nature !== 'work' || !EXISTING_WORK_KINDS.includes(row.item_kind as 'bug' | 'change') || row.origin === 'remote') {
        return refused('existing_work_kind_invalid', 'Only local work-nature bugs and changes may be adopted.');
      }
      return {
        dataSourceId: null, sourceKey: JSON.stringify([row.harness_slug, row.feature_id]),
        title: row.title, body: row.summary ?? '',
        existingWorkItem: { id: row.feature_id, harness: row.harness_slug, kind: row.item_kind as 'bug' | 'change' },
        sourceRef: { workItemId: row.feature_id, workItemHarness: row.harness_slug, targetHarness: ctx.harness, forkRemote: `https://github.com/${fork}.git` },
      };
    },
  };
}

export const existingWorkAdmissionSource = pinModuleState('@papercusp/operator-core.work-admission.existing-work', () => createExistingWorkAdmissionSource());
registerAdmissionSource(existingWorkAdmissionSource);
