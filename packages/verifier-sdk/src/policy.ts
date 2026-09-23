import { AUTHORITY_SCOPES, parseRequirement } from '@passport/vocab';
import { parseAuthorityRequirement, type VerifyPolicy } from './verify.js';

/**
 * Turn requirement strings (manifest `modules.thirdParty[].requires`, pay request `acceptance.requires`) into a
 * VerifyPolicy for `podDid`:
 * - `MembershipCredential:pod` → membership required with `podDid` (a DID in place of `pod` names that pod);
 * - `AuthorityCredential:<scope>` → `<scope>` added to `requireAuthority` (must be a B3 §3 scope);
 * - `AuthorityCredential:<scope>@<did>` → scoped requirement (e.g. `pay:receive@did:web:…:moxie-bread`); `pay:receive`
 *   must always be scoped to an enterprise.
 * Membership is required only when a MembershipCredential requirement is listed. Unknown types throw.
 */
export function policyFromRequirements(requirements: string[], podDid: string, extra: Partial<VerifyPolicy> = {}): VerifyPolicy {
  const pods = new Set<string>();
  const requireAuthority: string[] = [];
  let requireMembership = false;
  for (const input of requirements) {
    const { type, scope } = parseRequirement(input);
    if (type === 'MembershipCredential') {
      requireMembership = true;
      if (scope === 'pod') pods.add(podDid);
      else if (scope.startsWith('did:')) pods.add(scope);
      else throw new Error(`Unknown membership requirement "${input}"; use MembershipCredential:pod.`);
    } else if (type === 'AuthorityCredential') {
      const { action, scope: target } = parseAuthorityRequirement(scope);
      if (!Object.prototype.hasOwnProperty.call(AUTHORITY_SCOPES, action)) {
        throw new Error(`Unknown authority scope "${action}" in requirement "${input}".`);
      }
      if (action === 'pay:receive' && !target) {
        throw new Error(`"${input}" must name the enterprise: AuthorityCredential:pay:receive@<enterpriseDid>.`);
      }
      if (!requireAuthority.includes(scope)) requireAuthority.push(scope);
    } else {
      throw new Error(`Unsupported credential requirement "${input}".`);
    }
  }
  if (!pods.size) pods.add(podDid);
  return { acceptedPods: [...pods], requireMembership, requireAuthority, ...extra };
}
