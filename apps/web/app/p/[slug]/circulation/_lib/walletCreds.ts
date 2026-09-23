/**
 * Reads the passport's credentials straight from its IndexedDB store (`passport-wallet`, schema in
 * `packages/pod-client/src/db.ts`) on the same origin — the same approach as the grants pages
 * (`grants/_lib/voting.ts`). Nothing is written. The gateway wants:
 * - `{ credentials }` on `/accounts/open` and `/merchant/enterprises`: the member's own root authority
 *   credentials issued by this pod (never passed-on ones), unexpired;
 * - `staffVac` on `/pay/request` and `/pay/:id/tender` from staff: the passed-on authority for that enterprise.
 */

export const WALLET_DB = 'passport-wallet';

type Row = Record<string, any>;
export type Credential = Record<string, any>;

const authorityOf = (vc: Credential): Row | null => {
  const a = vc?.['credentialSubject']?.['authority'];
  return a && typeof a === 'object' ? a : null;
};

const isAuthority = (vc: Credential): boolean => Array.isArray(vc?.['type']) && vc['type'].includes('AuthorityCredential');

const current = (vc: Credential, now: number): boolean => {
  const from = Date.parse(String(vc['validFrom'] ?? ''));
  const until = Date.parse(String(vc['validUntil'] ?? ''));
  return !(from > now) && until > now;
};

/** A stored row → its credential (`raw` in pod-client; `credential`/`vc`/bare accepted); superseded rows are skipped. */
export function credentialOfRow(row: Row): Credential | null {
  if (!row || row['status'] === 'superseded') return null;
  for (const c of [row['raw'], row['credential'], row['vc'], row]) {
    if (c && typeof c === 'object' && c['credentialSubject'] && c['proof'] && c['type']) return c as Credential;
  }
  return null;
}

/** Root authority credentials issued by this pod: `AuthorityCredential`, `issuer === podDid`, no parent, unexpired. */
export function rootPodCredentials(creds: Credential[], podDid: string, now: number = Date.now()): Credential[] {
  return creds.filter((vc) => {
    const a = authorityOf(vc);
    return isAuthority(vc) && vc['issuer'] === podDid && a !== null && a['parent'] === undefined && current(vc, now);
  });
}

/**
 * The staff credential for an enterprise: passed-on authority (`authority.parent` set) scoped to the
 * enterprise, unexpired, for `subject` when given; the one lasting longest wins.
 */
export function staffCredential(creds: Credential[], enterpriseDid: string, subject?: string, now: number = Date.now()): Credential | null {
  const hits = creds.filter((vc) => {
    const a = authorityOf(vc);
    if (!isAuthority(vc) || !a || a['scope'] !== enterpriseDid || typeof a['parent'] !== 'string' || !current(vc, now)) return false;
    return subject === undefined || vc['credentialSubject']?.['id'] === subject;
  });
  hits.sort((x, y) => Date.parse(String(y['validUntil'])) - Date.parse(String(x['validUntil'])));
  return hits[0] ?? null;
}

async function databaseExists(name: string): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false;
  const list = (indexedDB as IDBFactory & { databases?: () => Promise<{ name?: string }[]> }).databases;
  if (typeof list !== 'function') return true; // cannot tell; Dexie opens what is there
  try {
    return (await list.call(indexedDB)).some((d) => d.name === name);
  } catch {
    return true;
  }
}

/** Every current credential in the passport ([] when there is no passport on this device). */
export async function walletCredentials(dbName: string = WALLET_DB): Promise<Credential[]> {
  if (!(await databaseExists(dbName))) return [];
  const { default: Dexie } = await import('dexie');
  // No schema declared: Dexie opens the passport's database as it is and never alters it.
  const db = new Dexie(dbName);
  try {
    await db.open();
    if (!db.tables.some((t) => t.name === 'credentials')) return [];
    const rows = (await db.table('credentials').toArray()) as Row[];
    return rows.map(credentialOfRow).filter((c): c is Credential => c !== null);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** The member's own root credentials from this pod, for `{ credentials }` bodies. */
export async function getRootCredentials(podDid: string, dbName?: string): Promise<Credential[]> {
  return rootPodCredentials(await walletCredentials(dbName), podDid);
}

/** The staff credential for an enterprise, for `staffVac`, or null (owners need none). */
export async function getStaffVac(enterpriseDid: string, subject?: string, dbName?: string): Promise<Credential | null> {
  return staffCredential(await walletCredentials(dbName), enterpriseDid, subject);
}
