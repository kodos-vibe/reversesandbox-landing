/**
 * Payment Signing API Routes
 *
 * POST /api/pay     — Sign a payment via 7clave custody and return x402 header
 * GET  /api/balance — Check user balance
 * GET  /api/usage   — Recent usage history
 */

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { apiKeyAuth } from '../middleware/apiKeyAuth.mjs';
import { atomicDeduct, addBalance, logUsage, getUsage, getUserById } from '../lib/db.mjs';
import { signPayment, buildX402PaymentHeader, init as initCustody } from '../lib/custody.mjs';

const router = Router();

const payLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.apiKeyId || req.ip,
  message: { error: 'Rate limit exceeded. Max 10 payments per minute.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// All routes require API key auth
router.use('/api/pay', apiKeyAuth);
router.use('/api/balance', apiKeyAuth);
router.use('/api/usage', apiKeyAuth);

// ── POST /api/pay ────────────────────────────────────────────────────

router.post('/api/pay', payLimiter, async (req, res) => {
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

  if (parsedAmount > 100) {
    return res.status(400).json({ error: 'Amount exceeds maximum ($100)' });
  }

  // Cost: at least 1 cent per call (MVP — sub-cent x402 prices round up)
  const costCents = Math.max(1, Math.round(parsedAmount * 100));

  // Atomic deduct (prevents race condition)
  if (!atomicDeduct(req.apiUser.id, costCents)) {
    const user = getUserById(req.apiUser.id);
    return res.status(402).json({
      error: 'Insufficient balance',
      required_cents: costCents,
      balance_cents: user ? user.balance : 0,
    });
  }

  try {
    // Fetch the x402 payment requirements from our gateway
    let acceptedRequirements = null;
    try {
      const gatewayUrl = process.env.X402_GATEWAY_URL || "http://127.0.0.1:4021";
      const probeRes = await fetch(gatewayUrl + "/web/search?q=probe");
      if (probeRes.status === 402) {
        const payReqHeader = probeRes.headers.get("payment-required");
        if (payReqHeader) {
          const payReq = JSON.parse(Buffer.from(payReqHeader, "base64").toString());
          // Find matching network from accepts
          const networkMap = { base: "eip155:8453", polygon: "eip155:137", arbitrum: "eip155:42161", sepolia: "eip155:11155111" };
          const caipNetwork = networkMap[network] || network;
          acceptedRequirements = payReq.accepts?.find(a => a.network === caipNetwork);
          if (!acceptedRequirements) {
            // Fallback: use first EVM accept
            acceptedRequirements = payReq.accepts?.find(a => a.network?.startsWith("eip155:"));
          }
        }
      }
    } catch (probeErr) {
      console.warn("[pay] Failed to probe gateway for requirements:", probeErr.message);
    }

    const signResult = await signPayment({
      to,
      amount: String(amount),
      network,
      token,
      validSeconds: valid_seconds,
    });

    const paymentHeader = buildX402PaymentHeader(signResult, acceptedRequirements);

    // Log usage (balance already deducted atomically above)
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
    // Refund on failure
    addBalance(req.apiUser.id, costCents);
    console.error('[pay] signing error:', err);
    res.status(500).json({ error: 'Payment signing failed' });
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
