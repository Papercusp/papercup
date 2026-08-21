/**
 * `code:pack` — the registered surface of the pinned packing leg (plan
 * `code-intelligence-routing-lsp-gitnexus-2026-08-20`, P-016; D-005, D-040).
 *
 * Named for the JOB (package evidence) rather than the binary, like its
 * siblings: `lsp:query` is type truth, `gitnexus.query` is topology,
 * `code:structural` is shape, this is evidence-for-a-reader.
 *
 * One tool over two engines on purpose. The engine is a consequence of the op —
 * `pack` is repomix, `diff` is code2prompt — because the choice turns on a
 * property the caller should not have to know: only repomix has a secret
 * scanner. Exposing two tools would invite picking the one without one.
 *
 * ⚠ The response shape lives in `guidance.returns`, NOT in `description`. The
 * prompt-weight budget counts description + when/notWhen/chaining and excludes
 * returns/seeAlso, so documenting the payload here would spend fleet-wide
 * system-prompt budget on something a caller only needs after it has already
 * chosen this tool.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';

import { resolveAgentWorkspaceRoot } from '../capability/base-dir';
import { PACK_TEMPLATES, packerFacade, type PackTemplate } from '../../code-intelligence/packer-facade.ts';

const TEMPLATES = Object.keys(PACK_TEMPLATES) as [PackTemplate, ...PackTemplate[]];

export default defineTool({
  name: 'code:pack',
  description:
    'Package code as EVIDENCE for a reviewer or another model, using pinned engines (Repomix 1.18.0 / code2prompt 4.2.0 — never `npx latest`, so every pack names the exact engine that produced it). op:"pack" packs the files matching `include`; op:"diff" packs the git diff instead. `include` is REQUIRED and non-empty: an unscoped pack of this monorepo is gigabytes, and it reads exactly like a correctly-scoped one until someone opens it. Only op:"pack" is secret-scanned — code2prompt ships no scanner at all — so the two are NOT interchangeable on a tree that may hold credentials. Never writes to the workspace, cannot disable secret scanning, and puts the pack body in a scratch file outside the tree rather than into your context.',
  guidance: {
    when: 'You need a whole subsystem in one document for a human reviewer or another model to reason over — a review request, an audit, a refactor brief. op:"diff" when only what CHANGED matters.',
    notWhen:
      'You are answering a question about the code. Packing is POST-retrieval: find the answer with lsp:query (types), gitnexus.query (call chains), code:structural (shape) or ripgrep (text) first, and pack only once you know what a reader needs to see.',
    chaining:
      'gitnexus.query for the impact radius → code:pack include:<that radius>, so the pack is scoped by a measured answer rather than a guess. Quote provenance.commit + dirty whenever you cite a pack as evidence.',
    returns:
      '{ answer, artifact }. `artifact.path` is the scratch file holding the full pack; `artifact.preview` is a bounded head of it. `artifact.provenance` states what the pack actually IS: engine + engineVersion, commit, dirty (true = NOT reproducible from that commit, so do not cite it as "the code at <sha>"), baseRef/baseCommit, the include/ignore/denyGlobs actually applied, template, fileCount, bytes, chars, capturedAt, and securityScan ("secretlint+deny-set" for pack, "deny-set-only" for diff). fileCount is null — never 0 — when the selection could not be parsed out of the pack, because "I could not read it" and "it selected nothing" are different answers. `answer` is the normalized code-intelligence shape: sites[] is one entry per SELECTED FILE, truncation.truncated marks a pack cut at the byte ceiling, and a refusal (flag off, engine unprovisioned, pin drifted, empty include) arrives as answer.error with health "unknown" rather than as an empty pack.',
  },
  capability: 'intel:read',
  requirePrincipal: false,
  timeoutSec: 200,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    op: z
      .enum(['pack', 'diff'])
      .describe('pack = the matching files (Repomix). diff = what changed (code2prompt). Neither writes.'),
    include: z
      .array(z.string().min(1))
      .min(1)
      .describe('REQUIRED glob set, e.g. ["packages/operator-core/lib/scheduler/**"]. A pattern starting with "-" is refused.'),
    ignore: z
      .array(z.string().min(1))
      .optional()
      .describe('Extra excludes. Appended to a non-overridable secret deny-set (.env, keys, credentials), never replacing it.'),
    format: z
      .enum(['markdown', 'xml'])
      .optional()
      .describe('Document format. Defaults to xml for pack, markdown for diff.'),
    template: z
      .enum(TEMPLATES)
      .optional()
      .describe('Prepend a reviewer framing: code-review | security-audit | refactor-prep | none.'),
    baseRef: z
      .string()
      .min(1)
      .optional()
      .describe('diff only: ref to diff against, e.g. "origin/main". Omitted = the working-tree diff.'),
    compress: z
      .boolean()
      .optional()
      .describe('pack only: collapse bodies to signatures. Much smaller; loses implementation detail.'),
    rootPath: z.string().min(1).optional().describe('Project root override. Defaults to the agent workspace root.'),
  }),
  async handler(args, ctx) {
    const root = args.rootPath ?? resolveAgentWorkspaceRoot(ctx);
    const result = await packerFacade(args.op, {
      include: args.include,
      ignore: args.ignore,
      rootPath: root,
      format: args.format,
      template: args.template,
      baseRef: args.baseRef,
      compress: args.compress,
    });
    return { data: result };
  },
});
