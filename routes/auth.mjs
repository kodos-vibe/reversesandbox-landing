import { Router } from 'express';
import { findOrCreateUser, getUserByAuth0Sub } from '../lib/db.mjs';
import { requireAuth } from '../middleware/auth.mjs';

const router = Router();

router.get('/auth/sync', (req, res) => {
  if (!req.oidc || !req.oidc.isAuthenticated()) {
    return res.redirect('/');
  }
  const { sub, email, name } = req.oidc.user;
  findOrCreateUser(sub, email || '', name || email || '');
  res.redirect('/dashboard');
});

// Current user info
router.get('/api/me', (req, res) => {
  if (!req.oidc || !req.oidc.isAuthenticated()) {
    return res.status(401).json({ authenticated: false });
  }
  const { sub, email, name, picture } = req.oidc.user;
  const dbUser = getUserByAuth0Sub(sub);
  if (!dbUser) {
    return res.status(401).json({ authenticated: false });
  }
  res.json({
    authenticated: true,
    user: {
      id: dbUser.id,
      email: dbUser.email,
      name: dbUser.name || name || email,
      picture: picture || null,
      balance: dbUser.balance,
      created_at: dbUser.created_at,
      last_login_at: dbUser.last_login_at,
    },
  });
});

export default router;
