import assert from 'node:assert/strict';
import test from 'node:test';
import { validDispatchAuthorization } from '../lib/dispatch-auth';

test('Penjadwal hanya menerima bearer secret yang dikonfigurasi', () => {
  const secret = 'a'.repeat(43);
  assert.equal(validDispatchAuthorization(`Bearer ${secret}`, secret), true);
  for (const header of [null, '', 'Bearer undefined', `Bearer ${'b'.repeat(43)}`, `${secret}`, `Bearer ${secret}extra`]) {
    assert.equal(validDispatchAuthorization(header, secret), false);
  }
  assert.equal(validDispatchAuthorization('Bearer undefined', undefined), false);
  assert.equal(validDispatchAuthorization('Bearer ', ''), false);
  assert.equal(validDispatchAuthorization('Bearer short', 'short'), false);
});
