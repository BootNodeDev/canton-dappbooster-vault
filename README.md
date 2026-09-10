# Canton dAppBooster

Local Canton development stack, with two demo apps over it: a Canton Coin vesting dApp
(`dapp/frontend`, port 3012) and a token vault dApp (`vault-dapp`, port 3013).

## Requirements

- Node 24 (>=24.15.0)
- pnpm 11.22.0
- Docker
- dpm (DAML SDK 3.4.11), only to build the vesting DAR. The vault dApp ships its DARs built.

## Initial setup

```bash
pnpm i
```

## Starting the stack

The easiest way is using the `dev-stack` script.

```bash
./scripts/dev-stack.sh
```

**Note:** The LocalNet runs from `.canton-localnet`.

To run it from another folder you can use this:

```bash
./scripts/dev-stack.sh ~/path-to-your-folder
```

The menu starts either app: `up` brings up the vesting stack, `vault-up` the vault one. Both share
the LocalNet and wallet-service, so `down` stops everything.

## Starting the stack, step by step

### Docker

```bash
open -a Docker
```

### Env vars

```bash
cp .env.example .env
```

Default values should be enough, except for `CANTON_BACKEND_TOKEN` which must be generated.

To generate it run this command and then add the token to `.env`

```bash
pnpm run mint-token
```

### LocalNet

Create a folder for [canton-barebones](https://github.com/BootNodeDev/canton-barebones).

```bash
mkdir -p .canton-localnet
cd .canton-localnet
```

Then run this command to scaffold it.

```bash
pnpm exec canton-barebones init
```

Edit `canton-barebones.config.json`: change `validators.appUser.ui` and `sv.scanUI` to `true`.

Start canton-barebones from `.canton-localnet`

```bash
pnpm exec canton-barebones start
```

**Notes:**

- The first run pulls ~10 GB. If `start` exits 1 during splice migrations, run it again.
- Splice can take a few minutes to start.

### DAR build and deploy

`deploy-dar` requires LocalNet up and running.

```bash
pnpm run build-dar
pnpm run deploy-dar -- dapp/daml/.daml/dist/amulet-vesting-0.0.1.dar
```

**Note:** The step is only needed the first time. Run again if the Daml source changes or if LocalNet is reset.

### Wallet service

Start [wallet-service](https://github.com/BootNodeDev/canton-wallet-service).

```bash
pnpm exec canton-wallet-service
```

### Bootstrap

Needs both LocalNet and wallet-service up and running.

```bash
pnpm run bootstrap
```

**Note:** The step is only needed the first time. Run again if the Daml source changes or if LocalNet is reset.

### Demo dApp

Start the Vesting demo app.

```bash
pnpm run app:dev
```

App runs on http://localhost:3012 by default.

A compatible CIP-0103 wallet (like the [Carpincho development wallet](https://github.com/BootNodeDev/carpincho-wallet)) is required to connect to the demo.

Point the wallet at http://localhost:3010/rpc, create at least 2 accounts, connect and try [the demo](https://demo.dappbooster.cc/).

## The vault dApp, step by step

Same Docker, env vars, LocalNet and wallet-service steps as above. The vault's Daml lives in
[canton-token-forge](https://github.com/BootNodeDev/canton-token-forge) and its DARs are vendored
built under `vault-dapp/vendor/`, so this path replaces the build and deploy step and needs no dpm.

### Deploy the vendored DARs

```bash
pnpm run deploy-vault-dars
```

### Bootstrap

Creates the issuer and vault parties, both instruments and the Vault itself.

```bash
pnpm run bootstrap-vault
```

**Note:** Both steps are only needed the first time. Run them again if LocalNet is reset.

### Vault operator

The vault party is participant-hosted, not a wallet account, so a backstage poller settles what the
browser proposes. Leave it running.

```bash
pnpm run vault-operator
```

### Vault app

```bash
pnpm run vault:dev
```

App runs on http://localhost:3013 by default. Connect the same CIP-0103 wallet, pointed at
http://localhost:3010/rpc.
