/**
 * Engineering docs adapter — Starlight content collection on disk.
 *
 * Reads from apps/operator-docs/src/content/docs/ (the Astro/Starlight
 * content tree). The fumadocs adapter was removed at the F10 cutover —
 * see apps/operator/docs/plans/fumadocs-to-starlight-2026-05-20.md
 * (F11 agent insight has the full migration history).
 */

import * as path from 'node:path';
import {
  starlightContentAdapter,
  type DocSource,
} from '@papercusp/docs-engine';

export const engineeringAdapter: DocSource = starlightContentAdapter({
  name: 'papercusp-engineering',
  contentRoot: path.join(
    process.cwd(),
    'apps',
    'operator-docs',
    'src',
    'content',
    'docs',
  ),
  baseUrl: '/internal/docs',
});
