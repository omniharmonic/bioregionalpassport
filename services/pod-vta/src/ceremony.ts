import {
  buildMembershipAck,
  buildRelationship,
  createPresentation,
  digestMultibase,
  generateKeyPair,
  randomNonce,
  signDocument,
  type DidResolver,
  type KeyPair,
  type VerifiableCredential,
} from '@passport/credential-core';
import type { SessionClaims } from '@passport/service-kit';
import { tierDefaultActions, tierRank, TIERS, type Tier } from '@passport/vocab';
import { podDomain } from './challenges.js';
import { createEvent, witnessEdge } from './events.js';
import { acknowledgeMembership, applyMembership } from './membership.js';
import { issueAuthorities, logGovernance, setEffective, type IssuedAuthorities } from './pep.js';
import { edgePairDigest } from './edges.js';
import type { PodSigner, PodVtaDeps, VtaContext } from './types.js';

/** Either full VTA deps or the control plane's smoke helpers (`{ signer, resolver }`). */
export type SignerDeps = Pick<PodVtaDeps, 'podSigner'> | { signer: PodSigner };
export type CeremonyDeps = (Pick<PodVtaDeps, 'podSigner' | 'resolver'> | { signer: PodSigner; resolver: DidResolver });

function signerOf(deps: SignerDeps): PodSigner {
  const s = 'podSigner' in deps ? deps.podSigner : deps.signer;
  if (!s) throw new Error('A pod signer is required.');
  return s;
}

/**
 * First-steward bootstrap (B4 launch checklist): operator-only seeding of a pod's first convener without a
 * ceremony — there is nobody yet who could witness them. Inserts (or raises) the member to T3 and issues a
 * T3 VAC (`event:convene`, `vwc:issue`, `pep:review`, `registry:propose`, plus every T1/T2 action). Never
 * mount this as a member-facing route; the control plane / operator console calls it.
 */
export async function bootstrapSteward(ctx: VtaContext, deps: SignerDeps, did: string): Promise<{ member: { did: string; tier: Tier } } & IssuedAuthorities> {
  if (typeof did !== 'string' || !did.startsWith('did:')) throw new Error('bootstrapSteward needs a DID.');
  // Governance write: `tier` is the governance record; the PEP's effective tier follows. Never lowers a higher
  // governance tier (an existing T4 anchor stays T4).
  const [prior] = await ctx.db.query<{ tier: string }>('SELECT tier FROM members WHERE did = $1', [did]);
  const priorTier: Tier | undefined = prior && (TIERS as readonly string[]).includes(prior.tier) ? (prior.tier as Tier) : undefined;
  const tier: Tier = priorTier && tierRank(priorTier) > tierRank('T3') ? priorTier : 'T3';
  await ctx.db.query(
    `INSERT INTO members (did, tier, joined_at) VALUES ($1, $3, $2)
     ON CONFLICT (did) DO UPDATE SET tier = $3`,
    [did, ctx.now().toISOString(), tier],
  );
  if (prior?.tier !== tier) await logGovernance(ctx, did, prior?.tier ?? null, tier, 'operator', 'First steward bootstrap (B4 launch checklist).');
  const issued = await issueAuthorities(ctx, { podSigner: signerOf(deps) }, did, tier, [
    'First steward bootstrap by the pod operator (B4 launch checklist).',
  ]);
  await setEffective(ctx, did, tier, issued.vacs[0]?.validUntil ?? null);
  return { member: { did, tier }, ...issued };
}

export interface CeremonyOptions {
  /** A session carrying `vwc:issue` (and `event:convene` when no event is given). Default: a freshly bootstrapped steward. */
  convenerSession?: Pick<SessionClaims, 'subject' | 'authorities'>;
  /** The applicant's directed persona key. Default: a new did:key. */
  applicantKey?: KeyPair;
  /** An existing attestation event convened by the convener. Default: a new one running now. */
  event?: { id: string };
  /** The other party of the witnessed relationship. Default: a new did:key. */
  peerKey?: KeyPair;
}

export interface CeremonyResult {
  ok: true;
  detail: string;
  grant: VerifiableCredential;
  ack: VerifiableCredential;
  vacs: VerifiableCredential[];
  vwc: VerifiableCredential;
  member: string;
  eventId: string;
}

/**
 * The ceremony back half in-process (no HTTP), for the control plane's pod smoke: witness → apply → ack → VACs.
 * The applicant's front half (VRC with a peer) is simulated with credential-core builders. Accepts the control
 * plane's `{ signer, resolver }` helpers as `deps`, so `verifyPod({ deps: { vta: { ceremonyBackHalf } } })` works.
 *
 * It leaves nothing behind: its event id is `smoke-` prefixed, not an attestation event, titled
 * "Provisioning smoke (auto-deleted)" and hidden from listings; every row it created (members, events,
 * witness_refs, vac_issuance_log) is deleted in a `finally` before it returns. Rows that existed before (a
 * convener or event passed in `opts`, an applicant who was already a member) are kept.
 */
export async function ceremonyBackHalf(ctx: VtaContext, deps: CeremonyDeps, opts: CeremonyOptions = {}): Promise<CeremonyResult> {
  const podSigner = signerOf(deps);
  const d = { podSigner, resolver: deps.resolver };
  const now = ctx.now();
  const createdMembers: string[] = [];
  const createdEvents: string[] = [];
  const createdVwcs: string[] = [];
  const touched: string[] = [];
  const vacFloor = await ctx.db.query<{ id: string | number | null }>('SELECT max(id) AS id FROM vac_issuance_log');
  const firstNewVacId = Number(vacFloor[0]?.id ?? 0);
  const isMember = async (did: string) => (await ctx.db.query('SELECT 1 FROM members WHERE did = $1', [did])).length > 0;

  try {
    let convener = opts.convenerSession;
    if (!convener) {
      const key = generateKeyPair();
      createdMembers.push(key.did);
      await bootstrapSteward(ctx, d, key.did);
      convener = { subject: key.did, authorities: tierDefaultActions('T3') };
    }
    touched.push(convener.subject);
    if (!convener.authorities.includes('vwc:issue')) throw new Error('The convener session does not carry vwc:issue.');

    let eventId = opts.event?.id;
    if (!eventId) {
      if (!convener.authorities.includes('event:convene')) throw new Error('The convener session does not carry event:convene.');
      const ev = await createEvent(
        ctx,
        d,
        convener.subject,
        {
          title: 'Provisioning smoke (auto-deleted)',
          startsAt: new Date(now.getTime() - 10 * 60_000).toISOString(),
          endsAt: new Date(now.getTime() + 2 * 60 * 60_000).toISOString(),
        },
        { smoke: true },
      );
      eventId = ev.id;
      createdEvents.push(eventId);
    }

    const applicant = opts.applicantKey ?? generateKeyPair();
    if (!(await isMember(applicant.did))) createdMembers.push(applicant.did);
    touched.push(applicant.did);
    const peer = opts.peerKey ?? generateKeyPair();
    const at = { formedAt: now.toISOString(), validFrom: now.toISOString() };
    const vrc = signDocument(buildRelationship({ issuer: applicant.did, subject: peer.did, bioregion: ctx.slug, ...at }), applicant, { created: at.validFrom });
    const vrcPeer = signDocument(buildRelationship({ issuer: peer.did, subject: applicant.did, bioregion: ctx.slug, ...at }), peer, { created: at.validFrom });
    const { vwc } = await witnessEdge(ctx, d, convener.subject, eventId, { vrcA: vrc, vrcB: vrcPeer, evidence: 'same-event', subject: applicant.did });
    if (vwc.credentialSubject['object']?.digestMultibase !== edgePairDigest(vrc, vrcPeer)) throw new Error('The witnessed edge digest is not the pair digest.');
    createdVwcs.push(digestMultibase(vwc));

    const binding = { challenge: randomNonce(), domain: podDomain(ctx) };
    const presentation = createPresentation([vrc, vrcPeer], applicant, binding);
    const { grant } = await applyMembership(ctx, d, { vwc, presentation }, binding);


    const ack = signDocument(
      buildMembershipAck({
        member: applicant.did,
        pod: ctx.podDid,
        grantDigest: digestMultibase(grant),
        // Same window as the grant: a later clock read for validFrom would never be earlier than the grant's,
        // but an earlier one (the smoke's start time) would stretch the ack past the 90-day ceiling.
        validFrom: grant.validFrom,
        validUntil: grant.validUntil!,
      }),
      applicant,
      { created: now.toISOString() },
    );
    const { vacs, member } = await acknowledgeMembership(ctx, d, { ack });
    const expected = [...tierDefaultActions('T1')].sort().join(',');
    const got = [...((vacs[0]?.credentialSubject['authority']?.actions as string[]) ?? [])].sort().join(',');
    if (member.tier !== 'T1' || got !== expected) throw new Error(`The new member did not receive T1 authorities (got ${got || 'none'}).`);
    return {
      ok: true,
      detail: `Admitted a smoke applicant at T1 via event ${eventId}; all smoke rows were removed.`,
      grant,
      ack,
      vacs,
      vwc,
      member: applicant.did,
      eventId,
    };
  } finally {
    // VAC rows issued during the smoke to the DIDs it touched.
    if (touched.length) {
      await ctx.db.query('DELETE FROM vac_issuance_log WHERE id > $1 AND subject_did = ANY($2::text[])', [firstNewVacId, touched]);
    }
    if (createdVwcs.length) {
      await ctx.db.query('DELETE FROM witness_refs WHERE digest = ANY($1::text[])', [createdVwcs]);
      await ctx.db.query('DELETE FROM vta_witness_credentials WHERE digest = ANY($1::text[])', [createdVwcs]);
    }
    if (createdEvents.length) {
      await ctx.db.query('DELETE FROM witness_refs WHERE event_id = ANY($1::text[])', [createdEvents]);
      await ctx.db.query('DELETE FROM events WHERE id = ANY($1::text[])', [createdEvents]);
    }
    if (createdMembers.length) {
      await ctx.db.query('DELETE FROM governance_log WHERE subject_did = ANY($1::text[])', [createdMembers]);
      await ctx.db.query('DELETE FROM members WHERE did = ANY($1::text[])', [createdMembers]);
    }
  }
}
