import Stripe from 'stripe';

let stripe;

export function getStripe() {
  if (!stripe) {
    if (!process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY === 'sk_test_placeholder') {
      return null;
    }
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return stripe;
}

export async function createCheckoutSession(userId, amountCents, baseUrl) {
  const s = getStripe();
  if (!s) throw new Error('Stripe is not configured');

  const amountDollars = (amountCents / 100).toFixed(2);
  const session = await s.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: {
          name: 'Account Credit',
          description: `Add $${amountDollars} to your ReverseSandbox account`,
        },
        unit_amount: amountCents,
      },
      quantity: 1,
    }],
    mode: 'payment',
    success_url: `${baseUrl}/api/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/api/checkout/cancel`,
    metadata: { user_id: String(userId) },
  });
  return session;
}
