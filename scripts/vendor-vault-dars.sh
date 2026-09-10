#!/usr/bin/env bash
set -euo pipefail

# Rebuild both DARs in a local canton-token-forge checkout and re-copy them into
# vault-dapp/vendor/. Only this script needs dpm and that checkout; deploying and running
# the vault stack needs neither.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${CANTON_TOKEN_FORGE_DIR:-$ROOT/../canton-token-forge-vault}"
VENDOR="$ROOT/vault-dapp/vendor"

if [ ! -d "$SRC/daml/canton-token-vault" ]; then
  echo "no canton-token-forge checkout at $SRC, set CANTON_TOKEN_FORGE_DIR" >&2
  exit 1
fi

command -v dpm >/dev/null 2>&1 || { echo "dpm not found (DAML SDK 3.4.11)" >&2; exit 1; }

# damlc fails decoding under the C/POSIX locale, and the forge is built first because the
# repo's own test package data-depends on its DAR.
for pkg in canton-token-forge canton-token-vault; do
  echo "==> building $pkg"
  ( cd "$SRC/daml/$pkg" && LANG=C.UTF-8 dpm build )
  cp "$SRC/daml/$pkg/.daml/dist/$pkg-0.0.1.dar" "$VENDOR/"
done

( cd "$SRC" && git rev-parse HEAD )
echo "==> vendored into $VENDOR (record the commit above in its PROVENANCE.md)"
