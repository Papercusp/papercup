import { createFileRoute } from '@tanstack/react-router';
import EditorDemoPage from '@/app/editor-demo/page';

/**
 * /editor-demo — multi-editor markdown demo. Translated from
 * `apps/operator/app/editor-demo/page.tsx`. Page uses `next/dynamic` for
 * 11 editor panes with `loading:` fallbacks — alias shim maps to
 * `React.lazy` + Suspense (loading callback becomes the Suspense fallback).
 */
export const Route = createFileRoute('/editor-demo')({
  component: EditorDemoPage,
});
