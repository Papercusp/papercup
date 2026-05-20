/**
 * Engineering docs adapter — env-switchable during the fumadocs→Starlight migration.
 *
 * PAPERCUSP_DOCS_ADAPTER=starlight reads from the new Astro/Starlight
 * content tree at `apps/operator-docs/src/content/docs/`. Default (unset
 * or any other value) keeps the legacy fumadocs adapter against
 * `apps/operator/content/internal-docs/`.
 *
 * At F10 cutover the default flips to `starlight` and the fumadocs branch
 * (along with the legacy renderer + source.config.ts) is deleted.
 *
 * Plan: apps/operator/docs/plans/fumadocs-to-starlight-2026-05-20.md
 */

import * as path from 'node:path';
import {
  fumadocsAdapter,
  starlightContentAdapter,
  type DocSource,
} from '@papercusp/docs-engine';
import { internalSource } from '@/lib/source';

const ADAPTER_NAME = 'papercusp-engineering';

function selectAdapter(): DocSource {
  const choice = (process.env.PAPERCUSP_DOCS_ADAPTER ?? 'fumadocs').toLowerCase();
  if (choice === 'starlight') {
    return starlightContentAdapter({
      name: ADAPTER_NAME,
      contentRoot: path.join(process.cwd(), 'apps', 'operator-docs', 'src', 'content', 'docs'),
      baseUrl: '/internal/docs',
    });
  }
  return fumadocsAdapter(internalSource as never, {
    name: ADAPTER_NAME,
    contentRoot: path.join(process.cwd(), 'content', 'internal-docs'),
  });
}

/** Engineering docs adapter — same instance for the process lifetime. */
export const engineeringAdapter: DocSource = selectAdapter();
