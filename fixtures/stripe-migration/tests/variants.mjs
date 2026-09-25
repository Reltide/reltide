import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createStripeClient } from '../after/src/client.ts';
import {
  createPinnedClient,
  latestChargeIdForPinnedVersion,
  PINNED_API_VERSION,
} from '../after/src/pinned-version.ts';
import { createAmbiguousClient } from '../before/src/ambiguous-version.ts';

const scenarios = JSON.parse(
  await readFile(new URL('../scenarios.json', import.meta.url), 'utf8'),
);

assert.equal(PINNED_API_VERSION, scenarios.pinnedVersion.explicitApiVersion);
assert.equal(
  createStripeClient('fixture_not_a_secret').getApiField('version'),
  scenarios.target.afterExplicitApiVersion,
);
assert.equal(
  createPinnedClient('fixture_not_a_secret').getApiField('version'),
  scenarios.pinnedVersion.explicitApiVersion,
);
assert.equal(
  latestChargeIdForPinnedVersion({ charges: { data: [{ id: 'ch_pinned_001' }] } }),
  'ch_pinned_001',
);
assert.equal(scenarios.ambiguousVersion.accountDefaultApiVersion, null);
assert.equal(
  createAmbiguousClient('fixture_not_a_secret').getApiField('version'),
  null,
);
assert.equal(
  scenarios.ambiguousVersion.expectedDisposition,
  'require version evidence before rewriting',
);
console.log('Pinned and ambiguous version controls passed.');
