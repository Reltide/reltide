import type Stripe from 'stripe';

export function latestChargeId(
  intent: Pick<Stripe.PaymentIntent, 'latest_charge'>,
): string | null {
  const charge = intent.latest_charge;
  return typeof charge === 'string' ? charge : charge?.id ?? null;
}
