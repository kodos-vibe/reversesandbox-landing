/**
 * 7clave Custody Integration — Payment Signing via Intent Flow
 *
 * Embeds the Propose → Fetch → Sign → Commit flow for EIP-3009
 * TransferWithAuthorization (SignTypedData) intents.
 */

import { generateKeyPair, exportJWK } from "jose";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createPrivateKey, sign, createHash, randomBytes, randomUUID } from "node:crypto";
import canonicalize from "canonicalize";

// ── Configuration ────────────────────────────────────────────────────

let config = null;

export function init() {
  if (config) return true;
  const apiKey = process.env.CUSTODY_API_KEY;
  if (!apiKey) return false;

  config = {
    apiKey,
    agentName: process.env.CUSTODY_AGENT_NAME || "alice",
    apiUrl: (process.env.CUSTODY_API_URL || "https://api.fm7b5.com").replace(/\/$/, ""),
    keyDir: process.env.CUSTODY_KEY_DIR || "./custody-keys",
  };
  return true;
}

function requireConfig() {
  if (!config) throw new Error("Custody not configured");
  return config;
}

// ── P-256 Key Management ─────────────────────────────────────────────

function keyPath(name) {
  const safeName = name.replace(/[/\\]/g, "_");
  return join(requireConfig().keyDir, `${safeName}.json`);
}

async function loadOrGenerateKey(name) {
  const dir = requireConfig().keyDir;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = keyPath(name);

  if (existsSync(path)) {
    const jwk = JSON.parse(await readFile(path, "utf-8"));
    const privateKey = createPrivateKey({ key: jwk, format: "jwk" });
    return { privateKey, jwk };
  }

  const { privateKey: joseKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = await exportJWK(joseKey);
  jwk.alg = "ES256";
  jwk.ext = true;

  await writeFile(path, JSON.stringify(jwk, null, 2), { mode: 0o600 });
  const privateKey = createPrivateKey({ key: jwk, format: "jwk" });
  return { privateKey, jwk };
}

function getPublicKeyHex(jwk) {
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  return Buffer.concat([Buffer.from([0x04]), x, y]).toString("hex");
}

function signBytes(privateKey, data) {
  const signature = sign("SHA256", Buffer.from(data), {
    key: privateKey,
    dsaEncoding: "der",
  });
  return signature.toString("base64");
}

// ── HTTP Client ──────────────────────────────────────────────────────

let cachedDomainId = null;

function qs(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null) sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

async function request(method, path, { params, body, noAuth } = {}) {
  const { apiUrl, apiKey } = requireConfig();
  const url = `${apiUrl}${path}${qs(params || {})}`;
  const headers = noAuth
    ? { "Content-Type": "application/json" }
    : { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  const opts = { method, headers, signal: AbortSignal.timeout(30_000) };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${method} ${path}: ${text}`);
  }
  return res.json();
}

async function discoverDomainId() {
  if (cachedDomainId) return cachedDomainId;
  const data = await request("GET", "/v1/agents/domain");
  cachedDomainId = data.domain_id;
  return cachedDomainId;
}

// ── Intent Flow: Propose → Fetch → Sign → Commit ────────────────────

function buildSigningInput(commitObject, displayContext) {
  const canonicalBytes = Buffer.from(canonicalize(commitObject), "utf-8");
  const displayCtx = displayContext ?? {};
  const displayHash = createHash("sha256")
    .update(Buffer.from(canonicalize(displayCtx), "utf-8"))
    .digest();
  return Buffer.concat([canonicalBytes, displayHash]);
}

async function proposeFetchCommit({ payload, domainId, privateKey, jwk, includePubkey = false }) {
  const { agentName } = requireConfig();

  // Step 1: Propose
  const proposeData = await request("POST", `/v1/agent/${domainId}/intents/propose`, {
    params: { agent_name: agentName },
    body: payload,
  });
  const { session_id, challenge } = proposeData;

  // Step 2: Fetch commit object
  const fetchData = await request(
    "POST",
    `/v1/mobile/domains/${domainId}/intents/${session_id}/fetch`,
    {
      params: { challenge },
      body: {
        device_id: "reversesandbox",
        device_name: "ReverseSandbox",
        platform: "agent",
      },
      noAuth: true,
    }
  );
  const commitObject = fetchData.object;
  const displayContext = fetchData.display_context || null;
  const signChallenge = fetchData.challenge;

  // Step 3: Sign
  const signingInput = buildSigningInput(commitObject, displayContext);
  const signatureB64 = signBytes(privateKey, signingInput);

  // Step 4: Commit
  const commitBody = { algorithm: "ES256", signature: signatureB64 };
  if (includePubkey) {
    commitBody.p256_pubkey = getPublicKeyHex(jwk);
  }

  return request(
    "POST",
    `/v1/mobile/domains/${domainId}/intents/${session_id}/commit`,
    {
      params: { challenge: signChallenge },
      body: commitBody,
      noAuth: true,
    }
  );
}

// ── Polling ──────────────────────────────────────────────────────────

async function pollUntil(checkFn, isDoneFn, maxMs = 30000, intervalMs = 1500) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const result = await checkFn();
      if (isDoneFn(result)) return result;
    } catch (err) {
      if (!err.message.includes("HTTP 404") && !err.message.includes("HTTP 500")) {
        throw err;
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

// ── Account Resolution ───────────────────────────────────────────────

async function resolveForToken(domainId, token = "USDC", chain) {
  const { agentName } = requireConfig();
  const bal = await request("GET", `/v1/agent/${domainId}/wallets/balance/self`, {
    params: { agent_name: agentName },
  });

  const items = bal.items || bal.accounts || [];
  const tokenUpper = token.toUpperCase();
  const matches = [];

  for (const account of items) {
    const accountId = account.account_id || account.id;
    for (const ledger of account.ledger_balances || []) {
      const network = ledger.network || "";
      const ledgerId = ledger.ledger_id || null;
      const ledgerName = ledger.ledger_name || "";
      for (const b of ledger.total_balances || []) {
        if ((b.symbol || "").toUpperCase() === tokenUpper) {
          matches.push({
            account_id: accountId,
            ticker_id: b.ticker_id,
            decimals: b.decimals || 6,
            symbol: b.symbol,
            network,
            ledgerName,
            ledger_id: ledgerId,
            asset: b.contract_address || b.asset_address || b.asset || null,
          });
        }
      }
    }
    // Legacy assets format
    for (const asset of account.assets || []) {
      if ((asset.symbol || "").toUpperCase() === tokenUpper) {
        matches.push({
          account_id: accountId,
          ticker_id: asset.ticker_id,
          decimals: asset.decimals || 6,
          symbol: asset.symbol,
          network: account.network || account.chain || "",
          asset: asset.contract_address || asset.asset_address || asset.asset || null,
        });
      }
    }
  }

  if (matches.length === 0) {
    throw new Error(`No account found with token ${token}. Fund the agent wallet first.`);
  }

  // Deduplicate
  const unique = new Map();
  for (const m of matches) unique.set(`${m.account_id}:${m.ticker_id}`, m);

  if (unique.size > 1 && chain) {
    const chainLower = chain.toLowerCase();
    const filtered = [...unique.values()].filter(
      (m) => m.network.toLowerCase().includes(chainLower) || (m.ledgerName || "").toLowerCase().includes(chainLower)
    );
    if (filtered.length === 1) return filtered[0];
  }

  if (unique.size > 1) {
    throw new Error(`Multiple accounts have ${token}. Specify the chain/network to disambiguate.`);
  }

  return [...unique.values()][0];
}

async function resolveAddress(domainId, accountId) {
  const { agentName } = requireConfig();
  const data = await request("GET", `/v1/agent/${domainId}/wallets/${accountId}/addresses/self`, {
    params: { agent_name: agentName },
  });
  const addresses = data.addresses || data.items || (Array.isArray(data) ? data : []);
  if (addresses.length === 0) throw new Error(`No addresses found for account ${accountId}`);
  return addresses[0].address || addresses[0];
}

// ── Amount Conversion ────────────────────────────────────────────────

function toRawAmount(decimalStr, decimals) {
  const parsed = parseFloat(decimalStr);
  if (!isFinite(parsed) || parsed <= 0) {
    throw new Error(`Amount must be a positive number, got: ${decimalStr}`);
  }
  const parts = decimalStr.split(".");
  const whole = parts[0] || "0";
  const frac = (parts[1] || "").padEnd(decimals, "0").slice(0, decimals);
  return (BigInt(whole) * BigInt(10 ** decimals) + BigInt(frac)).toString();
}

// ── Enrollment Error Detection ───────────────────────────────────────

function isMustEnrollError(err) {
  const msg = (err.message || "").toLowerCase();
  return (
    msg.includes("must enroll") ||
    msg.includes("enroll a public key") ||
    msg.includes("no pubkey enrolled") ||
    msg.includes("pubkey before proposing") ||
    msg.includes("signature verification failed") ||
    msg.includes("signature error") ||
    msg.includes("signing failed")
  );
}

// ── Payment Signing ──────────────────────────────────────────────────

export async function signPayment({ to, amount, network, token = "USDC", validSeconds = 300 }) {
  const cfg = requireConfig();
  const { privateKey, jwk } = await loadOrGenerateKey(cfg.agentName);
  const domainId = await discoverDomainId();

  // 1. Resolve account and ticker
  const resolved = await resolveForToken(domainId, token, network);
  const fromAddress = await resolveAddress(domainId, resolved.account_id);

  // 2. Ticker details (token name, contract address, ledger_id)
  const ticker = await request("GET", `/v1/agent/${domainId}/tickers/${resolved.ticker_id}`, {
    params: { agent_name: cfg.agentName },
  });
  const tokenName = ticker.name || "";
  const contractAddress = ticker.contract_address || "";
  const decimals = ticker.decimals || resolved.decimals || 6;
  if (!contractAddress) {
    throw new Error(`Ticker ${resolved.ticker_id} has no contract address`);
  }

  // 3. Ledger details (chain_id)
  const ledgerId = ticker.ledger_id || resolved.ledger_id;
  if (!ledgerId) throw new Error(`Cannot determine ledger for ticker ${resolved.ticker_id}`);
  const ledger = await request("GET", `/v1/agent/${domainId}/ledgers/${ledgerId}`, {
    params: { agent_name: cfg.agentName },
  });
  const chainId = ledger.chain_id;
  if (chainId == null) throw new Error(`Ledger ${ledgerId} has no chain_id`);

  // 4. Convert amount
  const rawValue = toRawAmount(amount, decimals);

  // 5. Nonce and validity window
  const nonce = "0x" + randomBytes(32).toString("hex");
  const validAfter = 0;
  const validBefore = Math.floor(Date.now() / 1000) + (validSeconds || 300);

  // 6. Build EIP-712 TypedData
  const typedData = {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    domain: {
      name: tokenName,
      version: "2",
      chainId,
      verifyingContract: contractAddress,
    },
    message: {
      from: fromAddress,
      to,
      value: rawValue,
      validAfter,
      validBefore,
      nonce,
    },
  };

  // 7. SignTypedData intent
  const payload = {
    intent_type: "SignTypedData",
    id: randomUUID(),
    domain_id: domainId,
    account_id: resolved.account_id,
    typed_data: typedData,
  };

  let commitResult;
  try {
    commitResult = await proposeFetchCommit({
      payload,
      domainId,
      privateKey,
      jwk,
      includePubkey: false,
    });
  } catch (err) {
    if (isMustEnrollError(err)) {
      // Stale key — retry with includePubkey
      commitResult = await proposeFetchCommit({
        payload,
        domainId,
        privateKey,
        jwk,
        includePubkey: true,
      });
    } else {
      throw err;
    }
  }

  const intentId = commitResult.intent_id || commitResult.id || commitResult.session_id;

  // 8. Poll for signature
  const sigResult = await pollUntil(
    () =>
      request("GET", `/v1/agent/${domainId}/signatures/${intentId}/self`, {
        params: { agent_name: cfg.agentName },
      }).catch((e) => {
        if (e.message && e.message.includes("HTTP 404")) return null;
        throw e;
      }),
    (s) => {
      if (!s) return false;
      if (s.signature) return true;
      if (s.status) {
        const st =
          typeof s.status === "string"
            ? s.status.toLowerCase()
            : (s.status.execution_status?.value || s.status.approval_status || "").toLowerCase();
        if (st === "rejected" || st === "failed") return true;
      }
      return false;
    },
    30000,
    1500
  );

  if (!sigResult || !sigResult.signature) {
    throw new Error("Payment signing timed out or was rejected");
  }

  return {
    signature: sigResult.signature,
    authorization: {
      from: fromAddress,
      to,
      value: amount,
      rawValue,
      decimals,
      validAfter: String(validAfter),
      validBefore: String(validBefore),
      nonce,
    },
    eip712Domain: {
      name: tokenName,
      version: "2",
      chainId,
      verifyingContract: contractAddress,
    },
    eip712_hash: sigResult.eip712_hash || null,
    signed_hash: sigResult.signed_hash || null,
  };
}

// ── x402 Payment Header Builder ──────────────────────────────────────

export function buildX402PaymentHeader(signResult, acceptedRequirements) {
  // x402 SDK v2 format needs: x402Version, payload (authorization + signature), AND accepted
  // The "accepted" field must deepEqual one of the "accepts" entries from the 402 response
  const payload = {
    x402Version: 2,
    scheme: "exact",
    network: acceptedRequirements?.network || "eip155:137",
    payload: {
      authorization: {
        from: signResult.authorization.from,
        to: signResult.authorization.to,
        value: signResult.authorization.rawValue,
        validAfter: signResult.authorization.validAfter,
        validBefore: signResult.authorization.validBefore,
        nonce: signResult.authorization.nonce,
      },
      signature: signResult.signature,
    },
    accepted: acceptedRequirements || {},
  };

  return Buffer.from(JSON.stringify(payload)).toString("base64");
}
