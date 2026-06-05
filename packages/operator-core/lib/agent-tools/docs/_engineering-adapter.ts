/**
 * Engineering docs adapter — Starlight content collection on disk.
 *
 * Reads from apps/operator-docs/src/content/docs/ (the Astro/Starlight
 * content tree). The fumadocs adapter was removed at the F10 cutover —
 * see apps/operator/docs/plans/fumadocs-to-starlight-2026-05-20.md
 * (F11 agent insight has the full migration history).
 *
 * The content root is resolved relative to the repo root (not
 * process.cwd(), which is apps/operator at runtime) — see _repo-paths.
 */

import {
  starlightContentAdapter,
  type DocSource,
} from '@papercusp/docs-engine';
import { DOCS_CONTENT_ROOT } from './_repo-paths';

export const engineeringAdapter: DocSource = starlightContentAdapter({
  name: 'papercusp-engineering',
  contentRoot: DOCS_CONTENT_ROOT,
  baseUrl: '/internal/docs',
});
