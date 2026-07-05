import { pruneStorageCategory } from './lib/storage/prune';
import { activeWorkspaceId } from './lib/workspace-registry';

async function main() {
  const ws = activeWorkspaceId();
  console.log('workspaceId:', ws);
  const dry = await pruneStorageCategory({ categoryId: 'agent-activity', olderThanDays: 7, dryRun: true, workspaceId: ws });
  console.log('DRY RUN:', JSON.stringify(dry, null, 2));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
