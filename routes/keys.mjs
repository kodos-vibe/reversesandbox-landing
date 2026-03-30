import { Router } from 'express';
import { requireAuth } from '../middleware/auth.mjs';
import { getUserByAuth0Sub, generateApiKey, listApiKeys, revokeApiKey } from '../lib/db.mjs';

const router = Router();

// Generate new API key
router.post('/api/keys', requireAuth, (req, res) => {
  const { sub } = req.oidc.user;
  const dbUser = getUserByAuth0Sub(sub);
  if (!dbUser) return res.status(404).json({ error: 'User not found' });

  const name = (req.body.name || 'Default').slice(0, 64).replace(/[<>&"']/g, '');

  // Limit to 5 active keys per user
  const existing = listApiKeys(dbUser.id);
  const activeCount = existing.filter(k => k.status === 'active').length;
  if (activeCount >= 5) {
    return res.status(400).json({ error: 'Maximum 5 active API keys allowed. Revoke an existing key first.' });
  }

  const result = generateApiKey(dbUser.id, name);
  res.json({ key: result.key, prefix: result.prefix, name: result.name });
});

// List API keys
router.get('/api/keys', requireAuth, (req, res) => {
  const { sub } = req.oidc.user;
  const dbUser = getUserByAuth0Sub(sub);
  if (!dbUser) return res.status(404).json({ error: 'User not found' });

  const keys = listApiKeys(dbUser.id);
  res.json({ keys });
});

// Revoke API key
router.delete('/api/keys/:id', requireAuth, (req, res) => {
  const { sub } = req.oidc.user;
  const dbUser = getUserByAuth0Sub(sub);
  if (!dbUser) return res.status(404).json({ error: 'User not found' });

  const keyId = parseInt(req.params.id);
  if (!keyId) return res.status(400).json({ error: 'Invalid key ID' });

  const result = revokeApiKey(dbUser.id, keyId);
  if (!result) return res.status(404).json({ error: 'Key not found' });

  res.json({ key: result });
});

export default router;
