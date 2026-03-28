import { Router } from 'express';
import { requireAuth } from '../middleware/auth.mjs';
import { getUserByAuth0Sub, getActivity, createPayment } from '../lib/db.mjs';
import { createCheckoutSession, getStripe } from '../lib/stripe.mjs';

const router = Router();

// Activity feed
router.get('/api/activity', requireAuth, (req, res) => {
  const { sub } = req.oidc.user;
  const dbUser = getUserByAuth0Sub(sub);
  if (!dbUser) return res.status(404).json({ error: 'User not found' });

  const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  const activity = getActivity(dbUser.id, limit, offset);
  res.json({ activity });
});

// Create Stripe Checkout session
router.post('/api/checkout', requireAuth, async (req, res) => {
  try {
    const { sub } = req.oidc.user;
    const dbUser = getUserByAuth0Sub(sub);
    if (!dbUser) return res.status(404).json({ error: 'User not found' });

    const amount = parseInt(req.body.amount);
    if (!amount || amount < 100 || amount > 50000) {
      return res.status(400).json({ error: 'Amount must be between $1.00 and $500.00 (100-50000 cents)' });
    }

    const baseUrl = process.env.AUTH0_BASE_URL || `http://localhost:${process.env.PORT || 4025}`;
    const session = await createCheckoutSession(dbUser.id, amount, baseUrl);
    createPayment(dbUser.id, session.id, amount);
    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err.message);
    if (err.message === 'Stripe is not configured') {
      return res.status(503).json({ error: 'Payments are not configured yet' });
    }
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// Post-payment success redirect
router.get('/api/checkout/success', requireAuth, (req, res) => {
  res.redirect('/dashboard?payment=success');
});

// Cancelled payment redirect
router.get('/api/checkout/cancel', requireAuth, (req, res) => {
  res.redirect('/dashboard?payment=cancelled');
});

export default router;
