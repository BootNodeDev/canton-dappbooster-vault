#!/usr/bin/env bash
set -euo pipefail

# Upload the two vendored DARs the vault dApp needs. Order matters to nothing on the
# participant, but the registry package is sent first so a failure names the dependency
# rather than the dependent.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$ROOT/vault-dapp/vendor"

for dar in canton-token-forge-0.0.1.dar canton-token-vault-0.0.1.dar; do
  if [ ! -f "$VENDOR/$dar" ]; then
    echo "missing $VENDOR/$dar, refresh it with: pnpm run vendor-vault-dars" >&2
    exit 1
  fi
done

bash "$ROOT/scripts/deploy-dar.sh" "$VENDOR/canton-token-forge-0.0.1.dar"
bash "$ROOT/scripts/deploy-dar.sh" "$VENDOR/canton-token-vault-0.0.1.dar"
