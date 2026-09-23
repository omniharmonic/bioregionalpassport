import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Nav } from './Nav.js';

describe('Nav', () => {
  it('marks the active item with aria-current="page"', () => {
    render(
      <Nav
        items={[
          { href: '/p/boulder', label: 'Home', active: true },
          { href: '/p/boulder/events', label: 'Events' },
          { href: '/p/boulder/grants', label: 'Grants' },
        ]}
      />,
    );

    expect(screen.getByText('Home')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('Events')).not.toHaveAttribute('aria-current');
    expect(screen.getByText('Grants')).not.toHaveAttribute('aria-current');
  });
});
