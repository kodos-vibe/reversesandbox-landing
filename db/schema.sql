CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    auth0_sub     TEXT    NOT NULL UNIQUE,
    email         TEXT    NOT NULL,
    name          TEXT    NOT NULL DEFAULT '',
    balance       INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    last_login_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_auth0_sub ON users(auth0_sub);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS activity_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    event_type TEXT    NOT NULL,
    metadata   TEXT    DEFAULT '{}',
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_log(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_type ON activity_log(event_type);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at);

CREATE TABLE IF NOT EXISTS payments (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id               INTEGER NOT NULL REFERENCES users(id),
    stripe_session_id     TEXT    NOT NULL UNIQUE,
    stripe_payment_intent TEXT,
    amount_cents          INTEGER NOT NULL,
    status                TEXT    NOT NULL DEFAULT 'pending',
    created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
    completed_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_session ON payments(stripe_session_id);

-- API keys for agent authentication
CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    key_prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    name TEXT DEFAULT 'Default',
    status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now')),
    last_used_at TEXT,
    revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);

-- Usage tracking for API calls
CREATE TABLE IF NOT EXISTS usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    api_key_id INTEGER NOT NULL REFERENCES api_keys(id),
    service TEXT NOT NULL,
    payment_to TEXT NOT NULL,
    amount_usd TEXT NOT NULL,
    cost_microcents INTEGER NOT NULL,
    network TEXT NOT NULL DEFAULT 'base',
    token TEXT DEFAULT 'USDC',
    created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_log(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_key ON usage_log(api_key_id);
