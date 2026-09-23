'use client';

import { usePathname } from 'next/navigation';
import { Nav } from '@passport/ui-kit';
import type { PodLink } from '@/lib/podNav';

/** Pod navigation with the current section marked (`aria-current="page"`). */
export function PodNav({ links }: { links: PodLink[] }) {
  const pathname = usePathname() ?? '/';
  const items = links.map((l) => {
    const path = l.href.split('?')[0] ?? l.href;
    const active = l.exact ? pathname === path || pathname === `${path}/` : pathname === path || pathname.startsWith(`${path}/`);
    return { href: l.href, label: l.label, active };
  });
  return <Nav items={items} className="flex-wrap" />;
}
