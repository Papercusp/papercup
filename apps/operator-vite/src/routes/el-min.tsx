import { createFileRoute } from '@tanstack/react-router';
import ElMinPage from '@/app/el-min/page';

/**
 * /el-min — minimal ElevenLabs diagnostic. Translated from
 * `apps/operator/app/el-min/page.tsx` (clean).
 */
export const Route = createFileRoute('/el-min')({
  component: ElMinPage,
});
