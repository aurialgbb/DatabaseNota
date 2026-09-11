const jsonError = (status, message) => Response.json({ error:{ message } }, { status, headers:{ 'cache-control':'no-store' } });

async function sameSecret(given, wanted) {
  const digest = text => crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const [left, right] = await Promise.all([digest(given), digest(wanted)]);
  const a = new Uint8Array(left), b = new Uint8Array(right);
  let mismatch = 0;
  for (let index = 0; index < a.length; index++) mismatch |= a[index] ^ b[index];
  return mismatch === 0;
}

function allowedSheetsRequest(url, method) {
  if (!/^\/v4\/spreadsheets\/[A-Za-z0-9_-]{20,150}(?::batchUpdate|\/developerMetadata:search|\/values\/[^?#]{1,1200}(?::clear)?)?$/.test(url.pathname)) return false;
  if (url.pathname.endsWith(':batchUpdate') || url.pathname.endsWith('/developerMetadata:search') || url.pathname.endsWith(':clear')) return method === 'POST';
  if (url.pathname.includes('/values/')) return method === 'GET' || method === 'PUT';
  return method === 'GET';
}

async function forward(upstreamUrl, request, headers, body) {
  const response = await fetch(upstreamUrl, { method:request.method, headers, body, redirect:'manual', signal:AbortSignal.timeout(45000) });
  if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); return jsonError(502, 'Redirect penyedia ditolak.'); }
  return new Response(response.body, { status:response.status, headers:{ 'content-type':'application/json', 'cache-control':'no-store', 'x-nota-relay':'sheets', 'x-nota-colo':request.cf?.colo || 'unknown' } });
}

export default {
  async fetch(request, env) {
    if (!env.RELAY_SECRET) return jsonError(503, 'Relay Spreadsheet belum dikonfigurasi.');
    if (!await sameSecret(request.headers.get('authorization') || '', 'Bearer ' + env.RELAY_SECRET)) return jsonError(401, 'Unauthorized');
    const url = new URL(request.url), method = request.method.toUpperCase();
    try {
      if (url.pathname === '/oauth/token') {
        if (method !== 'POST' || url.search || !request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) return jsonError(404, 'Not found');
        const body = await request.arrayBuffer();
        if (!body.byteLength || body.byteLength > 20 * 1024) return jsonError(413, 'Ukuran permintaan tidak valid.');
        return forward('https://oauth2.googleapis.com/token', request, { 'content-type':'application/x-www-form-urlencoded' }, body);
      }
      if (!allowedSheetsRequest(url, method)) return jsonError(404, 'Not found');
      const googleAuthorization = request.headers.get('x-google-authorization') || '';
      if (!/^Bearer [A-Za-z0-9._~-]{20,4096}$/.test(googleAuthorization)) return jsonError(401, 'Token Google tidak valid.');
      let body;
      if (method !== 'GET') {
        if (!request.headers.get('content-type')?.startsWith('application/json')) return jsonError(415, 'Gunakan JSON.');
        body = await request.arrayBuffer();
        if (!body.byteLength || body.byteLength > 10 * 1024 * 1024) return jsonError(413, 'Ukuran permintaan tidak valid.');
      }
      return forward('https://sheets.googleapis.com' + url.pathname + url.search, request, { authorization:googleAuthorization, ...(body ? { 'content-type':'application/json' } : {}) }, body);
    } catch {
      return jsonError(502, 'Google Sheets belum merespons melalui relay.');
    }
  },
};
