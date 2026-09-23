/**
 * Grants round service mount (pod scope) under `/api/round` — framework-light so it is unit-testable.
 * `./runtime` supplies the real DID resolver and status lists.
 */
import { createRoundRoutes, type RoundDeps } from '@passport/round';
import { mountService, type DepsSource, type MountableRoute, type MountedService, type MountOptions } from '../../../../lib/mount';

export const ROUND_MOUNT: MountOptions = { base: '/api/round', scope: 'pod' };

/** Mounts `createRoundRoutes(deps)`; `mountDeps` defaults to the real runtime (see `lib/mount.ts`). */
export function mountRound(deps: RoundDeps, mountDeps?: DepsSource): MountedService {
  return mountService(createRoundRoutes(deps) as MountableRoute[], ROUND_MOUNT, mountDeps);
}
