import { copy, type BioregionManifest } from '@passport/tenant-config';

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
      ? 'At least one of your relationships was witnessed in person at an attestation event.'
      : `At least ${n} of your relationships were witnessed in person at an attestation event.`,
  distinctEvents: (n) => `You have met people at ${n} or more different events.`,
  weightedEndorsements: (n) => `At least ${n} trusted neighbors have vouched for you.`,
  seedHops: (n) => `You are within ${n} introductions of the pod's founding members.`,
  spread: (n) => `Your relationships are spread across events rather than concentrated in one (spread of at least ${n}).`,
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
