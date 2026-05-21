import { createFileRoute } from '@tanstack/react-router';
import { FLAGS } from '@papercusp/flags';
import { requireFlag } from '../../../lib/require-flag';
import InstalledTemplatesClient from '@/app/installed/templates/InstalledTemplatesClient';

/**
 * /installed/templates — translated from
 * `apps/operator/app/installed/templates/page.tsx`. requireFlag gate ported to a `beforeLoad` check (lib/require-flag.ts).
 */
export const Route = createFileRoute('/installed/templates/')({
  beforeLoad: () => requireFlag(FLAGS.TEMPLATES),
  component: InstalledTemplatesClient,
});
