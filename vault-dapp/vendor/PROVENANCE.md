# Provenance: vendored DARs

Both files are build artifacts, not source. Nothing in this repository compiles Daml for the vault
dApp; these are uploaded to the participant as they are.

| File | Package | Source |
|------|---------|--------|
| `canton-token-forge-0.0.1.dar` | `canton-token-forge` | [BootNodeDev/canton-token-forge](https://github.com/BootNodeDev/canton-token-forge), `daml/canton-token-forge` |
| `canton-token-vault-0.0.1.dar` | `canton-token-vault` | same repository, `daml/canton-token-vault` |

- **Commit:** `f2025add5372bf7aa03f151e6164d062c9fec6f5` (`build: add analyse script running
  daml-analyzer over built dars`)
- **Built with:** `dpm` 1.0.21, Daml SDK 3.4.11, LF target 2.1
- **Command:** `LANG=C.UTF-8 dpm build` in each package, forge first (the vault does not depend on
  it, but the repo's own test package does, so that is the order its `multi-package.yaml` expects).
  `LANG` is load-bearing, since `damlc` fails decoding under the `C`/POSIX locale.

Refresh both with `pnpm run vendor-vault-dars`, which points at a local checkout through
`CANTON_TOKEN_FORGE_DIR` (default `../canton-token-forge-vault`).

## Why these two files are enough

`canton-token-vault-0.0.1.dar` bundles the five `splice-api-token-*` interface packages it links
against (`holding`, `metadata`, `allocation`, `allocation-request`, `burn-mint`) at the package ids
it was compiled with, and carries no `canton-token-forge` dalf at all: the vault templates
data-depend only on the standard interfaces, so any CIP-0056 registry can be the instrument
admin. `canton-token-forge-0.0.1.dar` is here because it is the registry this stack uses, and it
bundles the same interface packages plus `transfer-instruction` and `allocation-instruction`.

So the Splice interface DARs are never uploaded separately, and `scripts/fetch-daml-deps.mjs` has
nothing to fetch for this package.
