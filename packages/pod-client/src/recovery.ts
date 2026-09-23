import { combineShares, createBackup, fromBase64url, keyPairFromSeed, openBackup, splitSecret, toBase64url, type DidScope } from '@passport/credential-core';
import type { ContactRow, CredentialRow, EventRow, IdentifierRow, PodRow, SettingRow } from './db.js';
import { utf8 } from './util.js';
import type { Wallet } from './wallet.js';

export const BACKUP_FORMAT = 'bioregional-passport-backup';
export const SHARE_PREFIX = 'passport-share-v1.';
const BACKUP_AT = 'wallet.backupAt';
const SHARES_AT = 'wallet.sharesAt';

const td = new TextDecoder();

interface Snapshot {
  v: 1;
  exportedAt: string;
  identifiers: (Omit<IdentifierRow, 'seed'> & { seed: string })[];
  credentials: CredentialRow[];
  pods: PodRow[];
  contacts: ContactRow[];
  events: EventRow[];
  settings: SettingRow[];
}

/** Settings that describe this device, not the passport. */
const LOCAL_SETTINGS = new Set([BACKUP_AT, SHARES_AT]);

async function snapshot(wallet: Wallet): Promise<Snapshot> {
  const db = wallet.db;
  return {
    v: 1,
    exportedAt: wallet.now().toISOString(),
    identifiers: (await db.identifiers.toArray()).map((r) => ({ ...r, seed: toBase64url(new Uint8Array(r.seed)) })),
    credentials: await db.credentials.toArray(),
    pods: await db.pods.toArray(),
    contacts: await db.contacts.toArray(),
    events: await db.events.toArray(),
    settings: (await db.settings.toArray()).filter((s) => !LOCAL_SETTINGS.has(s.key)),
  };
}

/**
 * Encrypted backup of the whole passport (keys, credentials, pods, contacts, events): credential-core
 * `createBackup` (PBKDF2 210k → AES-256-GCM) over the JSON. Returns the text of the file to download.
 */
export async function exportBackup(wallet: Wallet, passphrase: string): Promise<{ filename: string; text: string }> {
  if (passphrase.length < 8) throw new Error('Choose a passphrase of at least 8 characters.');
  const snap = await snapshot(wallet);
  const { ciphertext } = await createBackup(utf8(JSON.stringify(snap)), passphrase);
  const at = snap.exportedAt;
  await wallet.setSetting(BACKUP_AT, at);
  const text = JSON.stringify({ format: BACKUP_FORMAT, v: 1, createdAt: at, ciphertext }, null, 2);
  return { filename: `passport-backup-${at.slice(0, 10)}.json`, text };
}

/** Restores a backup file into this wallet (merging with anything already here). */
export async function importBackup(wallet: Wallet, file: string | Blob, passphrase: string): Promise<{ identifiers: number; credentials: number; pods: number }> {
  const text = typeof file === 'string' ? file : await file.text();
  let env: { format?: unknown; ciphertext?: unknown };
  try {
    env = JSON.parse(text);
  } catch {
    throw new Error('This file is not a passport backup.');
  }
  if (env.format !== BACKUP_FORMAT || typeof env.ciphertext !== 'string') throw new Error('This file is not a passport backup.');
  const plain = await openBackup(env.ciphertext, passphrase);
  const snap = JSON.parse(td.decode(plain)) as Snapshot;
  if (snap.v !== 1) throw new Error('This backup was made by a newer version of the passport.');
  const db = wallet.db;
  await db.transaction('rw', [db.identifiers, db.credentials, db.pods, db.contacts, db.events, db.settings], async () => {
    await db.identifiers.bulkPut(snap.identifiers.map((r) => ({ ...r, seed: fromBase64url(r.seed) })));
    await db.credentials.bulkPut(snap.credentials);
    await db.pods.bulkPut(snap.pods);
    await db.contacts.bulkPut(snap.contacts);
    await db.events.bulkPut(snap.events);
    await db.settings.bulkPut(snap.settings);
  });
  return { identifiers: snap.identifiers.length, credentials: snap.credentials.length, pods: snap.pods.length };
}

type BundleEntry = [scope: DidScope, pod: string, counterparty: string, seed: string, createdAt: string];

/**
 * Social recovery kit: 2-of-3 Shamir shares (credential-core `splitSecret`) over the bundle of every identifier's
 * seed. Returns three text shares to hand to three different people; any two restore the keys.
 * Credentials are not in the shares (they would make them too long to hand over); they come back from the
 * passphrase backup, and VACs are re-issued by `refresh` once signed in.
 */
export async function createShares(wallet: Wallet): Promise<string[]> {
  const ids = await wallet.db.identifiers.toArray();
  if (!ids.length) throw new Error('This passport holds no keys yet.');
  const root = await wallet.rootDid();
  const bundle = {
    v: 1,
    root: root ?? null,
    ids: ids.map((r): BundleEntry => [r.scope, r.pod ?? '', r.counterparty ?? '', toBase64url(new Uint8Array(r.seed)), r.createdAt]),
  };
  const shares = splitSecret(utf8(JSON.stringify(bundle)), 2, 3);
  await wallet.setSetting(SHARES_AT, wallet.now().toISOString());
  return shares.map((s) => SHARE_PREFIX + toBase64url(s));
}

/** Restores the identifiers from any two shares. */
export async function recoverFromShares(wallet: Wallet, shares: string[]): Promise<{ restored: number; rootDid?: string }> {
  const parts = shares.map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) throw new Error('Two recovery shares are needed.');
  let bytes: Uint8Array;
  try {
    bytes = combineShares(parts.map((s) => {
      if (!s.startsWith(SHARE_PREFIX)) throw new Error();
      return fromBase64url(s.slice(SHARE_PREFIX.length));
    }));
  } catch {
    throw new Error('These are not two different shares of the same passport.');
  }
  let bundle: { v: number; root: string | null; ids: BundleEntry[] };
  try {
    bundle = JSON.parse(td.decode(bytes));
  } catch {
    throw new Error('These shares do not belong together.');
  }
  const rows: IdentifierRow[] = bundle.ids.map(([scope, pod, counterparty, seed, createdAt]) => {
    const s = fromBase64url(seed);
    const row: IdentifierRow = { did: keyPairFromSeed(s).did, scope, seed: s, createdAt };
    if (pod) row.pod = pod;
    if (counterparty) row.counterparty = counterparty;
    return row;
  });
  await wallet.db.identifiers.bulkPut(rows);
  if (bundle.root) {
    await wallet.setSetting('wallet.root', bundle.root);
    if (!(await wallet.exists())) await wallet.setSetting('wallet.createdAt', wallet.now().toISOString());
  }
  return { restored: rows.length, ...(bundle.root ? { rootDid: bundle.root } : {}) };
}

/** Whether the recovery kit covers every key: identifiers minted after the last backup / shares are not in them. */
export async function recoveryStatus(wallet: Wallet): Promise<{ backupAt?: string; sharesAt?: string; newKeysSinceBackup: number; newKeysSinceShares: number }> {
  const backupAt = await wallet.setting<string>(BACKUP_AT);
  const sharesAt = await wallet.setting<string>(SHARES_AT);
  const ids = await wallet.db.identifiers.toArray();
  const since = (t?: string) => ids.filter((r) => !t || r.createdAt > t).length;
  return { ...(backupAt ? { backupAt } : {}), ...(sharesAt ? { sharesAt } : {}), newKeysSinceBackup: since(backupAt), newKeysSinceShares: since(sharesAt) };
}

/** Every credential as plain JSON (no keys). */
export async function exportCredentialsJson(wallet: Wallet): Promise<{ filename: string; text: string }> {
  const creds = await wallet.credentials();
  const text = JSON.stringify({ exportedAt: wallet.now().toISOString(), credentials: creds.map((c) => ({ pod: c.pod ?? null, digest: c.digest, credential: c.raw })) }, null, 2);
  return { filename: `passport-credentials-${wallet.now().toISOString().slice(0, 10)}.json`, text };
}
