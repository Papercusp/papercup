'use client';

import * as RT from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';

const CONTENT_STYLE: React.CSSProperties = {
  maxWidth: 320,
  padding: '6px 10px',
  fontSize: 12,
  lineHeight: 1.45,
  background: 'color-mix(in srgb, var(--bg-1), transparent 4%)',
  color: '#f5f5f7',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 6,
  boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
  zIndex: 200,
};

export function Tooltip({ label, children, side = 'top', align = 'center' }: {
  label: ReactNode;
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
}) {
  if (!label) return <>{children}</>;
  return (
    <RT.Provider delayDuration={250} skipDelayDuration={150}>
      <RT.Root>
        <RT.Trigger asChild>{children}</RT.Trigger>
        <RT.Portal>
          <RT.Content data-anim="fade" sideOffset={6} side={side} align={align} style={CONTENT_STYLE}>
            {label}
            <RT.Arrow style={{ fill: 'color-mix(in srgb, var(--bg-1), transparent 4%)' }} width={10} height={5} />
          </RT.Content>
        </RT.Portal>
      </RT.Root>
    </RT.Provider>
  );
}
