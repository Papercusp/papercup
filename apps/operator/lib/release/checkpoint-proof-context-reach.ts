/** Ref-pinned preparation for the existing composed-proof shadow. No execution or reuse grant. */
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createProofContextIdentity } from '@papercusp/test-config/configuration-snapshot';
import { captureRecordedProofContext } from '@papercusp/test-config/execution-details';
import { captureProofContextReach, capturedProofContextComponents, compareProofContextReach,
  type ProofContextReachCapture, type ProofContextReachCaptureInput,
  type ProofContextReachSelection } from '@papercusp/operator-core/lib/release/proof-context-reach';
import { expandSelectionCommands } from '../../../../scripts/lib/related-tests.mjs';
import { scriptCommandWords } from '../../../../scripts/lib/executed-source-map.mjs';
import { listFilesIncludingUntracked } from '../../../../scripts/lib/tracked-files.mjs';
import { expandWorkspaces } from '../../../../scripts/assert-workspace-links.mjs';

export const CHECKPOINT_PROOF_CONTEXT_SELECTION_ARGS = ['--all', '--print-selection', '--enumerate-specifications'] as const;
export const CHECKPOINT_SPA_CONFLICT_MARKER_ARGS = [
  'grep', '-n', '-I', '-E', '^(<{7}|>{7}|\\|{7})([ \\t]|$)', '--', '.',
] as const;

/** The actual invocation, shared with execution and retained-outcome validation.
 * Describing a native command does not measure its inputs or authorize reuse.
 */
export function checkpointPostSuiteCommandArgv(id: string, spaWorkspace = ''): string[] | null {
  if (id === 'spa:conflict-markers') return ['git', ...CHECKPOINT_SPA_CONFLICT_MARKER_ARGS];
  if (id === 'build') return spaWorkspace ? ['npm', '--workspace', spaWorkspace, 'run', 'build'] : null;
  return /^[\w:.-]+$/.test(id) ? ['npm', 'run', id] : null;
}

type Legs = ProofContextReachCaptureInput['legs'];
export interface CheckpointProofContextCapture {
  ref: string;
  context: ReturnType<typeof createProofContextIdentity>;
  reach: ProofContextReachCapture;
}

/** Resolve local Node modules, explicit loader modules and file operands, including
 * npm aliases/lifecycle commands. These are graph entry points, not runtime closure.
 * Workspace dispatch resolves the configured package, never a root build alias.
 * Shell, native programs and external CLIs remain unmeasured.
 */
export function checkpointProofContextLegEntries(root: string,
  definitions: readonly { id: string; commands: readonly string[] }[], spaWorkspace = ''): Legs | null {
  try {
    root = realpathSync(root);
    const manifest = (file: string) => {
      const absolute = path.resolve(root, file);
      if (realpathSync(absolute) !== absolute) throw new Error('manifest-symlink-unsupported');
      return JSON.parse(readFileSync(absolute, 'utf8'));
    };
    const pkg = manifest('package.json');
    const workspace = () => {
      const patterns = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
      if (!Array.isArray(patterns) || patterns.some(value => typeof value !== 'string')) return null;
      const census = listFilesIncludingUntracked(root);
      if (census.unscanned.length) return null;
      const dirs = [...new Set((census.files as string[]).filter(file => path.posix.basename(file) === 'package.json')
        .map(file => path.posix.dirname(file)))];
      if (dirs.length > 4096) return null;
      const enrolled = expandWorkspaces(patterns, root, { directories: dirs }).sort();
      // npm discovers workspaces from the filesystem, including Git-ignored
      // manifests. An enrolled-only census can hide a duplicate name or a
      // different dispatch target. Such inputs have no source custody here.
      const discovered = expandWorkspaces(patterns, root).sort();
      if (discovered.length > 4096 || enrolled.length !== discovered.length
        || enrolled.some((dir, index) => dir !== discovered[index])) return null;
      const matches = enrolled.map(dir => {
        if (path.isAbsolute(dir) || dir.split('/').some(part => !part || part === '.' || part === '..'))
          throw new Error('workspace-path-invalid');
        return { dir, pkg: manifest(`${dir}/package.json`) };
      }).filter(entry => entry.dir === spaWorkspace || entry.pkg.name === spaWorkspace);
      return matches.length === 1 ? matches[0]! : null;
    };
    return definitions.map(leg => {
      const entries = new Set<string>(['package.json']);
      const executionDirs = new Set<string>();
      for (const command of leg.commands) {
        const argv = checkpointPostSuiteCommandArgv(command, spaWorkspace);
        if (!argv || argv[0] !== 'npm') return null;
        const selected = command === 'build' ? workspace() : { dir: '.', pkg };
        if (!selected || !selected.pkg.scripts || typeof selected.pkg.scripts !== 'object') return null;
        executionDirs.add(selected.dir);
        if (executionDirs.size > 1) return null;
        entries.add(path.posix.join(selected.dir, 'package.json'));
        const scripts = selected.pkg.scripts;
        for (const step of expandSelectionCommands(scripts, command)) {
          const words = scriptCommandWords(step.command);
          if (!/^node\s+/.test(step.command) || words[0] !== 'node'
            || /[;&|`$<>\n\r]/.test(step.command)) return null;
          const localModule = (word: string | undefined): string | null => {
            const file = word?.replace(/^\.\//, '');
            return file && /^[\w./-]+\.[cm]?[jt]s$/.test(file) && !path.isAbsolute(file)
              && !file.split('/').some(part => !part || part === '.' || part === '..')
              ? path.posix.join(selected.dir, file) : null;
          };
          let index = 1;
          while (words[index]?.startsWith('-')) {
            const option = words[index++]!;
            if (option === '--') break;
            // Only Node's explicit local module loaders have a maintained file
            // interpretation here. Flags such as --conditions need their own
            // semantic adapter; never guess their input/selection effects.
            const match = /^(--import|--require|-r)(?:=(.+))?$/.exec(option);
            if (!match) return null;
            const loader = localModule(match[2] ?? words[index++]);
            if (!loader) return null;
            entries.add(loader);
          }
          const main = localModule(words[index++]);
          if (!main) return null;
          entries.add(main);
          // Explicit test files are inputs too (e.g. lint:design-primitives).
          // Arbitrary options, directories and indirect operands stay unknown.
          for (; index < words.length; index++) {
            const operand = localModule(words[index]);
            if (!operand) return null;
            entries.add(operand);
          }
        }
      }
      const dir = [...executionDirs][0];
      return { id: leg.id, entryFiles: [...entries].sort(), ...(dir && dir !== '.' ? { workspaceDir: dir } : {}) };
    }).reduce<Legs | null>((rows, row) => rows && row ? [...rows, row] : null, []);
  } catch { return null; }
}

/** One shared checkpoint root is reused by setupTree: finish and detach OLD before setting
 * up NEW. Verify HEAD and dirt on both sides of selector/capture; never use today's graph twice.
 * Source/selection preparation does not measure worker configuration, runtime, DB or fixtures.
 */
export async function captureCheckpointProofContextAtRef(input: {
  ref: string;
  setupTree(ref: string): Promise<string>;
  readTree(root: string): Promise<{ head: string; dirty: boolean }>;
  select(root: string): Promise<{ code: number; stdout: string }>;
  legs(root: string): Legs | null;
}): Promise<CheckpointProofContextCapture> {
  const unknown = (reason: string): CheckpointProofContextCapture => ({ ref: input.ref, context: null,
    reach: { status: 'unknown', reason } });
  try {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.ref)) return unknown('source-ref-not-pinned');
    const root = await input.setupTree(input.ref);
    const before = await input.readTree(root);
    if (before.head !== input.ref || before.dirty) return unknown('source-ref-mismatch-or-dirty');
    // No full native discovery when a known prerequisite already forbids composition.
    const legs = input.legs(root);
    if (!legs) return unknown('post-suite-leg-inputs-unmeasured');
    const result = await input.select(root);
    if (result.code !== 0) return unknown('consumer-selector-failed');
    const marker = 'AFFECTED_TESTS_SELECTION=';
    const lines = result.stdout.split(/\r?\n/).filter(line => line.startsWith(marker));
    if (lines.length !== 1) return unknown('consumer-selector-output-invalid');
    const selection = JSON.parse(lines[0]!.slice(marker.length)) as ProofContextReachSelection;
    // Source identity uses the same recursive, submodule-aware file population as
    // the graph. A commit hash alone cannot map changed bytes to OLD+NEW consumers,
    // and an empty commit must not invalidate otherwise identical source inputs.
    // Ignored/generated files and runtime inputs still need their own producers.
    const census = listFilesIncludingUntracked(root);
    if (census.unscanned.length) return unknown('source-census-incomplete');
    const source = [...new Set(census.files as string[])].sort();
    if (!source.length) return unknown('source-census-empty');
    const reach = captureProofContextReach({ rootDir: root, selection, componentFiles: { source }, legs });
    const after = await input.readTree(root);
    if (after.head !== before.head || after.dirty) return unknown('source-changed-during-capture');
    const recorded = captureRecordedProofContext({ commitSha: before.head, worktreeDirty: false });
    const context = createProofContextIdentity({ ...recorded.components, ...capturedProofContextComponents(reach) });
    return { ref: input.ref, context, reach };
  } catch { return unknown('proof-context-capture-failed'); }
}

export function compareCheckpointProofContextCaptures(input: {
  candidate: string; repairHead: string; before: CheckpointProofContextCapture; after: CheckpointProofContextCapture;
}) {
  if (input.before.ref !== input.candidate || input.after.ref !== input.repairHead)
    return { before: null, after: null, status: 'unknown' as const, reason: 'proof-context-ref-mismatch' };
  return compareProofContextReach({ before: input.before.context, after: input.after.context,
    oldCapture: input.before.reach, newCapture: input.after.reach });
}
