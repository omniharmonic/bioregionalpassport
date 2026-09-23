import type { Db } from './types.js';

export interface PodListing {
  slug: string;
  did: string;
  status: string;
}

/** Lists provisioned pods from `platform.pods`, ordered by slug. */
export async function listPods(db: Db): Promise<PodListing[]> {
  return db.query<PodListing>('select slug, did, status from platform.pods order by slug');
}
