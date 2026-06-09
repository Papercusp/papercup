/**
 * /snapshots/<id>/fork — fork-completion UI.
 *
 * Two-stage flow:
 *   1. ForkCompletionForm — fill in stripped fields (`shareable: false`,
 *      `secret: true`), pick a name, POST /instantiate.
 *   2. ForkProvisioningProgress — for each plugin in pendingProvisioning,
 *      consent → run → live stream → next. When all done, redirect to
 *      the harness dashboard.
 *
 * If the snapshot has no plugins with provision.setup, stage 2 is
 * skipped and we redirect immediately.
 */
'use client';

import { use, useState } from 'react';
import { ForkCompletionForm, type ForkSuccessPayload } from '@/app/_components/ForkCompletionForm';
import { ForkProvisioningProgress } from '@/app/_components/ForkProvisioningProgress';
import { navigateClient } from '@papercusp/operator-core/lib/client-navigation';

interface Props {
  params: Promise<{ id: string }>;
}

export default function ForkClient({ params }: Props) {
  const { id } = use(params);
  const [forked, setForked] = useState<ForkSuccessPayload | null>(null);

  if (!forked) {
    return (
      <div className="pc-snapshot-fork-page pc-snapshot-fork-page--form" style={{ padding: '32px 16px' }}>
        <ForkCompletionForm
          snapshotId={id}
          onSuccess={(payload) => {
            // No provisioning needed → redirect immediately.
            const queue = payload.pendingProvisioning ?? [];
            if (queue.length === 0) {
              navigateClient(`/harness?slug=${payload.newSlug}`);
              return;
            }
            // Otherwise stay on this page and walk the queue.
            setForked(payload);
          }}
        />
      </div>
    );
  }

  return (
    <div className="pc-snapshot-fork-page pc-snapshot-fork-page--provisioning" style={{ padding: '32px 16px' }}>
      <ForkProvisioningProgress
        harnessSlug={forked.newSlug}
        queue={forked.pendingProvisioning ?? []}
        onAllDone={() => {
          // Brief delay so the user reads the summary screen.
          setTimeout(() => {
            navigateClient(`/harness?slug=${forked.newSlug}`);
          }, 1500);
        }}
      />
    </div>
  );
}
