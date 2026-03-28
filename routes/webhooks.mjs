import { Router } from 'express';
import { getStripe } from '../lib/stripe.mjs';
import { completePayment, failPayment } from '../lib/db.mjs';

const router = Router();

// Stripe webhook — must receive raw body (configured in server.mjs)
router.post('/api/webhooks/stripe', (req, res) => {
  const s = getStripe();
  if (!s) return res.status(503).send('Stripe not configured');

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret || webhookSecret === 'whsec_placeholder') {
    return res.status(503).send('Webhook secret not configured');
  }

  let event;
  try {
    event = s.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      completePayment(session.id, session.payment_intent);
      break;
    }
    case 'checkout.session.expired': {
      const session = event.data.object;
      failPayment(session.id);
      break;
    }
    default:
      break;
  }

  res.json({ received: true });
});

export default router;
