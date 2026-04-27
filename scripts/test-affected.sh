#!/usr/bin/env bash
#
# test-affected.sh — run only the vitest projects affected by changed files.
#
# Usage:
#   ./scripts/test-affected.sh           # auto-detect from git diff
#   ./scripts/test-affected.sh --all     # run every project
#   ./scripts/test-affected.sh --fast    # unit project only
#
# Vitest runs projects in parallel natively — no background-job juggling
# needed here. This script just maps `git diff` to project names and hands
# them to `vitest run --project <name>`.

set -euo pipefail

YELLOW='\033[0;33m'
GREEN='\033[0;32m'
NC='\033[0m'

run_projects() {
  echo -e "${YELLOW}▸ vitest projects: $*${NC}"
  local args=()
  for name in "$@"; do
    args+=(--project "$name")
  done
  npx vitest run "${args[@]}" --reporter=dot
}

# --all: every project (default `vitest run` with no --project flags)
if [[ "${1:-}" == "--all" ]]; then
  echo -e "${YELLOW}Running ALL vitest projects...${NC}"
  npx vitest run --reporter=dot
  echo -e "${GREEN}All projects passed.${NC}"
  exit 0
fi

# --fast: unit project only
if [[ "${1:-}" == "--fast" ]]; then
  run_projects unit
  exit 0
fi

CHANGED=$(git diff --name-only HEAD 2>/dev/null || git diff --name-only 2>/dev/null || echo "")

if [[ -z "$CHANGED" ]]; then
  echo -e "${YELLOW}No changes detected. Running unit project only.${NC}"
  run_projects unit
  exit 0
fi

# Always include unit
PROJECTS=("unit")

# Map changed paths to affected projects
if echo "$CHANGED" | grep -qE "^be-prod/src/(app|core|shared|config)/"; then
  PROJECTS+=("integration-app")
fi

if echo "$CHANGED" | grep -qE "^be-prod/src/resources/auth/"; then
  PROJECTS+=("integration-app")
fi

if echo "$CHANGED" | grep -qE "^be-prod/src/resources/(sales|catalog|commerce|inventory)/"; then
  PROJECTS+=("integration-domain" "integration-shared")
fi

if echo "$CHANGED" | grep -qE "^be-prod/src/resources/accounting/"; then
  PROJECTS+=("integration-shared" "scenarios-replset")
fi

if echo "$CHANGED" | grep -qE "^be-prod/src/resources/inventory/(flow|warehouse)/"; then
  PROJECTS+=("scenarios-replset")
fi

if echo "$CHANGED" | grep -qE "^be-prod/src/resources/(revenue|payments?)"; then
  PROJECTS+=("scenarios-payments")
fi

if echo "$CHANGED" | grep -qE "^be-prod/src/resources/logistics/"; then
  PROJECTS+=("scenarios-logistics")
fi

if echo "$CHANGED" | grep -qE "^be-prod/src/resources/notifications/"; then
  PROJECTS+=("scenarios-notifications")
fi

if echo "$CHANGED" | grep -qE "^be-prod/src/resources/analytics/"; then
  PROJECTS+=("scenarios-analytics")
fi

# Deduplicate while preserving order
seen=()
UNIQUE=()
for p in "${PROJECTS[@]}"; do
  if [[ ! " ${seen[*]-} " =~ " $p " ]]; then
    UNIQUE+=("$p")
    seen+=("$p")
  fi
done

echo -e "${YELLOW}Affected projects (${#UNIQUE[@]}): ${UNIQUE[*]}${NC}"
run_projects "${UNIQUE[@]}"
echo -e "${GREEN}All affected projects passed.${NC}"
