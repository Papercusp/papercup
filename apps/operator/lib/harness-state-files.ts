/**
 * Canonical lists of harness state files.
 *
 * These describe the on-disk layout of a harness — they aren't user
 * data, so they live in code rather than the DB. Adding a new file
 * here generally requires accompanying writer/reader/parser changes,
 * so the data + the code that operates on it should ship together.
 *
 * Pre-consolidation, the same arrays were inlined in 5 different
 * functions in apps/operator/app/api/_hono/harness.ts plus
 * harness-markdown-index.ts. They drifted: some included
 * validation-contract.md, others didn't; some included config.json,
 * others didn't. This module makes each list named + reused.
 */

/** Project-root files copied verbatim when forking or templating a harness. */
export const PROJECT_FILES_TO_COPY = ['SPEC.md', 'AGENTS.md'] as const;

/** State files removed when resetting a harness's runtime state ("cleanup"). */
export const STATE_FILES_FOR_RESET = [
  'features.json',
  'validation-contract.md',
  'issues.md',
  'worker-log.md',
  'escalation.md',
  'supervisor-notes.md',
  'lanes.json',
  'prs.json',
] as const;

/** State files backed up to .harness/_backup-<ts>/ before a destructive overwrite. */
export const STATE_FILES_FOR_BACKUP = [
  'features.json',
  'validation-contract.md',
] as const;

/** Project-root files used to detect whether a directory is a valid template. */
export const TEMPLATE_DETECT_FILES = [
  'SPEC.md',
  'AGENTS.md',
  'config.json',
] as const;

/** Files copied (with `.harness/` paths preserved) during fork. */
export const SOURCE_FILES_FOR_FORK = [
  'SPEC.md',
  'AGENTS.md',
  '.harness/config.json',
  '.harness/validation-contract.md',
] as const;

/** Files scanned by the harness markdown indexer. */
export const SCANNED_FILES_FOR_INDEX = [
  'SPEC.md',
  'AGENTS.md',
  '.harness/knowledge.md',
  '.harness/supervisor-notes.md',
  '.harness/validation-contract.md',
] as const;

/** Files included in a harness snapshot (.harness-snapshots/<ts>/). */
export const SNAPSHOT_FILES = [
  'features.json',
  'validation-contract.md',
  'supervisor-notes.md',
  'config.json',
] as const;
