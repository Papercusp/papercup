import { createFileRoute } from '@tanstack/react-router';
import { FLAGS } from '@papercusp/flags';
import { requireFlag } from '../../lib/require-flag';
import ElMinPage from '@/app/el-min/page';

/**
 * /dev/el-min — minimal ElevenLabs diagnostic. Translated from
 * `apps/operator/app/el-min/page.tsx` (clean).
 *
 * Demoted under /dev + gated behind FLAGS.TESTING (design-simplification P-013).
 */
export const Route = createFileRoute('/dev/el-min')({
  beforeLoad: () => requireFlag(FLAGS.TESTING),
  component: ElMinPage,
});
