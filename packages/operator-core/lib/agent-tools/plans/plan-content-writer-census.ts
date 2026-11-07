/** Shared detector for the maintained plan revision/hash census and committed proof instrument. */
import { stripCommentsOnly } from '../../../../../scripts/lib/strip-comments-and-strings.mjs';

export const PLAN_WRITER_SCAN_ROOTS = ['packages/operator-core/lib', 'apps/operator/lib'] as const;

/** Isolated fixture writers do not mutate canonical plans or their revision spine. */
export const PLAN_WRITER_EXEMPTIONS: Readonly<Record<string, string>> = {
  'packages/operator-core/lib/search/lexical/test-pg/bm25-test-db.ts':
    'Seeds a minimal harness_plans corpus in its private testcontainer database, which has no plan_revisions or content_hash columns.',
};

export function isPlanWriterSourcePath(path: string): boolean {
  return PLAN_WRITER_SCAN_ROOTS.some(root => path.startsWith(`${root}/`))
    && path.endsWith('.ts') && !/\.(?:test|spec|d)\.ts$/.test(path)
    && !path.split('/').some(part => part === 'node_modules' || part === '__tests__' || part.startsWith('.'));
}

const RAW_INSERT = /INSERT\s+INTO\s+harness_shared\.harness_plans\b/;
const RAW_UPDATE = /UPDATE\s+harness_shared\.harness_plans\b/g;
const SETS_CONTENT = /\bcontent\s*=/;
const RECORDER =
  /\b(?:recordSystemPlanRevisionInTransaction|recordPlanRevisionInTransaction|recordPlanRevision|insertSystemPlanRevision)\s*\(|INSERT\s+INTO\s+harness_shared\.plan_revisions\b/;

/** File-level recorder rule; callers strip comments while retaining SQL strings. */
export function writesPlanContent(src: string): boolean {
  if (RAW_INSERT.test(src)) return true;
  for (const m of src.matchAll(RAW_UPDATE)) {
    const tail = src.slice(m.index! + m[0].length, m.index! + m[0].length + 1200);
    const where = tail.search(/\bWHERE\b/);
    if (SETS_CONTENT.test(where === -1 ? tail : tail.slice(0, where))) return true;
  }
  return false;
}

export function recordsRevision(src: string): boolean {
  return RECORDER.test(src);
}

const INSERT_COLUMNS = /INSERT\s+INTO\s+harness_shared\.harness_plans\s*(?:AS\s+\w+\s*)?\(([^)]*)\)/g;
const SETS_CONTENT_HASH = /\bcontent_hash\s*=/;

/** Per-statement hash rule: a recorded sibling statement does not excuse a missing hash. */
export function contentWritesWithoutHash(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(INSERT_COLUMNS)) {
    const cols = m[1]!.split(',').map(c => c.trim());
    if (cols.includes('content') && !cols.includes('content_hash')) out.push(m[0].replace(/\s+/g, ' ').slice(0, 160));
  }
  for (const m of src.matchAll(RAW_UPDATE)) {
    const tail = src.slice(m.index! + m[0].length, m.index! + m[0].length + 1200);
    const where = tail.search(/\bWHERE\b/);
    const setClause = where === -1 ? tail : tail.slice(0, where);
    if (SETS_CONTENT.test(setClause) && !SETS_CONTENT_HASH.test(setClause)) {
      out.push(`${m[0]}${setClause}`.replace(/\s+/g, ' ').slice(0, 160));
    }
  }
  return out;
}

export interface PlanContentWriter {
  file: string;
  recorded: boolean;
  missingHashes: string[];
  exemption: { reason: string; valid: boolean } | null;
}

export function scanPlanContentWriter(file: string, raw: string): PlanContentWriter | null {
  if (!isPlanWriterSourcePath(file) || !raw.includes('harness_shared.harness_plans')) return null;
  const src = stripCommentsOnly(raw, file);
  if (!writesPlanContent(src)) return null;
  const reason = PLAN_WRITER_EXEMPTIONS[file];
  return {
    file,
    recorded: recordsRevision(src),
    missingHashes: contentWritesWithoutHash(src),
    exemption: reason === undefined ? null : {
      reason,
      valid: reason.trim().length > 0
        && /CREATE\s+TABLE\s+harness_shared\.harness_plans\b/.test(src)
        && src.includes('CREATE DATABASE') && !/\bgetOrgPg\s*\(/.test(src),
    },
  };
}

export function planContentWriterCensusOutput(writers: readonly PlanContentWriter[]) {
  const sorted = [...writers].sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  return {
    schemaVersion: 1,
    writers: sorted,
    missingExemptions: Object.keys(PLAN_WRITER_EXEMPTIONS).filter(file => !sorted.some(w => w.file === file)).sort(),
  };
}
