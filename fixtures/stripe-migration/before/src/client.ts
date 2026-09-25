import Stripe from 'stripe';

// The target scenario starts with the 2022-08-01 API response shape.
export function createStripeClient(apiKey: string): Stripe {
  return new Stripe(apiKey, { apiVersion: '2022-08-01' });
}
