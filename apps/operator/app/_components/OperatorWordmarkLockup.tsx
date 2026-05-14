import type { ReactNode } from 'react';

type Props = {
  title?: string;
  subtitle?: string;
  className?: string;
  titleClassName?: string;
  subtitleClassName?: string;
  leading?: ReactNode;
};

export function OperatorWordmarkLockup({
  title = 'Papercup',
  subtitle = 'mission console',
  className,
  titleClassName,
  subtitleClassName,
  leading,
}: Props) {
  return (
    <span className={className ? `operator-wordmark ${className}` : 'operator-wordmark'}>
      {leading}
      <span className="operator-wordmark__copy">
        <span className={titleClassName ? `operator-wordmark__title ${titleClassName}` : 'operator-wordmark__title'}>
          {title}
        </span>
        {subtitle ? (
          <span className={subtitleClassName ? `operator-wordmark__subtitle ${subtitleClassName}` : 'operator-wordmark__subtitle'}>
            {subtitle}
          </span>
        ) : null}
      </span>
    </span>
  );
}
