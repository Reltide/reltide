import assert from 'node:assert/strict';

const variant = process.argv[2];
if (variant !== 'before' && variant !== 'after') {
  throw new Error('Pass either before or after as the implementation variant.');
}

const { latestChargeId } = await import(`../${variant}/src/latest-charge.ts`);

assert.equal(latestChargeId({ latest_charge: 'ch_new_001' }), 'ch_new_001');
assert.equal(latestChargeId({ latest_charge: { id: 'ch_new_002' } }), 'ch_new_002');
assert.equal(latestChargeId({ latest_charge: null }), null);
console.log(`2022-11-15 regression passed for ${variant}.`);
