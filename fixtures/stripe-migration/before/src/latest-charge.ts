import type Stripe from 'stripe';

export function latestChargeId(
  intent: Pick<Stripe.PaymentIntent, 'charges'>,
): string | null {
  return intent.charges?.data[0]?.id ?? null;
}
