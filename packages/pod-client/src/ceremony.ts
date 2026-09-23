import {
  buildEndorsement,
  buildRelationship,
  digestMultibase,
  randomNonce,
  signDocument,
  verifyDocument,
  type DataIntegrityProof,
  type DidResolver,
  type KeyPair,
  type VerifiableCredential,
} from '@passport/credential-core';
import { parseMessage, type OobInviteMessage } from '@passport/lexicons';
import type { ContactRow } from './db.js';
import type { MeetingPlace, PodClient, PodEvent } from './client.js';
import type { RelayMessage, RelayTransport } from './relay.js';
import { channelFor, defaultResolver, eventChannel, sleep } from './util.js';
import type { Wallet } from './wallet.js';

export const ENDORSEMENT_SCOPES = ['lives-here', 'worked-with', 'knows'] as const;
export type VouchScope = (typeof ENDORSEMENT_SCOPES)[number];

/**
 * Which identifier signs my VRC half.
 * - `persona` (default): my directed pod persona. The pod admits the holder of the persona that signed one half
 *   of a witnessed pair, so a newcomer must sign with their persona.
 * - `pairwise`: a fresh pairwise did:key for this one relationship (unlinkable, but that relationship cannot be
 *   used for my own admission). The OOB invite's `pairwiseDid` is always the DID the host signs with.
 */
export type RelationshipIdentity = 'persona' | 'pairwise';

export interface CeremonyOptions {
  wallet: Wallet;
  relay: RelayTransport;
  /** Pod slug. */
  pod: string;
  identity?: RelationshipIdentity;
  resolver?: DidResolver;
}

export interface HostSession {
  role: 'host';
  channel: string;
  invite: OobInviteMessage;
  /** The QR payload. */
  inviteJson: string;
  myDid: string;
  lastSeq: number;
  /** Offers that arrived but did not check out (ignored); the last reason, for display. */
  rejected?: number;
  lastRejection?: string;
}

export interface JoinSession {
  role: 'join';
  channel: string;
  invite: OobInviteMessage;
  myDid: string;
  vrcOut: VerifiableCredential;
  lastSeq: number;
  queued?: boolean;
}

export interface Met {
  contact: ContactRow;
  vrcOut: VerifiableCredential;
  vrcIn: VerifiableCredential;
  edgeDigest: string;
}

/**
 * A peer witness's channel (Task 21c): an OOB-style invite with a fresh challenge and no `event`, shown as a QR by a
 * member holding `vwc:issue`. The two neighbors scan it after they have met and post `witness.request` there;
 * channel = base58(sha256(challenge)), so only people who saw the QR can read or write it.
 */
export interface WitnessChannel {
  role: 'witness';
  channel: string;
  invite: OobInviteMessage;
  /** The QR payload: the invite plus `goal: WITNESS_GOAL`, so it cannot be mistaken for a "meet me" code. */
  inviteJson: string;
  myDid: string;
}

/** Marks an OOB invite as a witness channel (extra field; lexicons strip it on parse, so it is read raw). */
export const WITNESS_GOAL = 'org.bioregion.witness';
/** `witness.request.taskContext` for a request to a peer witness (no scheduled event). */
export const MEETING_TASK_CONTEXT = 'meeting';

export interface WitnessRequest {
  seq: number;
  edgeDigest: string;
  taskContext: string;
  requester: string;
  vrcA: VerifiableCredential;
  vrcB: VerifiableCredential;
  createdAt: string;
}

type Signed = VerifiableCredential & { proof: DataIntegrityProof };

/** Pair digest, identical to pod-vta's `edgePairDigest`: digest of the two halves' digests, sorted. */
export function pairDigest(x: VerifiableCredential, y: VerifiableCredential): string {
  const [a, b] = [digestMultibase(x), digestMultibase(y)].sort() as [string, string];
  return digestMultibase({ a, b });
}

/** A relay message whose body is a valid B3 §5 ceremony message; malformed bodies are skipped, never trusted. */
function valid(m: RelayMessage): (RelayMessage & { body: Record<string, any> }) | undefined {
  try {
    parseMessage(m.body);
    return m as RelayMessage & { body: Record<string, any> };
  } catch {
    return undefined;
  }
}

const isType = (v: any, t: string) => Array.isArray(v?.type) && v.type.includes('VerifiableCredential') && v.type.includes(t);

function readInvite(text: string): { invite: OobInviteMessage; goal?: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text.trim());
  } catch {
    throw new Error('That code is not a passport invitation.');
  }
  let msg;
  try {
    msg = parseMessage(raw);
  } catch {
    throw new Error('That code is not a passport invitation.');
  }
  if (msg.type !== 'org.bioregion.oob.invite') throw new Error('That code is not a passport invitation.');
  const goal = (raw as Record<string, unknown>)['goal'];
  return { invite: msg, ...(typeof goal === 'string' ? { goal } : {}) };
}

/** Parses and validates an OOB invite from a scanned or pasted QR payload. */
export function parseInvite(text: string): OobInviteMessage {
  return readInvite(text).invite;
}

/** Parses a peer witness's channel code (`goal: WITNESS_GOAL`, no event). */
export function parseWitnessInvite(text: string): OobInviteMessage {
  const { invite, goal } = readInvite(text);
  if (goal !== WITNESS_GOAL || invite.event) throw new Error('That is not a witness code; ask your witness to open “Witness a relationship” in their passport.');
  return invite;
}

/**
 * The in-person attestation ceremony, both roles (ADR-22: QR + HTTP relay):
 *
 * host → shows `org.bioregion.oob.invite` as a QR; channel = base58(sha256(challenge)).
 * joiner → scans, signs its VRC half (issuer = joiner, subject = invite.pairwiseDid), posts `vrc.offer`.
 * host → checks the offer, signs its half back, posts `vrc.accept`. Both store the contact and BOTH halves.
 * Then either may vouch (VEC) over the same channel, ask a convener to witness the pair (`witness.request` on the
 * event channel), and apply for membership with the `witness.result`.
 */
export class Ceremony {
  readonly wallet: Wallet;
  readonly relay: RelayTransport;
  readonly pod: string;
  readonly identity: RelationshipIdentity;
  private readonly resolver: DidResolver;

  constructor(opts: CeremonyOptions) {
    this.wallet = opts.wallet;
    this.relay = opts.relay;
    this.pod = opts.pod;
    this.identity = opts.identity ?? 'persona';
    this.resolver = opts.resolver ?? defaultResolver();
  }

  private async myKey(): Promise<KeyPair> {
    if (!(await this.wallet.pod(this.pod))) throw new Error('Join this pod in your passport first.');
    if (this.identity === 'pairwise') return this.wallet.mintPairwise(this.pod);
    const persona = await this.wallet.personaFor(this.pod);
    if (!persona) throw new Error('Join this pod in your passport first.');
    return persona;
  }

  private async keyOf(did: string): Promise<KeyPair> {
    const key = await this.wallet.keyFor(did);
    if (!key) throw new Error('This passport no longer holds the identifier used for that relationship.');
    return key;
  }

  private async envelope(did: string) {
    return { createdAt: this.wallet.now().toISOString(), seq: await this.wallet.nextSeq(did) };
  }

  private signHalf(me: KeyPair, them: string, formedAt: string): VerifiableCredential {
    const now = this.wallet.now().toISOString();
    return signDocument(buildRelationship({ issuer: me.did, subject: them, bioregion: this.pod, formedAt, validFrom: now }), me);
  }

  /** Checks a VRC half the other person sent: shape, parties, pod and signature. Returns their DID. */
  private async checkHalf(vc: unknown, p: { subject: string; issuer?: string }): Promise<Signed> {
    if (!isType(vc, 'RelationshipCredential') || !(vc as Signed).proof) throw new Error('Your neighbor sent something that is not a signed relationship credential.');
    const half = vc as Signed;
    if (half.credentialSubject?.id !== p.subject) throw new Error('This relationship credential was made out to someone else.');
    if (p.issuer && half.issuer !== p.issuer) throw new Error('This relationship credential is not from the person whose code you scanned.');
    if (half.issuer === p.subject) throw new Error('A relationship needs two different people.');
    if (half.credentialSubject['bioregion'] !== this.pod) throw new Error('This relationship credential is for a different pod.');
    const r = await verifyDocument(half, this.resolver, { proofPurpose: 'assertionMethod' });
    if (!r.ok) throw new Error('Your neighbor’s signature did not check out.');
    return half;
  }

  private async checkVec(vc: unknown, p: { issuer: string; subject: string }): Promise<Signed | undefined> {
    if (!isType(vc, 'StatementCredential') || !(vc as Signed).proof) return undefined;
    const vec = vc as Signed;
    if (vec.credentialSubject?.['predicate'] !== 'dtg:endorses' || vec.issuer !== p.issuer || vec.credentialSubject.id !== p.subject) return undefined;
    const r = await verifyDocument(vec, this.resolver, { proofPurpose: 'assertionMethod' });
    return r.ok ? vec : undefined;
  }

  private async saveRelationship(p: { myDid: string; theirDid: string; vrcOut: VerifiableCredential; vrcIn: VerifiableCredential; channel: string; lastSeq: number; event?: string; vecIn?: VerifiableCredential }): Promise<Met> {
    const edgeDigest = pairDigest(p.vrcOut, p.vrcIn);
    const prior = await this.wallet.contact(p.theirDid);
    const contact: ContactRow = {
      ...(prior ?? {}),
      did: p.theirDid,
      pod: this.pod,
      myDid: p.myDid,
      vrcOut: p.vrcOut,
      vrcIn: p.vrcIn,
      formedAt: String(p.vrcOut.credentialSubject['formedAt'] ?? this.wallet.now().toISOString()),
      edgeDigest,
      channel: p.channel,
      lastSeq: p.lastSeq,
      ...(p.event ? { event: p.event } : {}),
      ...(p.vecIn ? { vecIn: p.vecIn } : {}),
    };
    await this.wallet.putContact(contact);
    await this.wallet.storeCredential(p.vrcOut, { pod: this.pod });
    await this.wallet.storeCredential(p.vrcIn, { pod: this.pod });
    if (p.vecIn) await this.wallet.storeCredential(p.vecIn, { pod: this.pod });
    const idRow = await this.wallet.db.identifiers.get(p.myDid);
    if (idRow?.scope === 'pairwise' && !idRow.counterparty) await this.wallet.setCounterparty(p.myDid, p.theirDid);
    return { contact, vrcOut: p.vrcOut, vrcIn: p.vrcIn, edgeDigest };
  }

  // ── host ────────────────────────────────────────────────────────────────────────────────────────

  /** Starts hosting: the invite to show as a QR. */
  async host(opts: { event?: string } = {}): Promise<HostSession> {
    const me = await this.myKey();
    const challenge = randomNonce(24);
    const invite: OobInviteMessage = {
      type: 'org.bioregion.oob.invite',
      ...(await this.envelope(me.did)),
      pairwiseDid: me.did,
      challenge,
      pod: this.pod,
      ...(opts.event ? { event: opts.event } : {}),
    };
    return { role: 'host', channel: channelFor(challenge), invite, inviteJson: JSON.stringify(invite), myDid: me.did, lastSeq: 0 };
  }

  /** One poll: when the joiner's offer has arrived, signs my half back and stores the relationship. */
  async pollHost(session: HostSession): Promise<Met | null> {
    const msgs = await this.relay.list(session.channel, session.lastSeq);
    for (const raw of msgs) {
      session.lastSeq = Math.max(session.lastSeq, raw.seq);
      const m = valid(raw);
      if (!m || m.body.type !== 'org.bioregion.vrc.offer' || m.sender === session.myDid) continue;
      let theirs: Signed;
      try {
        theirs = await this.checkHalf(m.body.vrc, { subject: session.myDid });
      } catch (e) {
        // Anyone who saw the QR could post here: a bad offer is ignored and we keep waiting for the real one.
        session.rejected = (session.rejected ?? 0) + 1;
        session.lastRejection = e instanceof Error ? e.message : String(e);
        continue;
      }
      const me = await this.keyOf(session.myDid);
      const mine = this.signHalf(me, theirs.issuer, String(theirs.credentialSubject['formedAt'] ?? this.wallet.now().toISOString()));
      await this.relay.post(session.channel, me.did, { type: 'org.bioregion.vrc.accept', ...(await this.envelope(me.did)), vrc: mine });
      const vecIn = await this.checkVec(m.body.vec, { issuer: theirs.issuer, subject: me.did });
      return this.saveRelationship({
        myDid: me.did,
        theirDid: theirs.issuer,
        vrcOut: mine,
        vrcIn: theirs,
        channel: session.channel,
        lastSeq: session.lastSeq,
        ...(session.invite.event ? { event: session.invite.event } : {}),
        ...(vecIn ? { vecIn } : {}),
      });
    }
    return null;
  }

  async waitForOffer(session: HostSession, opts: { intervalMs?: number; signal?: AbortSignal } = {}): Promise<Met> {
    for (;;) {
      const met = await this.pollHost(session);
      if (met) return met;
      await sleep(opts.intervalMs ?? 2000, opts.signal);
    }
  }

  // ── joiner ──────────────────────────────────────────────────────────────────────────────────────

  /** Scanned an invite: signs my half and posts `vrc.offer` (queued in the outbox when offline). */
  async join(inviteJson: string, opts: { vouch?: VouchScope } = {}): Promise<JoinSession> {
    const { invite, goal } = readInvite(inviteJson);
    if (goal === WITNESS_GOAL) throw new Error('This is a witness code. Meet your neighbor first, then scan it from “Ask a neighbor to witness”.');
    if (invite.pod !== this.pod) throw new Error(`This invitation is for the ${invite.pod} pod.`);
    const me = await this.myKey();
    if (invite.pairwiseDid === me.did) throw new Error('This is your own code; show it to your neighbor instead.');
    const vrcOut = this.signHalf(me, invite.pairwiseDid, this.wallet.now().toISOString());
    const vec = opts.vouch ? signDocument(buildEndorsement({ issuer: me.did, subject: invite.pairwiseDid, scope: opts.vouch }), me) : undefined;
    const channel = channelFor(invite.challenge);
    const r = await this.relay.post(channel, me.did, { type: 'org.bioregion.vrc.offer', ...(await this.envelope(me.did)), vrc: vrcOut, ...(vec ? { vec } : {}) });
    return { role: 'join', channel, invite, myDid: me.did, vrcOut, lastSeq: 0, ...(r.queued ? { queued: true } : {}) };
  }

  /** One poll: when the host's accept has arrived, stores the relationship. */
  async pollJoin(session: JoinSession): Promise<Met | null> {
    const msgs = await this.relay.list(session.channel, session.lastSeq);
    for (const raw of msgs) {
      session.lastSeq = Math.max(session.lastSeq, raw.seq);
      const m = valid(raw);
      if (!m || m.body.type !== 'org.bioregion.vrc.accept' || m.sender === session.myDid) continue;
      let theirs: Signed;
      try {
        theirs = await this.checkHalf(m.body.vrc, { subject: session.myDid, issuer: session.invite.pairwiseDid });
      } catch {
        continue;
      }
      const vecIn = await this.checkVec(m.body.vec, { issuer: theirs.issuer, subject: session.myDid });
      return this.saveRelationship({
        myDid: session.myDid,
        theirDid: theirs.issuer,
        vrcOut: session.vrcOut,
        vrcIn: theirs,
        channel: session.channel,
        lastSeq: session.lastSeq,
        ...(session.invite.event ? { event: session.invite.event } : {}),
        ...(vecIn ? { vecIn } : {}),
      });
    }
    return null;
  }

  async waitForAccept(session: JoinSession, opts: { intervalMs?: number; signal?: AbortSignal } = {}): Promise<Met> {
    for (;;) {
      const met = await this.pollJoin(session);
      if (met) return met;
      await sleep(opts.intervalMs ?? 2000, opts.signal);
    }
  }

  // ── vouching (F4) ───────────────────────────────────────────────────────────────────────────────

  /**
   * Signs a vouch (VEC, `dtg:endorses`) for a contact and delivers it over the relationship's relay channel
   * (re-sending my VRC half with the `vec`). It is evidence only; the contact decides whether to count it.
   */
  async vouch(contactDid: string, scope: VouchScope): Promise<{ vec: VerifiableCredential; queued: boolean }> {
    const contact = await this.wallet.contact(contactDid);
    if (!contact || !contact.vrcOut) throw new Error('You can only vouch for someone you have met.');
    const me = await this.keyOf(contact.myDid);
    const vec = signDocument(buildEndorsement({ issuer: me.did, subject: contactDid, scope }), me);
    await this.wallet.updateContact(contactDid, { vecOut: vec });
    await this.wallet.storeCredential(vec, { pod: contact.pod });
    let queued = false;
    if (contact.channel) {
      const r = await this.relay.post(contact.channel, me.did, { type: 'org.bioregion.vrc.offer', ...(await this.envelope(me.did)), vrc: contact.vrcOut, vec });
      queued = !!r.queued;
    }
    return { vec, queued };
  }

  /** Picks up vouches contacts sent over their relationship channels. Returns the contacts with a new vouch. */
  async syncContacts(): Promise<string[]> {
    const updated: string[] = [];
    for (const c of await this.wallet.contacts(this.pod)) {
      if (!c.channel) continue;
      let msgs: RelayMessage[];
      try {
        msgs = await this.relay.list(c.channel, c.lastSeq ?? 0);
      } catch {
        continue;
      }
      if (!msgs.length) continue;
      let lastSeq = c.lastSeq ?? 0;
      let vecIn = c.vecIn;
      for (const raw of msgs) {
        lastSeq = Math.max(lastSeq, raw.seq);
        const m = valid(raw);
        if (!m || m.sender !== c.did || !m.body.vec) continue;
        const vec = await this.checkVec(m.body.vec, { issuer: c.did, subject: c.myDid });
        if (vec && digestMultibase(vec) !== (vecIn ? digestMultibase(vecIn) : '')) {
          vecIn = vec;
          await this.wallet.storeCredential(vec, { pod: this.pod });
          updated.push(c.did);
        }
      }
      await this.wallet.updateContact(c.did, { lastSeq, ...(vecIn ? { vecIn } : {}) });
    }
    return updated;
  }

  // ── witnessing ──────────────────────────────────────────────────────────────────────────────────

  private async listAll(channel: string): Promise<RelayMessage[]> {
    const out: RelayMessage[] = [];
    let after = 0;
    for (let page = 0; page < 50; page++) {
      const msgs = await this.relay.list(channel, after);
      out.push(...msgs);
      if (msgs.length < 100) break;
      after = msgs[msgs.length - 1]!.seq;
    }
    return out;
  }

  /** "I'm here": posts `witness.request { edgeDigest, taskContext, requester, vrcA, vrcB }` to the event channel. */
  async requestWitness(event: { id: string; taskDigest?: string | null }, contactDid: string): Promise<{ queued: boolean; edgeDigest: string }> {
    const c = await this.wallet.contact(contactDid);
    if (!c?.vrcOut || !c.vrcIn) throw new Error('Both halves of this relationship are needed before a convener can witness it.');
    const edgeDigest = pairDigest(c.vrcOut, c.vrcIn);
    const r = await this.relay.post(eventChannel(event), c.myDid, {
      type: 'org.bioregion.witness.request',
      ...(await this.envelope(c.myDid)),
      edgeDigest,
      taskContext: event.id,
      requester: c.myDid,
      vrcA: c.vrcOut,
      vrcB: c.vrcIn,
    });
    await this.wallet.updateContact(contactDid, { edgeDigest, witnessRequested: { event: event.id, at: this.wallet.now().toISOString() } });
    return { queued: !!r.queued, edgeDigest };
  }

  /**
   * A `witness.result` VWC is trusted only when it is a pod-signed (`verifyDocument` against the pod's DID)
   * `dtg:witnessed` statement for this event and `edgeDigest`. The event channel is readable and writable by
   * anyone who knows the event, so anything else is ignored.
   */
  async verifyWitnessResult(vwc: unknown, event: { id: string } | null, edgeDigest: string): Promise<VerifiableCredential | undefined> {
    const podDid = (await this.wallet.pod(this.pod))?.did;
    if (!podDid || !isType(vwc, 'StatementCredential') || !(vwc as Signed).proof) return undefined;
    const v = vwc as Signed;
    const subj = v.credentialSubject ?? ({} as Record<string, any>);
    // At an event the VWC must be bound to that event; a peer witness's VWC is bound to a meeting Trust Task the
    // pod created when it witnessed (unknown to the requesters beforehand), so any task id is accepted there.
    const taskOk = event ? subj['taskContext'] === event.id : typeof subj['taskContext'] === 'string' && subj['taskContext'].length > 0;
    if (v.issuer !== podDid || subj['predicate'] !== 'dtg:witnessed' || !taskOk || subj['object']?.digestMultibase !== edgeDigest) return undefined;
    const r = await verifyDocument(v, this.resolver, { proofPurpose: 'assertionMethod' }).catch(() => ({ ok: false, controller: undefined }));
    return r.ok && r.controller === podDid ? v : undefined;
  }

  /** Convener view: open witness requests at an event (not yet validly answered), one per relationship. */
  async listWitnessRequests(event: { id: string; taskDigest?: string | null }): Promise<WitnessRequest[]> {
    return this.openRequests(eventChannel(event), event.id, event);
  }

  /**
   * Open requests on a channel: valid `witness.request`s for `taskContext` whose VRC pair matches `edgeDigest`,
   * minus those already answered by a VERIFIED result (a forged "answer" must not hide a real request).
   */
  private async openRequests(channel: string, taskContext: string, event: { id: string } | null): Promise<WitnessRequest[]> {
    const msgs = (await this.listAll(channel)).map(valid).filter((m): m is RelayMessage & { body: Record<string, any> } => !!m);
    const answered = new Set<string>();
    for (const m of msgs) {
      if (m.body.type !== 'org.bioregion.witness.result') continue;
      const d = m.body.vwc?.credentialSubject?.object?.digestMultibase;
      if (typeof d === 'string' && !answered.has(d) && (await this.verifyWitnessResult(m.body.vwc, event, d))) answered.add(d);
    }
    const open = new Map<string, WitnessRequest>();
    for (const m of msgs) {
      const b = m.body;
      if (b.type !== 'org.bioregion.witness.request' || b.taskContext !== taskContext || answered.has(b.edgeDigest)) continue;
      if (!isType(b.vrcA, 'RelationshipCredential') || !isType(b.vrcB, 'RelationshipCredential')) continue;
      if (pairDigest(b.vrcA, b.vrcB) !== b.edgeDigest) continue;
      if (open.has(b.edgeDigest) || !(await this.pairChecksOut(b.vrcA, b.vrcB, b.edgeDigest))) continue;
      open.set(b.edgeDigest, { seq: m.seq, edgeDigest: b.edgeDigest, taskContext: b.taskContext, requester: b.requester, vrcA: b.vrcA, vrcB: b.vrcB, createdAt: b.createdAt });
    }
    return [...open.values()];
  }

  private readonly checkedPairs = new Map<string, boolean>();

  /**
   * A listed request must carry two genuinely signed, mirrored halves of one relationship in this pod (each issuer
   * is the other's subject); anything else is skipped, so a witness only ever sees pairs the pod would accept.
   */
  private async pairChecksOut(a: VerifiableCredential, b: VerifiableCredential, edgeDigest: string): Promise<boolean> {
    const known = this.checkedPairs.get(edgeDigest);
    if (known !== undefined) return known;
    let ok = a.issuer !== b.issuer && a.credentialSubject?.id === b.issuer && b.credentialSubject?.id === a.issuer;
    ok &&= a.credentialSubject?.['bioregion'] === this.pod && b.credentialSubject?.['bioregion'] === this.pod;
    for (const half of [a, b]) {
      if (!ok) break;
      if (!(half as Signed).proof) {
        ok = false;
        break;
      }
      const r = await verifyDocument(half as Signed, this.resolver, { proofPurpose: 'assertionMethod' }).catch(() => ({ ok: false }));
      ok = r.ok;
    }
    this.checkedPairs.set(edgeDigest, ok);
    return ok;
  }

  /** Convener: asks the pod to witness the pair (`POST /events/:id/witness`) and posts `witness.result { vwc }`. */
  async witness(client: PodClient, event: { id: string; taskDigest?: string | null }, request: WitnessRequest, evidence: 'same-event' | 'liveness' = 'same-event'): Promise<VerifiableCredential> {
    const vwc = await client.witness(event.id, request.vrcA, request.vrcB, evidence);
    const sender = client.persona?.did ?? 'convener';
    await this.relay.post(eventChannel(event), sender, {
      type: 'org.bioregion.witness.result',
      createdAt: this.wallet.now().toISOString(),
      seq: client.persona ? await this.wallet.nextSeq(client.persona.did) : 1,
      vwc,
    });
    return vwc;
  }

  /** Applicant (or the other party): looks for a verified `witness.result` for my relationship; stores the VWC. */
  async pollWitnessResult(event: { id: string; taskDigest?: string | null }, contactDid: string): Promise<VerifiableCredential | undefined> {
    // The event channel first; then every witness channel I asked on and the relationship channel, so a result
    // that arrived elsewhere (another witness, or forwarded by my neighbor) is never lost.
    return this.pollResult([{ channel: eventChannel(event), event }, ...(await this.peerSources(contactDid))], contactDid);
  }

  /** Witness channels asked on for this relationship, plus its relationship channel (forwarded results). */
  private async peerSources(contactDid: string): Promise<{ channel: string; event: null }[]> {
    const c = await this.wallet.contact(contactDid);
    const channels = [...(c?.witnessChannels ?? []), ...(c?.witnessRequested?.channel ? [c.witnessRequested.channel] : []), ...(c?.channel ? [c.channel] : [])];
    return [...new Set(channels)].map((channel) => ({ channel, event: null }));
  }

  private async pollResult(sources: { channel: string; event: { id: string } | null }[], contactDid: string): Promise<VerifiableCredential | undefined> {
    const c = await this.wallet.contact(contactDid);
    if (!c?.vrcOut || !c.vrcIn) return undefined;
    if (c.vwc) return c.vwc;
    const edge = pairDigest(c.vrcOut, c.vrcIn);
    const refused = new Set(c.refusedVwcs ?? []);
    for (const { channel, event } of sources) {
      let msgs: RelayMessage[];
      try {
        msgs = await this.listAll(channel);
      } catch {
        continue;
      }
      for (const raw of msgs) {
        const m = valid(raw);
        if (!m || m.body.type !== 'org.bioregion.witness.result') continue;
        const vwc = await this.verifyWitnessResult(m.body.vwc, event, edge);
        if (!vwc || refused.has(digestMultibase(vwc))) continue;
        await this.wallet.updateContact(contactDid, { vwc });
        await this.wallet.storeCredential(vwc, { pod: this.pod });
        await this.shareResult(c, vwc, channel);
        return vwc;
      }
    }
    return undefined;
  }

  /**
   * Forwards a picked-up VWC to the relationship channel (so my neighbor gets it even if they never scanned the
   * witness's code) and to every other witness channel I asked on (so those witnesses' queues close the request).
   * Best effort: the VWC is already stored; recipients verify it themselves.
   */
  private async shareResult(c: ContactRow, vwc: VerifiableCredential, from: string): Promise<void> {
    const targets = new Set([...(c.channel ? [c.channel] : []), ...(c.witnessChannels ?? []), ...(c.witnessRequested?.channel ? [c.witnessRequested.channel] : [])]);
    targets.delete(from);
    for (const channel of targets) {
      try {
        await this.relay.post(channel, c.myDid, { type: 'org.bioregion.witness.result', ...(await this.envelope(c.myDid)), vwc });
      } catch {
        // Forwarding is a courtesy; the neighbor can still pick the result up from a witness channel.
      }
    }
  }

  // ── peer witnessing (no scheduled event) ────────────────────────────────────────────────────────

  /** Witness (`vwc:issue`): opens a witness channel to show as a QR. The invite omits `event`. */
  async hostWitness(): Promise<WitnessChannel> {
    const me = await this.myKey();
    const challenge = randomNonce(24);
    const invite: OobInviteMessage = { type: 'org.bioregion.oob.invite', ...(await this.envelope(me.did)), pairwiseDid: me.did, challenge, pod: this.pod };
    return { role: 'witness', channel: channelFor(challenge), invite, inviteJson: JSON.stringify({ ...invite, goal: WITNESS_GOAL }), myDid: me.did };
  }

  /**
   * Requester, after meeting: scanned a witness's code; posts `witness.request { vrcA, vrcB, requester,
   * taskContext: 'meeting' }` to that witness's channel (queued in the outbox when offline).
   */
  async requestPeerWitness(inviteJson: string, contactDid: string): Promise<{ queued: boolean; edgeDigest: string; witness: string }> {
    const invite = parseWitnessInvite(inviteJson);
    if (invite.pod !== this.pod) throw new Error(`This witness code is for the ${invite.pod} pod.`);
    const c = await this.wallet.contact(contactDid);
    if (!c?.vrcOut || !c.vrcIn) throw new Error('Both halves of this relationship are needed before anyone can witness it.');
    if (invite.pairwiseDid === c.did || invite.pairwiseDid === c.myDid) throw new Error('Your witness must be someone other than the two of you.');
    const channel = channelFor(invite.challenge);
    const edgeDigest = pairDigest(c.vrcOut, c.vrcIn);
    const r = await this.relay.post(channel, c.myDid, {
      type: 'org.bioregion.witness.request',
      ...(await this.envelope(c.myDid)),
      edgeDigest,
      taskContext: MEETING_TASK_CONTEXT,
      requester: c.myDid,
      vrcA: c.vrcOut,
      vrcB: c.vrcIn,
    });
    // Every channel asked on is kept (asking a second witness must not orphan the first one's answer).
    await this.wallet.updateContact(contactDid, {
      edgeDigest,
      witnessChannels: [...new Set([...(c.witnessChannels ?? []), channel])],
      witnessRequested: { event: MEETING_TASK_CONTEXT, channel, witness: invite.pairwiseDid, at: this.wallet.now().toISOString() },
    });
    return { queued: !!r.queued, edgeDigest, witness: invite.pairwiseDid };
  }

  /** Witness view: open requests on my witness channel, one per relationship; never pairs I am part of. */
  async listPeerWitnessRequests(session: WitnessChannel): Promise<WitnessRequest[]> {
    const open = await this.openRequests(session.channel, MEETING_TASK_CONTEXT, null);
    return open.filter((r) => r.vrcA.issuer !== session.myDid && r.vrcB.issuer !== session.myDid);
  }

  /**
   * Witness: "I saw these two people together" → `POST /witness` (evidence 'liveness') → posts `witness.result
   * { vwc }` back on the channel, where the requesters' polling picks it up.
   */
  async witnessPeer(client: PodClient, session: WitnessChannel, request: WitnessRequest, opts: { place?: MeetingPlace } = {}): Promise<{ vwc: VerifiableCredential; task: PodEvent }> {
    if (request.vrcA.issuer === session.myDid || request.vrcB.issuer === session.myDid) throw new Error('You cannot witness your own relationship; ask another neighbor.');
    const out = await client.witnessMeeting(request.vrcA, request.vrcB, opts.place);
    const sender = client.persona?.did ?? session.myDid;
    await this.relay.post(session.channel, sender, {
      type: 'org.bioregion.witness.result',
      createdAt: this.wallet.now().toISOString(),
      seq: await this.wallet.nextSeq(sender),
      vwc: out.vwc,
    });
    return out;
  }

  /**
   * Either neighbor: looks for a verified result on every witness channel asked on for this relationship and on
   * the relationship channel (where the other neighbor forwards it); stores the VWC and forwards it in turn.
   */
  async pollPeerWitnessResult(contactDid: string): Promise<VerifiableCredential | undefined> {
    const c = await this.wallet.contact(contactDid);
    if (!c || c.vwc) return c?.vwc;
    return this.pollResult(await this.peerSources(contactDid), contactDid);
  }
}
