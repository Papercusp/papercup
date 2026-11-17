/** Fresh-process half of store.integration.test.ts's serialized recovery test.
 * Both database URLs and workspace are pinned to that suite's throwaway fixture.
 * There are no mocks or parent-process module caches on this consumer path. */
import { getOrgPg } from '@papercusp/db-org';
import factsListTool from '../lib/agent-tools/facts/list.ts';

process.once('message', async (continuation: { args: Record<string, unknown> }) => {
  try {
    const pages: Record<string, unknown>[] = [];
    let next: typeof continuation | undefined = continuation;
    while (next) {
      const result = await factsListTool.handler(factsListTool.args.parse(next.args),
        { isSuperuser: true, uiClientId: 'su-p010-recovery' } as never) as { data: Record<string, unknown> };
      pages.push(result.data);
      next = result.data.next as typeof next;
    }
    await getOrgPg().sql.end();
    process.send!({ pid: process.pid, pages }, () => process.exit(0));
  } catch (error) {
    console.error(error);
    await getOrgPg().sql.end();
    process.exit(1);
  }
});
