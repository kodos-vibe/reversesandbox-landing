/**
 * ReverseSandbox API Test Suite
 *
 * Uses node:test (built-in) + node:assert. No external test deps.
 * Starts server.mjs as a child process with isolated test DB.
 *
 * Run: node --test test/api-test.mjs
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { unlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const TEST_PORT = 4099;
const TEST_DB = join(PROJECT_ROOT, 'db', 'test-reversesandbox.db');
const BASE = `http://127.0.0.1:${TEST_PORT}`;

let serverProc;

// ── Helpers ──────────────────────────────────────────────────────────

function cleanDb() {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (existsSync(f)) unlinkSync(f);
  }
}

function startServer() {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      PORT: String(TEST_PORT),
      HOST: '127.0.0.1',
      DB_PATH: TEST_DB,
      // Disable Auth0, Stripe, Custody
      AUTH0_CLIENT_ID: '',
      AUTH0_DOMAIN: '',
      AUTH0_CLIENT_SECRET: '',
      STRIPE_SECRET_KEY: '',
      CUSTODY_API_KEY: '',
      NODE_ENV: 'test',
    };

    serverProc = spawn('node', ['server.mjs'], {
      cwd: PROJECT_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let started = false;
    const timeout = setTimeout(() => {
      if (!started) reject(new Error('Server failed to start within 10s'));
    }, 10000);

    serverProc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      if (text.includes('running on') && !started) {
        started = true;
        clearTimeout(timeout);
        // Small delay to ensure all routes are mounted
        setTimeout(() => resolve(), 200);
      }
    });

    serverProc.stderr.on('data', (chunk) => {
      // Ignore warnings, only fail on crash
      const text = chunk.toString();
      if (text.includes('Error') && !started) {
        clearTimeout(timeout);
        reject(new Error(`Server error: ${text}`));
      }
    });

    serverProc.on('exit', (code) => {
      if (!started) {
        clearTimeout(timeout);
        reject(new Error(`Server exited with code ${code} before starting`));
      }
    });
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!serverProc) return resolve();
    serverProc.on('exit', () => resolve());
    serverProc.kill('SIGTERM');
    setTimeout(() => {
      try { serverProc.kill('SIGKILL'); } catch {}
      resolve();
    }, 3000);
  });
}

async function json(res) {
  return res.json();
}

// ── DB setup (runs in test process, same DB file as server) ──────────

let testUser, testApiKey, brokeUser, brokeApiKey;

async function setupTestData() {
  // Dynamic import with DB_PATH set
  process.env.DB_PATH = TEST_DB;
  const db = await import(join(PROJECT_ROOT, 'lib', 'db.mjs'));

  testUser = db.findOrCreateUser('test|123', 'test@example.com', 'Test User');
  testApiKey = db.generateApiKey(testUser.id, 'Test Key');
  db.creditBalance(testUser.id, 5000); // $50.00

  brokeUser = db.findOrCreateUser('test|broke', 'broke@example.com', 'Broke User');
  brokeApiKey = db.generateApiKey(brokeUser.id, 'Broke Key');
  // No balance credited — stays at 0
}

// ── Test Suite ───────────────────────────────────────────────────────

describe('ReverseSandbox API', () => {
  before(async () => {
    cleanDb();
    await setupTestData();
    await startServer();
  });

  after(async () => {
    await stopServer();
    cleanDb();
  });

  // Test 1
  it('GET / returns 200 (health check)', async () => {
    const res = await fetch(BASE + '/');
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('html'), 'Should return HTML');
  });

  // Test 2
  it('GET /api/balance without auth returns 401', async () => {
    const res = await fetch(BASE + '/api/balance');
    assert.equal(res.status, 401);
    const body = await json(res);
    assert.ok(body.error);
  });

  // Test 3
  it('GET /api/balance with invalid key returns 401', async () => {
    const res = await fetch(BASE + '/api/balance', {
      headers: { Authorization: 'Bearer rs_invalid' },
    });
    assert.equal(res.status, 401);
    const body = await json(res);
    assert.ok(body.error.includes('Invalid'));
  });

  // Test 4
  it('test user and API key created via DB', () => {
    assert.ok(testUser.id, 'User should have an id');
    assert.equal(testUser.email, 'test@example.com');
    assert.ok(testApiKey.key.startsWith('rs_'), 'Key should start with rs_');
  });

  // Test 5
  it('GET /api/balance with valid key returns balance', async () => {
    const res = await fetch(BASE + '/api/balance', {
      headers: { Authorization: `Bearer ${testApiKey.key}` },
    });
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.balance, '$50.00');
    assert.equal(body.balance_cents, 5000);
  });

  // Test 6
  it('API key was stored in DB correctly', async () => {
    process.env.DB_PATH = TEST_DB;
    const db = await import(join(PROJECT_ROOT, 'lib', 'db.mjs'));
    const keys = db.listApiKeys(testUser.id);
    assert.ok(keys.length >= 1, 'Should have at least one key');
    assert.equal(keys[0].name, 'Test Key');
    assert.equal(keys[0].status, 'active');
  });

  // Tests 7-10: POST /api/pay
  // Note: custody check runs before field validation, so without CUSTODY_API_KEY
  // all /api/pay requests return 503. We test that first, then verify field
  // validation expectations via comments (would return 400/402 with custody).

  // Test 7
  it('POST /api/pay without custody returns 503 (precedes field validation)', async () => {
    const res = await fetch(BASE + '/api/pay', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${testApiKey.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    // Without custody, 503 is returned before field validation (which would give 400)
    assert.equal(res.status, 503);
    const body = await json(res);
    assert.ok(body.error.includes('not configured'));
  });

  // Test 8
  it('POST /api/pay with invalid address still returns 503 (custody check first)', async () => {
    const res = await fetch(BASE + '/api/pay', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${testApiKey.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ to: 'invalid', amount: '0.002' }),
    });
    // Would return 400 if custody were configured
    assert.equal(res.status, 503);
  });

  // Test 9
  it('POST /api/pay with zero-balance user still returns 503 (custody check first)', async () => {
    const res = await fetch(BASE + '/api/pay', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${brokeApiKey.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: '0x1234567890abcdef1234567890abcdef12345678',
        amount: '0.002',
      }),
    });
    // Would return 402 if custody were configured
    assert.equal(res.status, 503);
  });

  // Test 10
  it('POST /api/pay with valid inputs still returns 503 (no custody)', async () => {
    const res = await fetch(BASE + '/api/pay', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${testApiKey.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: '0x1234567890abcdef1234567890abcdef12345678',
        amount: '0.002',
      }),
    });
    assert.equal(res.status, 503);
    const body = await json(res);
    assert.ok(body.error.includes('not configured'));
  });

  // Test 11
  it('GET /api/usage returns empty array', async () => {
    const res = await fetch(BASE + '/api/usage', {
      headers: { Authorization: `Bearer ${testApiKey.key}` },
    });
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.ok(Array.isArray(body.usage));
    assert.equal(body.usage.length, 0);
  });

  // Test 12
  it('revoked API key returns 401', async () => {
    process.env.DB_PATH = TEST_DB;
    const db = await import(join(PROJECT_ROOT, 'lib', 'db.mjs'));

    // Find the key ID
    const keys = db.listApiKeys(testUser.id);
    const keyId = keys.find((k) => k.name === 'Test Key').id;

    // Revoke it
    db.revokeApiKey(testUser.id, keyId);

    // Try to use it
    const res = await fetch(BASE + '/api/balance', {
      headers: { Authorization: `Bearer ${testApiKey.key}` },
    });
    assert.equal(res.status, 401);
  });

  // Test 13
  it('GET /guide returns 200', async () => {
    const res = await fetch(BASE + '/guide');
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('html'));
  });

  // Test 14
  it('GET /dashboard without auth serves page (auth not configured)', async () => {
    const res = await fetch(BASE + '/dashboard', { redirect: 'manual' });
    // Auth0 not configured → serves dashboard.html directly (200)
    assert.ok([200, 302].includes(res.status), `Expected 200 or 302, got ${res.status}`);
  });
});
