import { posService } from '@/lib/gatewayDeps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const { GET, POST, PUT, DELETE } = posService;
