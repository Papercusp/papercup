import { createFileRoute } from '@tanstack/react-router';
import Page from '@/app/quick-panel/page';

/**
 * /quick-panel — the global-shortcut popup's tabbed body (saved prompts /
 * docs search / brainstorm). The desktop palette window
 * (papercusp-desktop/src-tauri/src/docs_search.rs) loads this route.
 * Client page; re-exported via the page-import pattern (B-4).
 * Plan: quick-panel-saved-prompts-2026-07-13 (P-005).
 */
export const Route = createFileRoute('/quick-panel')({
  component: Page,
});
