#!/usr/bin/env bash
# Fail if anything that looks like a credential or a customer identifier is in
# the repo (or in a built bundle). This repo is public: the Knack REST key,
# session secrets, and customers' Knack app ids must only ever come from the
# environment or a secret manager.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0
report() { echo "✗ $1"; fail=1; }

# Tracked and about-to-be-tracked files, minus lockfiles and test fixtures.
files=$(git ls-files --cached --others --exclude-standard | grep -vE '(^|/)package-lock\.json$|^packages/core/test/' || true)
bundles=$(find apps/web/dist packages/*/dist packages/server-firebase/lib -type f \( -name '*.js' -o -name '*.html' \) 2>/dev/null | grep -v snapshot.json || true)

check() {
  local label=$1 pattern=$2 scope=$3
  local hits
  hits=$(printf '%s\n' $scope | xargs grep -nEI "$pattern" 2>/dev/null || true)
  if [ -n "$hits" ]; then
    report "$label"
    echo "$hits" | head -5 | sed 's/^/    /'
  fi
}

# Knack REST API keys are UUIDs.
# Any case, anywhere: a key pasted bare into prose or a script counts too.
check "UUID-shaped value (a Knack REST API key looks like this)" '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}' "$files $bundles"
# Knack app and record ids are 24 hex characters: any standalone 24-hex token,
# quoted or not (e.g. an app id pasted into the README).
check "24-hex Knack id (app or record id)" '(^|[^0-9a-fA-F])[0-9a-fA-F]{24}([^0-9a-fA-F]|$)' "$files"
# Assignments of secrets.
check "secret assigned in a tracked file" '(KNACK_API_KEY|SESSION_SECRET)=[A-Za-z0-9+/_=-]{16,}' "$files"
check "X-Knack-REST-API-Key with a literal value" "X-Knack-REST-API-Key['\"]?[[:space:]]*:[[:space:]]*['\"][^'\"]" "$files $bundles"
# Private keys.
check "private key" 'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY' "$files"

# Files that must never be tracked.
for f in .env .knack/snapshot.json data/audit.jsonl; do
  if git ls-files --error-unmatch "$f" >/dev/null 2>&1; then report "$f is tracked by git"; fi
done

if [ $fail -ne 0 ]; then
  echo; echo "Key check failed. Move the value to the environment or Secret Manager."; exit 1
fi
echo "✔ no keys, secrets or customer ids found"
