/**
 * API Key Authentication Middleware
 *
 * Extracts Bearer token from Authorization header, validates via lookupApiKey,
 * and attaches user info to req.apiUser / req.apiKeyId.
 */

import { lookupApiKey } from '../lib/db.mjs';

export function apiKeyAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header. Use: Bearer <api_key>' });
  }

  const token = authHeader.slice(7);
  if (!token || !token.startsWith('rs_')) {
    return res.status(401).json({ error: 'Invalid API key format' });
  }

  const keyRow = lookupApiKey(token);
  if (!keyRow) {
    return res.status(401).json({ error: 'Invalid or revoked API key' });
  }

  req.apiUser = {
    id: keyRow.user_id,
    email: keyRow.email,
    name: keyRow.user_name,
    balance: keyRow.balance,
  };
  req.apiKeyId = keyRow.id;

  next();
}
