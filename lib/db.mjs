import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash, randomBytes } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || './db/reversesandbox.db';

let db;

export function getDb() {
  if (!db) {
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    migrate();
  }
  return db;
}

function migrate() {
  const schema = readFileSync(join(__dirname, '..', 'db', 'schema.sql'), 'utf-8');
  db.exec(schema);
}

export function findOrCreateUser(auth0Sub, email, name) {
  const d = getDb();
  const existing = d.prepare('SELECT * FROM users WHERE auth0_sub = ?').get(auth0Sub);
  if (existing) {
    d.prepare('UPDATE users SET last_login_at = datetime(\'now\'), email = ?, name = ? WHERE id = ?')
      .run(email, name, existing.id);
    logActivity(existing.id, 'login', {});
    return d.prepare('SELECT * FROM users WHERE id = ?').get(existing.id);
  }
  const result = d.prepare('INSERT INTO users (auth0_sub, email, name) VALUES (?, ?, ?)')
    .run(auth0Sub, email, name);
  const userId = result.lastInsertRowid;
  logActivity(userId, 'registration', {});
  return d.prepare('SELECT * FROM users WHERE id = ?').get(userId);
}

export function getUserById(id) {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
}

export function getUserByAuth0Sub(sub) {
  return getDb().prepare('SELECT * FROM users WHERE auth0_sub = ?').get(sub);
}

export function creditBalance(userId, amountCents) {
  const d = getDb();
  d.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(amountCents, userId);
  return d.prepare('SELECT balance FROM users WHERE id = ?').get(userId);
}

export function logActivity(userId, eventType, metadata = {}) {
  getDb().prepare('INSERT INTO activity_log (user_id, event_type, metadata) VALUES (?, ?, ?)')
    .run(userId, eventType, JSON.stringify(metadata));
}

export function getActivity(userId, limit = 20, offset = 0) {
  return getDb().prepare(
    'SELECT * FROM activity_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(userId, limit, offset);
}

export function createPayment(userId, stripeSessionId, amountCents) {
  getDb().prepare(
    'INSERT INTO payments (user_id, stripe_session_id, amount_cents) VALUES (?, ?, ?)'
  ).run(userId, stripeSessionId, amountCents);
}

export function completePayment(stripeSessionId, paymentIntentId) {
  const d = getDb();
  const payment = d.prepare('SELECT * FROM payments WHERE stripe_session_id = ?').get(stripeSessionId);
  if (!payment || payment.status === 'completed') return null;

  const txn = d.transaction(() => {
    d.prepare(
      'UPDATE payments SET status = ?, stripe_payment_intent = ?, completed_at = datetime(\'now\') WHERE stripe_session_id = ?'
    ).run('completed', paymentIntentId, stripeSessionId);
    d.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(payment.amount_cents, payment.user_id);
    logActivity(payment.user_id, 'payment', { amount_cents: payment.amount_cents, stripe_session_id: stripeSessionId });
  });
  txn();
  return payment;
}

export function failPayment(stripeSessionId) {
  getDb().prepare('UPDATE payments SET status = ? WHERE stripe_session_id = ?').run('failed', stripeSessionId);
}

export function generateApiKey(userId, name = 'Default') {
  const d = getDb();
  const raw = 'rs_' + randomBytes(24).toString('hex');
  const prefix = raw.slice(0, 11);
  const hash = createHash('sha256').update(raw).digest('hex');
  d.prepare(
    'INSERT INTO api_keys (user_id, key_prefix, key_hash, name) VALUES (?, ?, ?, ?)'
  ).run(userId, prefix, hash, name);
  logActivity(userId, 'api_key_created', { prefix, name });
  return { key: raw, prefix, name };
}

export function listApiKeys(userId) {
  return getDb().prepare(
    'SELECT id, key_prefix, name, status, created_at, last_used_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC'
  ).all(userId);
}

export function revokeApiKey(userId, keyId) {
  const d = getDb();
  const key = d.prepare('SELECT * FROM api_keys WHERE id = ? AND user_id = ?').get(keyId, userId);
  if (!key) return null;
  d.prepare("UPDATE api_keys SET status = 'revoked', revoked_at = datetime('now') WHERE id = ?").run(keyId);
  logActivity(userId, 'api_key_revoked', { prefix: key.key_prefix, name: key.name });
  return d.prepare('SELECT id, key_prefix, name, status, created_at, last_used_at, revoked_at FROM api_keys WHERE id = ?').get(keyId);
}

export function deductBalance(userId, amountCents) {
  const d = getDb();
  // Don't go below 0
  d.prepare('UPDATE users SET balance = MAX(0, balance - ?) WHERE id = ?').run(amountCents, userId);
  return d.prepare('SELECT balance FROM users WHERE id = ?').get(userId);
}

export function atomicDeduct(userId, cents) {
  const result = getDb().prepare(
    'UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?'
  ).run(cents, userId, cents);
  return result.changes > 0;
}

export function addBalance(userId, cents) {
  getDb().prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(cents, userId);
}

export function logUsage(userId, apiKeyId, { service, paymentTo, amountUsd, costMicrocents, network, token }) {
  getDb().prepare(
    'INSERT INTO usage_log (user_id, api_key_id, service, payment_to, amount_usd, cost_microcents, network, token) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(userId, apiKeyId, service, paymentTo, amountUsd, costMicrocents, network || 'base', token || 'USDC');
}

export function getUsage(userId, limit = 50) {
  return getDb().prepare(
    'SELECT * FROM usage_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(userId, limit);
}

export function lookupApiKey(rawKey) {
  const d = getDb();
  const hash = createHash('sha256').update(rawKey).digest('hex');
  const row = d.prepare(
    "SELECT k.*, u.balance, u.email, u.name AS user_name FROM api_keys k JOIN users u ON k.user_id = u.id WHERE k.key_hash = ? AND k.status = 'active'"
  ).get(hash);
  if (!row) return null;
  d.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(row.id);
  return row;
}
