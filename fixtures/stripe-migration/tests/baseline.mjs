import assert from 'node:assert/strict';
import { createStripeClient } from '../before/src/client.ts';
import { latestChargeId } from '../before/src/latest-charge.ts';

assert.equal(
  createStripeClient('fixture_not_a_secret').getApiField('version'),
  '2022-08-01',
);
assert.equal(
  latestChargeId({ charges: { data: [{ id: 'ch_legacy_001' }] } }),
  'ch_legacy_001',
);
assert.equal(latestChargeId({ charges: { data: [] } }), null);
console.log('Old API baseline passed: charges.data[0].id is read.');
