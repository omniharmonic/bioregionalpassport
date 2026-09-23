import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TierBadge, DEFAULT_TIER_NAMES, type Tier } from './TierBadge.js';

describe('TierBadge', () => {
  it.each(Object.entries(DEFAULT_TIER_NAMES) as [Tier, string][])(
    'renders the default name for %s',
    (tier, name) => {
      render(<TierBadge tier={tier} />);
      expect(screen.getByText(name)).toBeInTheDocument();
    },
  );

  it('renders an override name instead of the default', () => {
    render(<TierBadge tier="T2" name="Neighbor" />);
    expect(screen.getByText('Neighbor')).toBeInTheDocument();
    expect(screen.queryByText(DEFAULT_TIER_NAMES.T2)).not.toBeInTheDocument();
  });
});
