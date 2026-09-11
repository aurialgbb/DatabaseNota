import { dispatchJobs } from '@/lib/dispatch';
import { validDispatchAuthorization } from '@/lib/dispatch-auth';
import { publicError } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!validDispatchAuthorization(request.headers.get('authorization'), process.env.CRON_SECRET)) {
    return Response.json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Akses ditolak.' } }, { status: 401 });
  }
  try {
    return Response.json({ ok: true, result: await dispatchJobs() });
  } catch (error) {
    const safe = publicError(error);
    return Response.json({ ok: false, error: { code: safe.code, message: safe.message } }, { status: safe.status });
  }
}
