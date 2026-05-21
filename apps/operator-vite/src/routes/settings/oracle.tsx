import { createFileRoute } from '@tanstack/react-router';
import OracleClient from '@/app/settings/oracle/OracleClient';

/**
 * /settings/oracle — Oracle assistant settings. Translated from
 * `apps/operator/app/settings/oracle/page.tsx`. `requireFlag(FLAGS.ORACLE)`
 * gate dropped (SPA-flags A3 deferral).
 */
export const Route = createFileRoute('/settings/oracle')({
  component: OracleClient,
});
