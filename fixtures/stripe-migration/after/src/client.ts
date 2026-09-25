import Stripe from 'stripe';

// The migration opts into the API version that removed PaymentIntent.charges.
export function createStripeClient(apiKey: string): Stripe {
  return new Stripe(apiKey, { apiVersion: '2022-11-15' });
}
