# Agent Configuration: vault-dapp

This file applies only to `vault-dapp/`. Repo-wide rules, including the filename casing table and
the colocate-then-promote placement rules, are in the [root `CLAUDE.md`](../CLAUDE.md). The layout
and naming deltas in [`dapp/frontend/CLAUDE.md`](../dapp/frontend/CLAUDE.md) hold here too, since
this app is built to the same shape. Only what differs is below.

## What this app does not have

- **No `VITE_*` key, no `parseEnv`, no `define`.** Everything is read off the ledger: the vault
  party, both instruments, every disclosure. So there is no `src/utils/env.ts` and no
  `vite-env.d.ts` augmentation. The first key that earns its place brings that machinery with it.
- **No call to wallet-service from the browser.** The vault moves no Amulet, so nothing here needs
  `amulet.tap`, which is the vesting dApp's one non-wallet path. There is no `api/` directory and no
  `vercel.json`: this app is not deployed.
- **No token registry client.** See the disclosure rule below.

## Ledger reads and writes

- **A read goes through [`backend/acs.ts`](src/backend/acs.ts)**, which owns `call`, the one place
  an untyped `ledgerApi` answer is cast, plus the ACS body and the two filter builders. A second
  inline `as` is a duplicated type, and a second hand-written `/v2/state/active-contracts` body is
  where the two template-id spellings below drift apart.
- **Two spellings of a template id, and each is rejected in the other's position.** A *filter*
  carries the package-name reference (`#canton-token-vault:Canton.TokenVault.Vault:Vault`); a
  *command* carries the resolved package id the deployment holds (`forgePkg`, `vaultPkg`). A filter
  given a resolved id reads empty in silence, which is the worse of the two failures.
- **A choice declared on an interface is exercised under the interface id**, not the template's:
  `AllocationFactory_Allocate` names
  `#splice-api-token-allocation-instruction-v1:…:AllocationFactory` with the `InstrumentConfig`'s
  contract id.
- **A filter travels in `query`, never spelled into `resource` as a query string.** A wallet is free
  to allowlist the resource against the ledger API's own route list, which a path carrying `?…`
  misses. A route's own path segments still interpolate.

## Where a disclosure comes from

Every write against an `InstrumentConfig` needs it disclosed, because a depositor is no stakeholder
of one. In production that blob comes from the token registry's HTTP API. **Here it is read off the
ledger**, because Carpincho reaches the participant through wallet-service, whose token can read as
the bootstrap parties. That is the same shortcut the vesting dApp takes for its factory, and it is
why this stack runs no registry process.

So a blob is read in exactly one place, the deployment load. A second reader is what would make
swapping the registry back in a rewrite rather than a one-module change.

## The deposit queue

A request is read through the **`AllocationRequest` interface**, never its own template: the view is
what carries the settlement and the leg, and those are copied out of it verbatim into the allocate
command. Rebuilding either from the request's own fields is the failure `*_Settle` asserts against.

That filter matches every `AllocationRequest` on the ledger, a withdraw request and a foreign
package's alike, so [`backend/requests.ts`](src/backend/requests.ts) scopes the queue twice: the
settlement's `executor` must be this vault, and the view must name the `deposit` leg.

Whether a leg is already funded comes off the depositor's own `Allocation` views, matched on the
settlement reference and the leg id, which is the same pair the settle choice compares. All three
reads share one offset: at three offsets an allocation could show for a request the queue had not
seen, and the queue would offer to fund a leg twice.

## The vault party is not a wallet account

Both `*_Settle` choices are controlled by it, and a withdraw needs it to allocate its own payout
leg, so it is participant-hosted and `scripts/vault-operator.mjs` acts as it. **Nothing in this
package submits as the vault**, and a component that wants to is a bug: the browser's only
submitter is the wallet, acting as the account the user connected.
