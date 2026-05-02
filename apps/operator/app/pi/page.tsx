'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import PiTerminalsDock from '../harness/PiTerminalsDock';

function PiPage() {
  const sp = useSearchParams();
  const slug = sp?.get('harness') ?? '';
  const laneId = sp?.get('lane') ?? undefined;

  if (!slug) {
    return (
      <div style={{ padding: 24, fontFamily: 'system-ui', color: '#aaa' }}>
        Missing <code>?harness=&lt;slug&gt;</code> query parameter.
      </div>
    );
  }

  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', minHeight: 0 }}>
      <PiTerminalsDock slug={slug} initialLaneId={laneId} />
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <PiPage />
    </Suspense>
  );
}
