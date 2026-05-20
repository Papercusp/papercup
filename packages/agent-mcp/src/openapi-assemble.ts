/**
 * OpenAPI 3.1 document assembler.
 *
 * Walks a list of projected tools, emits a per-tool fragment for each
 * (`openapi-fragments.ts`), and merges them into one valid OpenAPI 3.1
 * document: `info` + `openapi` version + `paths` + `components`
 * (`schemas`, `responses`, `securitySchemes`).
 *
 * Phase 7 step 2 (openapi-design-spike-2026-05-20.md §7).
 *
 * Pure — takes the tool list as an argument rather than reaching for
 * the registry, so it's trivially testable and the caller decides
 * whether to pass the full catalog or a filtered subset.
 */

import type { ProjectedTool } from './tool-projection';
import {
  standardResponseComponents,
  toolToOpenApiFragment,
} from './openapi-fragments';

export interface OpenApiDocumentOptions {
  /** `info.title`. Default 'Papercusp Tool API'. */
  title?: string;
  /** `info.version`. Default '0.1.0'. */
  version?: string;
  /** `info.description`. Optional. */
  description?: string;
  /** Path prefix passed to each fragment. Default '/api'. */
  pathPrefix?: string;
  /** Security-scheme name. Default 'bearerAuth'. */
  securitySchemeName?: string;
  /** `servers` array. Optional — omitted when absent. */
  servers?: Array<{ url: string; description?: string }>;
}

/**
 * Resolve the operation name for a projected tool. Prefers the MCP
 * dotted name; falls back to the HTTP path's last segment. Tools with
 * neither are skipped by the caller (registerProjectedTool already
 * rejects them, so this is defense-in-depth).
 */
export function toolOperationName(tool: ProjectedTool): string | null {
  if (tool.expose.mcp?.name) return tool.expose.mcp.name;
  if (tool.expose.http?.path) {
    // Strip a leading slash; collapse remaining slashes into dots so
    // an HTTP-only tool still gets a stable operationId.
    return tool.expose.http.path.replace(/^\/+/, '').replace(/\//g, '.');
  }
  return null;
}

/**
 * Assemble a full OpenAPI 3.1 document from a list of projected tools.
 *
 * Path collisions (two tools resolving to the same name) throw — the
 * registry already enforces unique MCP names + HTTP paths, so a
 * collision here means a bug upstream, not a recoverable condition.
 */
export function assembleOpenApiDocument(
  tools: readonly ProjectedTool[],
  opts: OpenApiDocumentOptions = {},
): Record<string, unknown> {
  const pathPrefix = opts.pathPrefix ?? '/api';
  const securitySchemeName = opts.securitySchemeName ?? 'bearerAuth';

  const paths: Record<string, unknown> = {};
  const schemas: Record<string, Record<string, unknown>> = {};

  // Deterministic order — sort by operation name so the emitted document
  // is byte-stable across runs (the CI snapshot gate in step 5 diffs it).
  const named = tools
    .map((t) => ({ tool: t, name: toolOperationName(t) }))
    .filter((x): x is { tool: ProjectedTool; name: string } => x.name !== null)
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const { tool, name } of named) {
    const frag = toolToOpenApiFragment(name, tool, { pathPrefix, securitySchemeName });
    if (paths[frag.path]) {
      throw new Error(
        `assembleOpenApiDocument: path collision on "${frag.path}" — two tools resolved to the same operation name`,
      );
    }
    paths[frag.path] = { post: frag.operation };
    for (const [schemaName, schemaBody] of Object.entries(frag.schemas)) {
      schemas[schemaName] = schemaBody;
    }
  }

  const responses = standardResponseComponents();

  const doc: Record<string, unknown> = {
    openapi: '3.1.0',
    info: {
      title: opts.title ?? 'Papercusp Tool API',
      version: opts.version ?? '0.1.0',
      ...(opts.description ? { description: opts.description } : {}),
    },
    ...(opts.servers && opts.servers.length > 0 ? { servers: opts.servers } : {}),
    paths,
    components: {
      schemas,
      responses,
      securitySchemes: {
        [securitySchemeName]: {
          type: 'http',
          scheme: 'bearer',
          description:
            'Bearer token — superuser file, mobile JWT, or future webapp token. ' +
            'The scopes array on each operation lists the capabilities the tool requires.',
        },
      },
    },
  };

  return doc;
}
