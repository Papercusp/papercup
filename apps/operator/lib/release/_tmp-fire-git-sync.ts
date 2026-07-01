import { fireGitSyncNow } from '@papercusp/operator-core/lib/harness/git-sync/git-sync-action';

async function main() {
  await fireGitSyncNow('papercusp', 'papercusp-workspace');
  console.log('fireGitSyncNow completed');
}

main().catch((err) => {
  console.error('fireGitSyncNow FAILED:', err);
  process.exit(1);
});
