import { cn } from './cn.js';

export interface NavItem {
  href: string;
  label: string;
  active?: boolean;
}

export interface NavProps {
  items: NavItem[];
  className?: string;
}

/** Horizontal module navigation (e.g. a pod's map/events/grants/circulation tabs). */
export function Nav({ items, className }: NavProps) {
  return (
    <nav className={cn('flex items-center gap-1', className)}>
      {items.map((item) => (
        <a
          key={item.href}
          href={item.href}
          aria-current={item.active ? 'page' : undefined}
          className="rounded-2xl px-3 py-2 text-sm font-medium transition-colors"
          style={{
            background: item.active ? 'color-mix(in srgb, var(--bp-primary) 15%, transparent)' : 'transparent',
            color: 'var(--bp-fg)',
          }}
        >
          {item.label}
        </a>
      ))}
    </nav>
  );
}
