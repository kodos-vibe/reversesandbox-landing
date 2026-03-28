import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

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
