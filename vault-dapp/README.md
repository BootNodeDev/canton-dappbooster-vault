# vault-dapp

A token vault dApp: deposit an underlying CIP-0056 token, receive vault shares,
return the shares, get the underlying back. It drives the `canton-token-vault` Daml package through
any CIP-0103 browser wallet, and every read and write is the connected account's own.

The Daml lives in [BootNodeDev/canton-token-forge](https://github.com/BootNodeDev/canton-token-forge);
this package ships its built DARs under [`vendor/`](vendor/PROVENANCE.md) and compiles no Daml.

Repo-wide setup is in the [root README](../README.md).

## Running it

Needs the LocalNet up, wallet-service on 3010, both DARs deployed and the vault bootstrapped:

```bash
pnpm run deploy-vault-dars      # uploads vendor/*.dar to the participant
pnpm run bootstrap-vault        # the issuer and vault parties, both instruments, the Vault
pnpm run vault:dev              # http://localhost:3013
```

Point a CIP-0103 wallet (such as the
[Carpincho development wallet](https://github.com/BootNodeDev/carpincho-wallet)) at
`http://localhost:3010/rpc` and connect.

## What talks to what

```
vault-dapp (3013) ──CIP-0103──▶ wallet ──▶ wallet-service (3010) ──▶ participant JSON API
                                                    ▲
                                    scripts/vault-operator.mjs
```

The vault party cannot be a wallet account: both `*_Settle` choices are controlled by it, and a
withdraw needs it to allocate its own payout leg, so it is a participant-hosted party that a
backstage poller acts as. The browser only ever submits as the connected account.

Nothing is configured. The vault, both instruments and every disclosure this app sends are read off
the ledger each time it loads, so a re-bootstrap cannot leave a stale pointer behind.
