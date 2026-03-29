/**
 * Payment Signing API Routes
 *
 * POST /api/pay     — Sign a payment via 7clave custody and return x402 header
 * GET  /api/balance — Check user balance
 * GET  /api/usage   — Recent usage history
 */

import { Router } from 'express';
import { apiKeyAuth } from '../middleware/apiKeyAuth.mjs';
import { deductBalance, logUsage, getUsage, getUserById } from '../lib/db.mjs';
import { signPayment, buildX402PaymentHeader, init as initCustody } from '../lib/custody.mjs';

const router = Router();

// All routes require API key auth
router.use('/api/pay', apiKeyAuth);
router.use('/api/balance', apiKeyAuth);
router.use('/api/usage', apiKeyAuth);

// ── POST /api/pay ────────────────────────────────────────────────────

router.post('/api/pay', async (req, res) => {
  // Check custody is configured
  if (!initCustody()) {
    return res.status(503).json({ error: 'Payment signing not configured' });
  }

  const { to, amount, network = 'base', token = 'USDC', valid_seconds = 300 } = req.body || {};

  if (!to || !amount) {
    return res.status(400).json({ error: 'Missing required fields: to, amount' });
  }

  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) {
    return res.status(400).json({ error: 'Invalid recipient address' });
  }

  const parsedAmount = parseFloat(amount);
  if (!isFinite(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ error: 'Amount must be a positive number' });
  }

  // Balance check: user must have at least 1 cent
  const user = getUserById(req.apiUser.id);
  if (!user || user.balance <= 0) {
    return res.status(402).json({ error: 'Insufficient balance. Please add funds.' });
  }

  // Cost: at least 1 cent per call (MVP — sub-cent x402 prices round up)
  const costCents = Math.max(1, Math.round(parsedAmount * 100));

  if (user.balance < costCents) {
    return res.status(402).json({
      error: 'Insufficient balance',
      required_cents: costCents,
      balance_cents: user.balance,
    });
  }

  try {
    const signResult = await signPayment({
      to,
      amount: String(amount),
      network,
      token,
      validSeconds: valid_seconds,
    });

    const paymentHeader = buildX402PaymentHeader(signResult);

    // Deduct cost and log usage
    deductBalance(req.apiUser.id, costCents);
    logUsage(req.apiUser.id, req.apiKeyId, {
      service: 'x402_pay',
      paymentTo: to,
      amountUsd: String(amount),
      costMicrocents: costCents * 10000,
      network,
      token,
    });

    const updatedUser = getUserById(req.apiUser.id);

    res.json({
      payment_header: paymentHeader,
      cost_usd: `$${(costCents / 100).toFixed(2)}`,
      remaining_balance: `$${(updatedUser.balance / 100).toFixed(2)}`,
      remaining_balance_cents: updatedUser.balance,
    });
  } catch (err) {
    console.error('[pay] signing error:', err.message);
    res.status(500).json({ error: 'Payment signing failed', details: err.message });
  }
});

// ── GET /api/balance ─────────────────────────────────────────────────

router.get('/api/balance', (req, res) => {
  const user = getUserById(req.apiUser.id);
  res.json({
    balance: `$${(user.balance / 100).toFixed(2)}`,
    balance_cents: user.balance,
  });
});

// ── GET /api/usage ───────────────────────────────────────────────────

router.get('/api/usage', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const usage = getUsage(req.apiUser.id, limit);
  res.json({ usage });
});

export default router;
