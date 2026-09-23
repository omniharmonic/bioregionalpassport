/**
 * `POST /api/control/pods/:slug/bootstrap-steward` — operator-only (Bearer `OPERATOR_TOKEN`) first-steward
 * bootstrap with a membership grant; see `../../../_lib/bootstrapSteward.ts`.
 */
import { bootstrapStewardService } from '../../../_lib/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const { GET, POST } = bootstrapStewardService;
