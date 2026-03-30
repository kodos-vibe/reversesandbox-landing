import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import { auth } from 'express-openid-connect';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, statSync } from 'fs';

import { getDb } from './lib/db.mjs';
import authRoutes from './routes/auth.mjs';
import apiRoutes from './routes/api.mjs';
import keyRoutes from './routes/keys.mjs';
import payRoutes from './routes/pay.mjs';
import webhookRoutes from './routes/webhooks.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT) || 4025;
const HOST = process.env.HOST || '127.0.0.1';

const app = express();

// Trust Cloudflare proxy (needed for secure cookies + OIDC state)
app.set("trust proxy", 1);

// Initialize database on startup
getDb();

// Security headers — allow inline styles/scripts for our pages, google fonts
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "https:", "data:"],
      connectSrc: ["'self'"],
    },
  },
}));

// Stripe webhook needs raw body — mount BEFORE json parser
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }));
app.use(webhookRoutes);

// JSON body parser for all other routes
app.use(express.json());

// Auth0 configuration — graceful degradation if not configured
const auth0Configured = process.env.AUTH0_CLIENT_ID
  && process.env.AUTH0_CLIENT_ID !== 'your-client-id'
  && process.env.AUTH0_DOMAIN
  && process.env.AUTH0_DOMAIN !== 'your-tenant.us.auth0.com';

if (auth0Configured) {
  app.use(auth({
    authRequired: false,
    auth0Logout: true,
    baseURL: process.env.AUTH0_BASE_URL || `http://${HOST}:${PORT}`,
    clientID: process.env.AUTH0_CLIENT_ID,
    clientSecret: process.env.AUTH0_CLIENT_SECRET,
    issuerBaseURL: `https://${process.env.AUTH0_DOMAIN}`,
    secret: (() => {
      const sessionSecret = process.env.SESSION_SECRET;
      if (!sessionSecret) {
        console.error('FATAL: SESSION_SECRET must be set');
        process.exit(1);
      }
      return sessionSecret;
    })(),
    routes: {
      callback: '/callback',
      logout: '/logout',
      login: '/login',
    },
    // Controls the OIDC state's returnTo — this is what the library actually
    // uses for the post-callback redirect (NOT session.returnTo).
    getLoginState: (_req, _options) => {
      return { returnTo: '/auth/sync' };
    },
    session: {
      rollingDuration: 86400,
      cookie: { secure: true, sameSite: 'Lax' },
    },
    transactionCookie: {
      sameSite: 'Lax',
    },
  }));
  // Auth routes (sync, /api/me)
  app.use(authRoutes);
} else {
  console.warn('Auth0 not configured — auth features disabled. Set AUTH0_DOMAIN, AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET in .env');
  // Provide stub /api/me so the frontend doesn't break
  app.get('/api/me', (_req, res) => res.json({ authenticated: false }));
  app.get('/login', (_req, res) => res.redirect('/?auth=not-configured'));
  app.get('/logout', (_req, res) => res.redirect('https://www.reversesandbox.com'));
  app.get('/auth/sync', (_req, res) => res.redirect('/'));
}

// API routes
app.use(apiRoutes);
app.use(keyRoutes);
app.use(payRoutes);

// Home page
app.get('/', (_req, res) => res.redirect('https://www.reversesandbox.com'));

// Dashboard — require auth if configured, otherwise show page anyway
app.get('/dashboard', (req, res, next) => {
  if (auth0Configured && (!req.oidc || !req.oidc.isAuthenticated())) {
    return res.redirect('/login');
  }
  next();
}, (_req, res) => {
  res.sendFile(join(__dirname, 'public', 'dashboard.html'));
});

// Guide page — public, no auth required
app.get('/guide', (_req, res) => res.sendFile(join(__dirname, 'public', 'guide.html')));

// Clean URL routes for policy pages
app.get('/terms', (_req, res) => res.sendFile(join(__dirname, 'public', 'terms.html')));
app.get('/privacy', (_req, res) => res.sendFile(join(__dirname, 'public', 'privacy.html')));
app.get('/refund', (_req, res) => res.sendFile(join(__dirname, 'public', 'refund.html')));

// Static file serving with security checks (from old serve.mjs)
app.use((req, res, next) => {
  const pathname = req.path;

  // Block dotfiles
  if (pathname.split('/').some(seg => seg.startsWith('.'))) {
    return res.status(403).end('Forbidden');
  }

  // Block sensitive paths
  const blocked = ['/server.mjs', '/serve.mjs', '/package.json', '/package-lock.json', '/.env'];
  if (blocked.includes(pathname) || pathname.startsWith('/db/') || pathname.startsWith('/lib/')
      || pathname.startsWith('/routes/') || pathname.startsWith('/middleware/')
      || pathname.startsWith('/node_modules/')) {
    return res.status(403).end('Forbidden');
  }

  const filePath = join(__dirname, 'public', pathname);

  // Prevent path traversal
  if (!filePath.startsWith(join(__dirname, 'public'))) {
    return res.status(403).end('Forbidden');
  }

  if (existsSync(filePath) && statSync(filePath).isFile()) {
    return res.sendFile(filePath);
  }

  next();
});

// Fallback — serve index.html for unmatched routes (SPA-like)
app.use((_req, res) => {
  res.redirect('https://www.reversesandbox.com');
});

app.listen(PORT, HOST, () => {
  console.log(`ReverseSandbox server running on http://${HOST}:${PORT}`);
  if (!auth0Configured) console.log('  Auth0: NOT CONFIGURED (stub mode)');
  if (!process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY === 'sk_test_placeholder') {
    console.log('  Stripe: NOT CONFIGURED (payments disabled)');
  }
});
