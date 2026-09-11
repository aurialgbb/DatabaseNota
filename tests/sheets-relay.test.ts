import test from 'node:test';
import assert from 'node:assert/strict';
import relay from '../ops/cloudflare/sheets-relay.mjs';

test('Sheets relay menolak akses anonim dan hanya meneruskan endpoint yang diperlukan', async () => {
  const env = { RELAY_SECRET:'test-only-secret' };
  const original = globalThis.fetch;
  let tokenCalls = 0, sheetsCalls = 0;
  try {
    globalThis.fetch = async (input:any, init:any) => {
      const url = String(input);
      if (url === 'https://oauth2.googleapis.com/token') {
        tokenCalls++;
        assert.equal(init.headers['content-type'], 'application/x-www-form-urlencoded');
        assert.match(new TextDecoder().decode(init.body), /assertion=signed-test-proof/);
        return Response.json({ access_token:'google-test-token-value', expires_in:300 });
      }
      sheetsCalls++;
      assert.equal(url, 'https://sheets.googleapis.com/v4/spreadsheets/' + 'a'.repeat(24) + '?fields=spreadsheetId');
      assert.equal(init.headers.authorization, 'Bearer google-test-token-value');
      return Response.json({ spreadsheetId:'a'.repeat(24) });
    };
    const make = (auth:string, path = '/v4/spreadsheets/' + 'a'.repeat(24) + '?fields=spreadsheetId') => new Request('https://relay.invalid' + path, { headers:{ authorization:auth, 'x-google-authorization':'Bearer google-test-token-value' } });
    assert.equal((await relay.fetch(make(''), env)).status, 401);
    assert.equal((await relay.fetch(make('Bearer test-only-secret', '/v4/files/anything'), env)).status, 404);
    assert.equal(tokenCalls, 0); assert.equal(sheetsCalls, 0);
    const oauth = await relay.fetch(new Request('https://relay.invalid/oauth/token', { method:'POST', headers:{ authorization:'Bearer test-only-secret', 'content-type':'application/x-www-form-urlencoded' }, body:'grant_type=test&assertion=signed-test-proof' }), env);
    assert.equal(oauth.status, 200);
    assert.equal(tokenCalls, 1); assert.equal(sheetsCalls, 0);
    const response = await relay.fetch(make('Bearer test-only-secret'), env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-nota-relay'), 'sheets');
    assert.equal(tokenCalls, 1); assert.equal(sheetsCalls, 1);
  } finally { globalThis.fetch = original; }
});
