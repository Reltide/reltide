import Stripe from 'stripe';

export const PINNED_API_VERSION = '2022-08-01' as const;

export function createPinnedClient(apiKey: string): Stripe {
  // @ts-expect-error stripe-node 12 types describe its 2022-11-15 default.
  // Stripe documents older runtime pins as supported, with a type suppression.
  return new Stripe(apiKey, { apiVersion: PINNED_API_VERSION });
}

// The explicit old API pin preserves this legacy response shape. A narrow local
// type reflects that shape because stripe-node 12 types only model 2022-11-15.
export function latestChargeIdForPinnedVersion(intent: {
  charges?: { data: Array<{ id: string }> };
}): string | null {
  return intent.charges?.data[0]?.id ?? null;
}
