import { generateKeyPair } from '@passport/credential-core';
import { num } from '@passport/pos-adapter';
import { getAccount, openAccount, settle } from './ledger.js';
import type { GatewayContext } from './util.js';

/**
 * Control-plane `verifyPod` smoke (Task 9 hook): opens two throwaway member accounts, transfers 1 credit through
 * `settle`, asserts +1 / −1, then deletes the smoke entry and accounts so the pod's ledger is unchanged.
 * `helpers` (pod signer + resolver) are accepted for the hook signature but not needed.
 */
export async function smokeTransfer(ctx: GatewayContext, _helpers?: unknown): Promise<{ ok: true; detail: string }> {
  const from = generateKeyPair().did;
  const to = generateKeyPair().did;
  const invoice = `smoke_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  let entryId: string | undefined;
  try {
    await openAccount(ctx, { did: from, kind: 'member', band: 'L1', limit: ctx.manifest.currency.limits.L1 });
    await openAccount(ctx, { did: to, kind: 'member', band: 'L1', limit: ctx.manifest.currency.limits.L1 });
    const r = await settle(ctx, { from, to, amount: 1, invoice });
    entryId = r.entryId;
    const a = await getAccount(ctx, from);
    const b = await getAccount(ctx, to);
    if (num(a?.balance) !== -1 || num(b?.balance) !== 1) {
      throw new Error(`Smoke transfer left balances ${num(a?.balance)} / ${num(b?.balance)} instead of -1 / 1.`);
    }
    return { ok: true, detail: `Transferred 1 ${ctx.manifest.currency.unit} between two throwaway accounts (entry ${r.entryId}); balances -1 / +1.` };
  } finally {
    if (entryId) await ctx.db.query('DELETE FROM ledger_entries WHERE id = $1', [entryId]);
    else await ctx.db.query('DELETE FROM ledger_entries WHERE invoice = $1', [invoice]);
    await ctx.db.query('DELETE FROM accounts WHERE did = ANY($1::text[])', [[from, to]]);
  }
}
