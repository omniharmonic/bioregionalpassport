export type Tier = 'T0' | 'T1' | 'T2' | 'T3' | 'T4';

export const DEFAULT_TIER_NAMES: Record<Tier, string> = {
  T0: 'Visitor',
  T1: 'Member',
  T2: 'Trusted',
  T3: 'Steward',
  T4: 'Anchor',
};

// Colour intensity increases with tier: higher tiers get a stronger fill of
// the pod's primary colour and white text; lower tiers stay a faint tint.
const TIER_INTENSITY: Record<Tier, number> = {
  T0: 12,
  T1: 30,
  T2: 50,
  T3: 70,
  T4: 100,
};

export interface TierBadgeProps {
  tier: Tier;
  name?: string;
  className?: string;
}

/** A small pill showing a member's trust tier, coloured by intensity. */
export function TierBadge({ tier, name, className }: TierBadgeProps) {
  const label = name ?? DEFAULT_TIER_NAMES[tier];
  const intensity = TIER_INTENSITY[tier];
  const strong = intensity >= 70;
  return (
    <span
      className={className ? `inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ${className}` : 'inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold'}
      style={{
        background: `color-mix(in srgb, var(--bp-primary) ${intensity}%, transparent)`,
        color: strong ? '#fff' : 'var(--bp-fg)',
      }}
      data-tier={tier}
    >
      {label}
    </span>
  );
}
