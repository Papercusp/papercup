/**
 * `code:structural` — the registered surface of the pinned ast-grep leg
 * (plan `code-intelligence-routing-lsp-gitnexus-2026-08-20`, P-014).
 *
 * Named for the QUESTION it answers, not the binary that answers it. The
 * routing distinction P-014 asks for lives in the description and guidance,
 * because that is the only place a choosing agent actually reads: `lsp:query`
 * is type truth, `gitnexus.query` is topology, this is shape.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';

import { resolveAgentWorkspaceRoot } from '../capability/base-dir';
import {
  AST_GREP_LANGUAGES,
  astGrepFacade,
  type AstGrepLanguage,
} from '../../code-intelligence/ast-grep-facade.ts';
import { RIPGREP_SCOPE_GUIDANCE } from '../../code-intelligence/contracts.ts';

const LANGS = Object.keys(AST_GREP_LANGUAGES) as [AstGrepLanguage, ...AstGrepLanguage[]];

export default defineTool({
  name: 'code:structural',
  description:
    'Find code by SHAPE using pinned ast-grep: `pattern` is code with metavariables (`foo($X)`, `if ($C) { $$$BODY }`), matched against the syntax tree — so it ignores formatting and line breaks, and does NOT match the same characters inside a string or comment. op:"search" lists matches; op:"rewrite_preview" additionally reports what each site WOULD become. NEVER writes: ast-grep applies only with --update-all, which this tool cannot emit. Returns { sites:[{path,line1,detail}], truncation, freshness, error }; line1 is ONE-indexed (ast-grep reports zero-indexed — this converts). Knows nothing about types: two identically-shaped calls from different modules are indistinguishable here.',
  guidance: {
    when: 'The question is about FORM: where an idiom or anti-pattern occurs, the blast radius of a codemod, a lint-shaped sweep. Also when the code does not typecheck — this parses, it does not compile.',
    notWhen:
      `The answer depends on which declaration a name RESOLVES to (shadowing, re-exports, generics) — that is lsp:query. Call chains and impact are gitnexus.query. Plain text/regex is ${RIPGREP_SCOPE_GUIDANCE}.`,
    chaining:
      'code:structural to find candidate sites by shape → lsp:query op:"symbol" on one to confirm it resolves where you think. A structural match set is a SUPERSET of the type-correct one.',
  },
  capability: 'intel:read',
  requirePrincipal: false,
  timeoutSec: 90,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    op: z
      .enum(['search', 'rewrite_preview'])
      .describe('search lists matches; rewrite_preview also reports the replacement. Neither writes.'),
    pattern: z
      .string()
      .min(1)
      .describe('Structural pattern: code with metavariables. `$X` is one node, `$$$X` is many.'),
    language: z
      .enum(LANGS)
      .describe('Grammar to parse the pattern and files with. A pattern is only meaningful under a language.'),
    rewrite: z
      .string()
      .min(1)
      .optional()
      .describe('rewrite_preview only: replacement template, reusing the pattern\'s metavariables. NOTHING is written.'),
    paths: z
      .array(z.string().min(1))
      .optional()
      .describe('Files or directories to search. Defaults to the whole workspace root, which on this monorepo is slow — narrow it.'),
    rootPath: z.string().min(1).optional().describe('Project root override. Defaults to the agent workspace root.'),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Cap on returned sites. A cut is always reported via truncation.truncated + totalAvailable.'),
  }),
  async handler(args, ctx) {
    const root = args.rootPath ?? resolveAgentWorkspaceRoot(ctx);
    const answer = await astGrepFacade(args.op, {
      pattern: args.pattern,
      language: args.language,
      rewrite: args.rewrite,
      paths: args.paths,
      rootPath: root,
      limit: args.limit,
    });
    return { data: answer };
  },
});
