/**
 * `smokeRecord` — a throwaway round-trip used by `services/control-plane`'s
 * `verifyPod` (MVP plan §5 Task 9) to prove the AppView is wired up for a
 * freshly provisioned pod: write a `place` record, read it back, delete it,
 * and throw on any mismatch at any step. `helpers` (`{ signer, resolver }`
 * from the control plane) isn't needed for this check — the AppView doesn't
 * sign anything or resolve DIDs — so it's accepted but unused, purely to
 * match the call site's shape.
 */
import { ServiceError, type PodContext, type SessionClaims } from './kit.js';
import { generateTid } from './tid.js';
import { getRecord, putRecord, deleteRecord } from './records.js';

export async function smokeRecord(
  ctx: PodContext,
  helpers?: unknown,
): Promise<{ ok: true; detail: string }> {
  void helpers;

  const rkey = `smoke-${generateTid(ctx.now)}`;
  const placeId = `smoke:${rkey}`;
  const session: SessionClaims = { subject: ctx.podDid, pod: ctx.slug, tier: 'T4', authorities: [] };

  const written = await putRecord(ctx, 'place', rkey, { placeId, name: 'AppView smoke-test place' }, session);
  if (written.rkey !== rkey || written.authorDid !== ctx.podDid) {
    throw new ServiceError(
      500,
      'SMOKE_WRITE_MISMATCH',
      'AppView smoke test: the written record did not match what was sent.',
    );
  }

  const read = await getRecord(ctx, 'place', rkey);
  if (!read || read.uri !== written.uri || read.record.placeId !== placeId) {
    throw new ServiceError(
      500,
      'SMOKE_READ_MISMATCH',
      'AppView smoke test: could not read back the record it just wrote.',
    );
  }

  await deleteRecord(ctx, 'place', rkey, session);
  const goneCheck = await getRecord(ctx, 'place', rkey);
  if (goneCheck !== null) {
    throw new ServiceError(
      500,
      'SMOKE_DELETE_MISMATCH',
      'AppView smoke test: the record was still readable after delete.',
    );
  }

  return { ok: true, detail: `wrote, read, and deleted ${written.uri}` };
}
