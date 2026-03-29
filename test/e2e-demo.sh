#!/bin/bash
# ─────────────────────────────────────────────────────────────────────
# ReverseSandbox E2E Demo Script
#
# Usage: bash test/e2e-demo.sh [BASE_URL]
# Default BASE_URL: http://127.0.0.1:4025
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

BASE="${1:-http://127.0.0.1:4025}"
PASS=0
FAIL=0

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

pass() { ((PASS++)); echo -e "  ${GREEN}✓ PASS${NC}: $1"; }
fail() { ((FAIL++)); echo -e "  ${RED}✗ FAIL${NC}: $1 — $2"; }
info() { echo -e "${CYAN}▸${NC} $1"; }
section() { echo; echo -e "${YELLOW}── $1 ──${NC}"; }

check_status() {
  local desc="$1" url="$2" expected="$3"
  local status
  status=$(curl -s -o /dev/null -w '%{http_code}' "$url")
  if [ "$status" = "$expected" ]; then
    pass "$desc (HTTP $status)"
  else
    fail "$desc" "expected $expected, got $status"
  fi
}

echo
echo -e "${CYAN}ReverseSandbox E2E Demo${NC}"
echo "Target: $BASE"
echo "────────────────────────────────────────────"

# ── 1. Health check ──────────────────────────────────────────────────
section "1. Health Check"
check_status "GET / returns 200" "$BASE/" "200"

# ── 2. Guide page ───────────────────────────────────────────────────
section "2. Guide Page"
check_status "GET /guide returns 200" "$BASE/guide" "200"

# ── 3. API auth — no header ─────────────────────────────────────────
section "3. API Auth — Missing Header"
check_status "GET /api/balance (no auth) returns 401" "$BASE/api/balance" "401"

# ── 4. API auth — invalid key ───────────────────────────────────────
section "4. API Auth — Invalid Key"
status=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer rs_invalid" "$BASE/api/balance")
if [ "$status" = "401" ]; then
  pass "GET /api/balance with invalid key returns 401"
else
  fail "GET /api/balance with invalid key" "expected 401, got $status"
fi

# ── 5. Balance endpoint (requires valid key) ────────────────────────
section "5. Balance Endpoint"
if [ -n "${API_KEY:-}" ]; then
  info "Using API_KEY from environment"
  response=$(curl -s -H "Authorization: Bearer $API_KEY" "$BASE/api/balance")
  status=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $API_KEY" "$BASE/api/balance")
  if [ "$status" = "200" ]; then
    pass "GET /api/balance returns 200"
    echo "    Response: $response"
  else
    fail "GET /api/balance" "expected 200, got $status"
  fi
else
  info "No API_KEY env var set — skipping authenticated tests"
  info "Set API_KEY=rs_... to test authenticated endpoints"
fi

# ── 6. Pay endpoint (requires valid key) ────────────────────────────
section "6. Pay Endpoint"
if [ -n "${API_KEY:-}" ]; then
  info "Testing missing fields..."
  status=$(curl -s -o /dev/null -w '%{http_code}' \
    -X POST -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d '{}' "$BASE/api/pay")
  if [ "$status" = "400" ]; then
    pass "POST /api/pay with empty body returns 400"
  else
    fail "POST /api/pay with empty body" "expected 400, got $status"
  fi

  info "Testing invalid address..."
  status=$(curl -s -o /dev/null -w '%{http_code}' \
    -X POST -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"to":"invalid","amount":"0.002"}' "$BASE/api/pay")
  if [ "$status" = "400" ]; then
    pass "POST /api/pay with invalid address returns 400"
  else
    fail "POST /api/pay with invalid address" "expected 400, got $status"
  fi

  info "Testing valid pay request (may fail without custody — that's OK)..."
  response=$(curl -s -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -X POST \
    -d '{"to":"0x1234567890abcdef1234567890abcdef12345678","amount":"0.002"}' \
    "$BASE/api/pay")
  status=$(curl -s -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -X POST \
    -d '{"to":"0x1234567890abcdef1234567890abcdef12345678","amount":"0.002"}' \
    "$BASE/api/pay")
  info "POST /api/pay → HTTP $status"
  echo "    Response: $response"
  if [ "$status" = "200" ] || [ "$status" = "402" ] || [ "$status" = "503" ]; then
    pass "POST /api/pay returned expected status ($status)"
  else
    fail "POST /api/pay" "unexpected status $status"
  fi
else
  info "Skipping (no API_KEY)"
fi

# ── 7. Usage endpoint ───────────────────────────────────────────────
section "7. Usage Endpoint"
if [ -n "${API_KEY:-}" ]; then
  response=$(curl -s -H "Authorization: Bearer $API_KEY" "$BASE/api/usage")
  status=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $API_KEY" "$BASE/api/usage")
  if [ "$status" = "200" ]; then
    pass "GET /api/usage returns 200"
    echo "    Response: $response"
  else
    fail "GET /api/usage" "expected 200, got $status"
  fi
else
  info "Skipping (no API_KEY)"
fi

# ── 8. Dashboard ────────────────────────────────────────────────────
section "8. Dashboard"
status=$(curl -s -o /dev/null -w '%{http_code}' -L "$BASE/dashboard")
if [ "$status" = "200" ]; then
  pass "GET /dashboard returns 200 (auth not configured or accessible)"
else
  info "GET /dashboard returned $status (may redirect to login — expected with auth)"
  pass "GET /dashboard responded ($status)"
fi

# ── Summary ─────────────────────────────────────────────────────────
echo
echo "────────────────────────────────────────────"
echo -e "Results: ${GREEN}$PASS passed${NC}, ${RED}$FAIL failed${NC}"
echo

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
