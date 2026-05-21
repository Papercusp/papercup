import { createFileRoute } from '@tanstack/react-router';
import InstalledTemplatesClient from '@/app/installed/templates/InstalledTemplatesClient';

/**
 * /installed/templates — translated from
 * `apps/operator/app/installed/templates/page.tsx`. requireFlag gate dropped.
 */
export const Route = createFileRoute('/installed/templates/')({
  component: InstalledTemplatesClient,
});
