/**
 * /snapshots/<id>/fork — fork-completion UI.
 *
 * Surfaces the share-semantics shape of a snapshot, lets the user fill
 * in stripped fields (`shareable: false`, `secret: true`), and POSTs to
 * /api/snapshots/<id>/instantiate with `pluginConfigOverrides`.
 *
 * Reachable from the marketplace detail page or the local snapshots
 * list — any place that wants the rich fork experience instead of
 * the "instantiate with default name" prompt.
 */
'use client';

import { use } from 'react';
import { ForkCompletionForm } from '@/app/_components/ForkCompletionForm';

interface Props {
  params: Promise<{ id: string }>;
}

export default function ForkPage({ params }: Props) {
  const { id } = use(params);
  return (
    <div style={{ padding: '32px 16px' }}>
      <ForkCompletionForm
        snapshotId={id}
        onSuccess={(slug) => {
          window.location.href = `/harness?slug=${slug}`;
        }}
      />
    </div>
  );
}
