/**
 * `POST /api/control/pods/:slug/bootstrap-steward` — operator-only first-steward bootstrap (B4 launch
 * checklist) for the operator console. Framework-light (a `mountService` route table, platform scope) so it is
 * unit-testable; `./runtime` supplies the real pod lookup, `withPod` and the pod's decrypted signer.
 *
 * It runs pod-vta's `bootstrapSteward` (governance tier T3 + T3 VACs) and ALSO issues a pod-signed
 * `MembershipCredential` grant to the DID, built exactly as `applyMembership` builds one. `bootstrapSteward`
 * alone leaves the steward without a membership pair, so `POST /api/vta/session` refuses them
 * (`NO_MEMBERSHIP`). The steward pastes the grant into their passport (Settings → Add a credential), signs the
 * acknowledgement on the consent screen, and `/membership/ack` completes the pair while keeping the
 * governance tier at max(T1, T3) = T3.
 */
import { buildMembershipGrant, digestMultibase, MAX_VALIDITY_DAYS, type VerifiableCredential } from '@passport/credential-core';
import { bootstrapSteward, type PodSigner, type VtaContext } from '@passport/pod-vta';
import type { BioregionManifest, TrustPolicy } from '@passport/tenant-config';
import { MountError, mountService, type DepsSource, type MountableRoute, type MountedService, type MountOptions, type PodInfo } from '../../../../lib/mount';
import { isSlug } from '../../../../lib/tenant';

export const BOOTSTRAP_MOUNT: MountOptions = { base: '/api/control', scope: 'platform' };

export interface BootstrapDeps {
  findPod(slug: string): Promise<PodInfo | null>;
  /** Runs `fn` in a transaction scoped to the pod schema. */
  withPod<T>(slug: string, fn: (db: any) => Promise<T>): Promise<T>;
  loadSigner(slug: string): Promise<PodSigner>;
}

export interface BootstrapResult {
  member: { did: string; tier: string; name?: string };
  /** Pod-signed membership grant, pending the steward's acknowledgement. */
  grant: VerifiableCredential;
  /** T3 authority credentials issued by the bootstrap. */
  vacs: VerifiableCredential[];
  explanation: string[];
}

const DAY_MS = 86_400_000;
/** Same as pod-vta's `validityWindow`: a minute short of the ceiling so clock skew never exceeds it. */
const VALIDITY_SAFETY_MS = 60_000;

function grantWindow(now: Date, days: number): { validFrom: string; validUntil: string } {
  const span = Math.min(days, MAX_VALIDITY_DAYS.membership) * DAY_MS - VALIDITY_SAFETY_MS;
  return { validFrom: now.toISOString(), validUntil: new Date(now.getTime() + span).toISOString() };
}

const DID_RE = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;

/**
 * Bootstraps `did` as the pod's first steward and hands them a membership grant (in the pod transaction).
 * An unexpired grant already on the member row is returned again rather than replaced, so a repeated
 * bootstrap never invalidates a grant the steward is about to acknowledge.
 */
export async function bootstrapFirstSteward(ctx: VtaContext, podSigner: PodSigner, did: string): Promise<Omit<BootstrapResult, 'member'> & { member: { did: string; tier: string } }> {
  const issued = await bootstrapSteward(ctx, { podSigner }, did);
  const now = ctx.now();

  const [row] = await ctx.db.query<{ grant: unknown }>('SELECT "grant" FROM members WHERE did = $1', [did]);
  const prior = row?.grant ? (typeof row.grant === 'string' ? JSON.parse(row.grant) : row.grant) as VerifiableCredential : undefined;
  if (prior?.validUntil && Date.parse(prior.validUntil) > now.getTime() && prior.issuer === ctx.podDid) {
    return { member: issued.member, grant: prior, vacs: issued.vacs, explanation: issued.explanation };
  }

  // Exactly `applyMembership`'s grant: no witnessing event here, so the place is the bioregion itself.
  const days = Number(ctx.policy?.grantValidityDays) > 0 ? Number(ctx.policy.grantValidityDays) : MAX_VALIDITY_DAYS.membership;
  const window = grantWindow(now, days);
  const unsigned = buildMembershipGrant({
    pod: ctx.podDid,
    member: did,
    bioregion: ctx.slug,
    placeIds: [ctx.manifest.place.bioregionPolygon ?? `bioregion:${ctx.slug}`],
    governance: ctx.manifest.governance.url,
    validFrom: window.validFrom,
    validUntil: window.validUntil,
  });
  const grant = podSigner.sign(unsigned, { created: now.toISOString() });
  // Pending pair: store the grant and clear any old ack, but keep the T3 `tier`/`effective_tier` the
  // bootstrap just wrote (applyMembership would reset them; the ack keeps max(T1, governance tier)).
  await ctx.db.query(
    `UPDATE members SET vmc_grant_digest = $2, "grant" = $3, vmc_ack_digest = NULL, ack = NULL WHERE did = $1`,
    [did, digestMultibase(grant), JSON.stringify(grant)],
  );
  return { member: issued.member, grant, vacs: issued.vacs, explanation: issued.explanation };
}

export function bootstrapStewardRoutes(deps: BootstrapDeps): MountableRoute[] {
  return [
    {
      method: 'POST',
      path: '/pods/:slug/bootstrap-steward',
      auth: 'operator',
      handler: async (ctx: { platformDomain: string; now: () => Date }, req) => {
        const slug = req.params['slug'] ?? '';
        if (!isSlug(slug)) throw new MountError(400, 'BAD_REQUEST', 'The pod slug must be 2–40 lower-case letters, digits or hyphens.');
        const body = (req.body ?? {}) as { did?: unknown; name?: unknown };
        const did = typeof body.did === 'string' ? body.did.trim() : '';
        if (!DID_RE.test(did) || did.length > 512) {
          throw new MountError(400, 'BAD_REQUEST', 'Give the steward\'s passport identifier for this pod (a DID such as did:key:z…).');
        }
        const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 120) : undefined;
        const pod = await deps.findPod(slug);
        if (!pod) throw new MountError(404, 'POD_NOT_FOUND', `No pod is provisioned as ${slug}.`);
        const podSigner = await deps.loadSigner(slug);
        const result = await deps.withPod(slug, (db) =>
          bootstrapFirstSteward(
            {
              slug: pod.slug,
              podDid: pod.did,
              db,
              manifest: pod.manifest as BioregionManifest,
              policy: pod.policy as TrustPolicy,
              now: ctx.now,
              platformDomain: ctx.platformDomain,
            },
            podSigner,
            did,
          ),
        );
        const out: BootstrapResult = { ...result, member: { ...result.member, ...(name ? { name } : {}) } };
        return { status: 200, body: out };
      },
    },
  ];
}

/** Mounts the bootstrap route; `mountDeps` defaults to the real runtime (see `lib/mount.ts`). */
export function mountBootstrapSteward(deps: BootstrapDeps, mountDeps?: DepsSource): MountedService {
  return mountService(bootstrapStewardRoutes(deps), BOOTSTRAP_MOUNT, mountDeps);
}
