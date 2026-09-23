import { copy, type BioregionManifest, type TrustPolicy } from '@passport/tenant-config';

/** Home greeting in the pod's tone (overridable with `copy.<locale>['home.greeting'|'home.lede']`). */
export function greeting(manifest: BioregionManifest): { title: string; lede: string } {
  const name = manifest.identity.name;
  const byTone = {
    warm: {
      title: `Welcome, neighbor.`,
      lede: `${name} is how the people of this place recognise one another, share what they have, and decide together. It starts with meeting someone in person.`,
    },
    civic: {
      title: `Welcome to ${name}.`,
      lede: `${name} is this bioregion's commons: membership earned in person, grants decided by members, and a local credit that is never sold.`,
    },
    plain: {
      title: name,
      lede: `Membership, local grants and local credit for ${name}. Membership begins at an in-person event.`,
    },
  } as const;
  const base = byTone[manifest.theme.tone] ?? byTone.plain;
  const title = copy(manifest, 'home.greeting');
  const lede = copy(manifest, 'home.lede');
  return { title: title === 'home.greeting' ? base.title : title, lede: lede === 'home.lede' ? base.lede : lede };
}

export function tierName(manifest: BioregionManifest, tier: string): string {
  const name = copy(manifest, `tier.${tier}.name`);
  return name === `tier.${tier}.name` ? tier : name;
}

/** Plain-language form of a third-party module requirement such as `MembershipCredential:pod`. */
export function describeRequirement(manifest: BioregionManifest, req: string): string {
  const name = manifest.identity.name;
  const [kind, qualifier] = req.split(':');
  if (kind === 'MembershipCredential') return `membership in ${name}`;
  if (kind === 'AuthorityCredential' && qualifier) return `the "${qualifier}" permission from ${name}`;
  if (/^T[0-4]$/.test(req)) return `${tierName(manifest, req)} standing in ${name}`;
  return req;
}

const RULES: Record<string, (n: string) => string> = {
  vmcPairComplete: () => 'Your membership grant and your acknowledgement of it are both on file.',
  witnessedEdges: (n) =>
    n === '1'
      ? 'At least one of your relationships was witnessed in person.'
      : `At least ${n} of your relationships were witnessed in person.`,
  distinctEvents: (n) =>
    n === '1' ? 'Your relationships were witnessed at a gathering.' : `Your relationships were witnessed at ${n} or more different gatherings.`,
  distinctWitnesses: (n) =>
    n === '1' ? 'Your relationships were witnessed by a neighbor.' : `Your relationships were witnessed by ${n} or more different neighbors.`,
  distinctEventsOrWitnesses: (n) =>
    n === '1'
      ? 'Your relationships were witnessed at a gathering or by a neighbor.'
      : `Your relationships were witnessed at ${n} or more gatherings or by ${n} different neighbors.`,
  weightedEndorsements: (n) => `At least ${n} trusted neighbors have vouched for you.`,
  seedHops: (n) => `You are within ${n} introductions of the pod's founding members.`,
  spread: (n) =>
    `Your relationships were witnessed by different people or at different gatherings rather than all by one (spread of at least ${n}).`,
  electedByGovernance: () => "You were chosen as a steward through the pod's governance process.",
  namedInGovernance: () => "You are named as an anchor in the pod's governance documents.",
};

/** One plain sentence for a trust-policy requirement (`witnessedEdges>=3`, `T2for>=180d`, …). */
export function describeRule(manifest: BioregionManifest, requirement: string): string {
  const m = /^([A-Za-z0-9]+?)(>=|<=|>|<|=)(.+)$/.exec(requirement.trim());
  if (!m) return RULES[requirement]?.('') ?? requirement;
  const [, metric = '', , value = ''] = m;
  const held = /^(T[0-4])for$/.exec(metric);
  if (held?.[1]) {
    const days = value.replace(/d$/, '');
    return `You have held ${tierName(manifest, held[1])} standing for at least ${days} days.`;
  }
  return RULES[metric]?.(value) ?? requirement;
}

type Tier = 'T1' | 'T2' | 'T3' | 'T4';

/**
 * The requirement the trust index actually evaluates for a tier: on T2, `distinctEvents>=N` counts distinct
 * witnesses too unless the policy turns peer witnessing off (the trust index's compatibility rule, Task 21b).
 */
export function effectiveTierRule(policy: Pick<TrustPolicy, 'admission'>, tier: Tier, requirement: string): string {
  if (tier !== 'T2' || policy.admission?.peerWitnessing === false) return requirement;
  const m = /^distinctEvents>=(.+)$/.exec(requirement.trim());
  return m ? `distinctEventsOrWitnesses>=${m[1]}` : requirement;
}

/** One plain sentence for a tier requirement as this pod's policy evaluates it (governance page). */
export function describeTierRule(manifest: BioregionManifest, policy: Pick<TrustPolicy, 'admission'>, tier: Tier, requirement: string): string {
  return describeRule(manifest, effectiveTierRule(policy, tier, requirement));
}

/** Who may witness a relationship, as one sentence, or null when the policy leaves it to event conveners. */
export function describeWitnessing(manifest: BioregionManifest, policy: Pick<TrustPolicy, 'admission'>): string | null {
  const admission = policy.admission;
  const tier = admission?.witnessTier;
  if (!tier || admission?.peerWitnessing === false) return null;
  // Only T2 and above hold `vwc:issue`; a T1 floor still means T2 in practice.
  const floor = tier === 'T1' ? 'T2' : tier;
  return `Any member at ${tierName(manifest, floor)} standing or above can witness two neighbors' relationship in person, at a gathering or on the spot.`;
}
