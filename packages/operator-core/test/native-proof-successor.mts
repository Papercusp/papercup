/** Maintained real-process continuation for the native run-ledger suite. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
// eslint-disable-next-line import/no-relative-packages -- mirror the real org raw SQL client
import { restoreRawJsonbSerializer } from '../../../libs/papercusp/libs/db/src/raw-serializers';
import { enterNativeProofChild, executeNativeProofOnce, type NativeProofInput,
  type NativeProofAdmission, type NativeProofChildHandoff } from '../lib/testing-run-store';

process.once('message', async (message: { mode: 'parent'; input: NativeProofInput; admission: NativeProofAdmission }
  | { mode: 'child'; handoff: NativeProofChildHandoff }) => {
  const url = process.env.PAPERCUSP_TEST_RUNS_DB_URL;
  if (!url) throw new Error('Dedicated durable proof ledger URL is required');
  const sql = postgres(url, { max: 2, connect_timeout: 5 });
  restoreRawJsonbSerializer(sql);
  const ledger = sql as unknown as Parameters<typeof executeNativeProofOnce>[0];
  try {
    const [probe] = await sql`SELECT jsonb_typeof(${JSON.stringify({ probe: true })}::jsonb) AS parameter_type`;
    if (probe!.parameter_type !== 'object') throw new Error('Native ledger raw JSON parameter contract failed');
    const effect = async (intent: { runId: string }) => {
      process.send?.({ effect: intent.runId, pid: process.pid, parameterType: probe!.parameter_type });
    };
    if (message.mode === 'parent') await executeNativeProofOnce(ledger, message.input, message.admission, effect);
    else await enterNativeProofChild(ledger, message.handoff, 'packages/operator-core/test/native-proof-successor.mts',
      createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'), effect);
  } catch (error) {
    const [probe] = await sql`SELECT jsonb_typeof(${JSON.stringify({ probe: true })}::jsonb) AS parameter_type`;
    process.send?.({ error: (error instanceof Error ? error.message : String(error))
      + '; measured jsonb parameter type=' + probe!.parameter_type, pid: process.pid });
    process.exitCode = 2;
  } finally {
    await sql.end({ timeout: 5 });
    process.disconnect();
  }
});
