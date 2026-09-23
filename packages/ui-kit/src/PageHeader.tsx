import type { ReactNode } from 'react';

export interface PageHeaderProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  className?: string;
}

/** Standard page-top header: title, optional subtitle, optional action slot. */
export function PageHeader({ title, subtitle, actions, className }: PageHeaderProps) {
  return (
    <div className={(className ? className + ' ' : '') + 'mb-8 flex flex-wrap items-start justify-between gap-4'}>
      <div>
        <h1 data-display className="text-3xl font-semibold">
          {title}
        </h1>
        {subtitle ? <p className="mt-1 text-sm opacity-70">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
