import { controlService } from '@/lib/services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const { GET, POST, PUT, DELETE } = controlService;
