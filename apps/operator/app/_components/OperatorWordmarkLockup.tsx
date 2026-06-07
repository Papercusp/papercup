'use client';

import type { ReactNode } from 'react';
import { useLexiconPackId } from '@/lib/useLexicon';

type Props = {
  title?: string;
  subtitle?: string;
  className?: string;
  titleClassName?: string;
  subtitleClassName?: string;
  leading?: ReactNode;
};

export function OperatorWordmarkLockup({
  title,
  subtitle,
  className,
  titleClassName,
  subtitleClassName,
  leading,
}: Props) {
  const packId = useLexiconPackId();
  const resolvedTitle = title ?? (packId === 'the-hive' ? 'The Swarm' : 'Papercup');
  const resolvedSubtitle = subtitle ?? (packId === 'the-hive' ? 'Hive console' : 'mission console');

  return (
    <span className={className ? `operator-wordmark ${className}` : 'operator-wordmark'}>
      {leading}
      <span className="operator-wordmark__copy">
        <span className={titleClassName ? `operator-wordmark__title ${titleClassName}` : 'operator-wordmark__title'}>
          {resolvedTitle}
        </span>
        {resolvedSubtitle ? (
          <span className={subtitleClassName ? `operator-wordmark__subtitle ${subtitleClassName}` : 'operator-wordmark__subtitle'}>
            {resolvedSubtitle}
          </span>
        ) : null}
      </span>
    </span>
  );
}
