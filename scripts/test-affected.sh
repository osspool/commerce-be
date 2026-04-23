#!/usr/bin/env bash
#
# test-affected.sh — run only the vitest suites affected by changed files.
#
# Usage:
#   ./scripts/test-affected.sh           # auto-detect from git diff
#   ./scripts/test-affected.sh --all     # run everything (CI / pre-release)
#   ./scripts/test-affected.sh --fast    # fast unit tests only
#
# Each suite runs as a SEPARATE PROCESS with its own MongoMemoryServer.
# No shared state file, no race conditions, suites can run in parallel.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

run_suite() {
  local name="$1"
  local config="$2"
  echo -e "${YELLOW}▸ Running ${name}...${NC}"
  npx vitest run --config "$config" --reporter=dot
  echo -e "${GREEN}✓ ${name} passed${NC}"
}

# --all: run every suite (parallel where possible)
if [[ "${1:-}" == "--all" ]]; then
  echo -e "${YELLOW}Running ALL test suites...${NC}\n"

  # Fast tests first (no DB, instant)
  run_suite "fast" "vitest.config.ts"

  # DB suites in parallel (each gets own MongoMemoryServer)
  run_suite "db:app" "vitest.shared-db-app.config.ts" &
  PID_APP=$!
  run_suite "db:domain" "vitest.shared-db-domain.config.ts" &
  PID_DOMAIN=$!
  wait $PID_APP $PID_DOMAIN

  # Integration (sequential internally, but separate from above)
  run_suite "integration" "vitest.integration.config.ts"
  run_suite "replset" "vitest.replset.config.ts"

  echo -e "\n${GREEN}All suites passed.${NC}"
  exit 0
fi

# --fast: just unit tests
if [[ "${1:-}" == "--fast" ]]; then
  run_suite "fast" "vitest.config.ts"
  exit 0
fi

# Auto-detect: check git diff for changed paths
CHANGED=$(git diff --name-only HEAD 2>/dev/null || git diff --name-only 2>/dev/null || echo "")

if [[ -z "$CHANGED" ]]; then
  echo -e "${YELLOW}No changes detected. Running fast tests only.${NC}"
  run_suite "fast" "vitest.config.ts"
  exit 0
fi

SUITES=()

# Always run fast tests
SUITES+=("fast:vitest.config.ts")

# Map changed paths to affected suites
if echo "$CHANGED" | grep -qE "^be-prod/src/(app|core|shared|config)/"; then
  SUITES+=("db:app:vitest.shared-db-app.config.ts")
fi

if echo "$CHANGED" | grep -qE "^be-prod/src/resources/(sales|catalog|commerce|inventory)/"; then
  SUITES+=("db:domain:vitest.shared-db-domain.config.ts")
  SUITES+=("integration:vitest.integration.config.ts")
fi

if echo "$CHANGED" | grep -qE "^be-prod/src/resources/accounting/"; then
  SUITES+=("integration:vitest.integration.config.ts")
fi

if echo "$CHANGED" | grep -qE "^be-prod/src/resources/inventory/(flow|warehouse)/"; then
  SUITES+=("replset:vitest.replset.config.ts")
fi

if echo "$CHANGED" | grep -qE "^be-prod/src/resources/auth/"; then
  SUITES+=("db:app:vitest.shared-db-app.config.ts")
fi

# Deduplicate
SUITES=($(printf '%s\n' "${SUITES[@]}" | sort -u))

echo -e "${YELLOW}Affected suites (${#SUITES[@]}):${NC}"
for s in "${SUITES[@]}"; do
  echo "  - ${s%%:*}"
done
echo ""

for s in "${SUITES[@]}"; do
  IFS=':' read -r name config <<< "$s"
  run_suite "$name" "$config"
done

echo -e "\n${GREEN}All affected suites passed.${NC}"
