import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getRootCredentials, getStaffVac, rootPodCredentials, staffCredential, walletCredentials } from './walletCreds';

const POD = 'did:web:bioregionalpassport.org:dids:boulder';
const OTHER_POD = 'did:web:bioregionalpassport.org:dids:tenant-zero';
const ME = 'did:key:zMe';
const OWNER = 'did:key:zOwner';
const ENT = 'did:key:zEnterprise';
const DAY = 86_400_000;
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

const vac = (p: { issuer: string; subject: string; scope: string; actions: string[]; parent?: string; from?: number; until?: number; type?: string[] }) => ({
  type: p.type ?? ['VerifiableCredential', 'AuthorityCredential'],
  issuer: p.issuer,
  validFrom: iso(p.from ?? now - DAY),
  validUntil: iso(p.until ?? now + 30 * DAY),
  credentialSubject: { id: p.subject, authority: { scope: p.scope, actions: p.actions, ...(p.parent ? { parent: p.parent } : {}) } },
  proof: { type: 'DataIntegrityProof', proofValue: 'z' },
});

const root = vac({ issuer: POD, subject: ME, scope: POD, actions: ['credit:account', 'credit:limit:L2'] });
const merchantRoot = vac({ issuer: POD, subject: ME, scope: ENT, actions: ['pay:receive'] });
const otherPod = vac({ issuer: OTHER_POD, subject: ME, scope: OTHER_POD, actions: ['credit:account'] });
const expired = vac({ issuer: POD, subject: ME, scope: POD, actions: ['credit:account'], until: now - 1000 });
const forwarded = vac({ issuer: OWNER, subject: ME, scope: POD, actions: ['credit:account'], parent: 'zParent' });
const staff = vac({ issuer: OWNER, subject: ME, scope: ENT, actions: ['pay:receive'], parent: 'zRoot', until: now + 10 * DAY });
const staffLonger = vac({ issuer: OWNER, subject: ME, scope: ENT, actions: ['pay:receive'], parent: 'zRoot', until: now + 20 * DAY });
const staffOther = vac({ issuer: OWNER, subject: 'did:key:zSomeoneElse', scope: ENT, actions: ['pay:receive'], parent: 'zRoot', until: now + 29 * DAY });
const membership = { ...vac({ issuer: POD, subject: ME, scope: POD, actions: [] }), type: ['VerifiableCredential', 'MembershipCredential'] };

describe('credential selection', () => {
  const all = [root, merchantRoot, otherPod, expired, forwarded, staff, staffLonger, staffOther, membership];

  it('keeps only unexpired root authority credentials issued by this pod', () => {
    expect(rootPodCredentials(all, POD, now)).toEqual([root, merchantRoot]);
  });

  it('picks the longest-lasting passed-on authority for the enterprise and subject', () => {
    expect(staffCredential(all, ENT, ME, now)).toBe(staffLonger);
    expect(staffCredential(all, ENT, undefined, now)).toBe(staffOther);
    expect(staffCredential(all, 'did:key:zNope', ME, now)).toBeNull();
  });
});

describe('reading the passport store (fake-indexeddb)', () => {
  const DB = 'passport-wallet-test';
  beforeAll(async () => {
    // Same table layout as packages/pod-client/src/db.ts.
    const db = new Dexie(DB);
    db.version(1).stores({ credentials: 'digest, type, kind, pod, issuer, subject' });
    await db.open();
    await db.table('credentials').bulkAdd([
      { digest: 'd1', type: 'AuthorityCredential', kind: 'vac', pod: 'boulder', issuer: POD, subject: ME, raw: root, receivedAt: iso(now) },
      { digest: 'd2', type: 'AuthorityCredential', kind: 'vac', pod: 'boulder', issuer: POD, subject: ME, raw: expired, receivedAt: iso(now) },
      { digest: 'd3', type: 'AuthorityCredential', kind: 'vac', pod: 'boulder', issuer: OWNER, subject: ME, raw: staff, receivedAt: iso(now) },
      { digest: 'd4', type: 'AuthorityCredential', kind: 'vac', pod: 'boulder', issuer: POD, subject: ME, raw: otherPod, receivedAt: iso(now), status: 'superseded' },
    ]);
    db.close();
  });
  afterAll(async () => {
    await Dexie.delete(DB);
  });

  it('reads current credentials and selects roots and staff authority', async () => {
    expect(await walletCredentials(DB)).toHaveLength(3);
    expect(await getRootCredentials(POD, DB)).toEqual([root]);
    expect(await getStaffVac(ENT, ME, DB)).toEqual(staff);
  });

  it('returns nothing when there is no passport on this device', async () => {
    expect(await walletCredentials('no-such-db')).toEqual([]);
    expect(await getRootCredentials(POD, 'no-such-db')).toEqual([]);
  });
});
