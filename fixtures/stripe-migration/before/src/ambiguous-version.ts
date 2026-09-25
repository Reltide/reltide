import Stripe from 'stripe';

// No account default API version is recorded for this separate case.
// Its response shape cannot be inferred solely from this constructor.
export function createAmbiguousClient(apiKey: string): Stripe {
  // @ts-expect-error The old SDK requires a version in its types although its
  // runtime supports an unversioned constructor and uses the account default.
  return new Stripe(apiKey);
}

export function latestChargeIdWithUnknownVersion(intent: {
  charges?: { data: Array<{ id: string }> };
}): string | null {
  return intent.charges?.data[0]?.id ?? null;
}
