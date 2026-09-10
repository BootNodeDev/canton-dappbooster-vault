#!/usr/bin/env node
// The vault's backstage signer. Both `*_Settle` choices are controlled by the vault party and a
// withdraw needs it to allocate its own payout leg, so it cannot be a wallet account: it is
// participant-hosted and driven here over wallet-service's /rpc, as the vesting operator is.
//
// No local state, and none needed. `DepositProposal_Accept` and `DepositRequest_Settle` are both
// consuming, so two ticks racing over one contract end with the loser getting CONTRACT_NOT_FOUND.
// Every command id carries a fresh stamp for that reason: a reused one would be deduplicated by
// the participant instead, and a genuine retry would then be dropped in silence.
//
// A withdraw is the same loop with one extra step: the vault funds the payout leg itself, and only
// once the depositor has funded the shares leg, so the vault's own underlying is never escrowed
// against a withdraw nobody completes.
//
// Run with the local stack up, wallet-service answering, both DARs deployed and the bootstrap done.

import {
  allocationsFrom,
  isRaceLost,
  pairForSettle,
  payoutToAllocate,
  proposalsFrom,
  requestIdFor,
  requestsFrom,
  selectInputs,
} from './lib/vaultOperator.mjs'

const RPC_URL = process.env.RPC_URL ?? 'http://localhost:3010/rpc'
const POLL_MS = Number(process.env.VAULT_OPERATOR_POLL_MS ?? 3000)
const VAULT_HINT = 'vault-operator-'
const FORGE_PACKAGE = 'canton-token-forge'
const VAULT_PACKAGE = 'canton-token-vault'

const VAULT_FILTER = `#${VAULT_PACKAGE}:Canton.TokenVault.Vault:Vault`
const CONFIG_FILTER = `#${FORGE_PACKAGE}:Canton.TokenForge.Registry:InstrumentConfig`
const PROPOSAL_ENTITY = {
  deposit: 'Canton.TokenVault.DepositProposal:DepositProposal',
  withdraw: 'Canton.TokenVault.WithdrawProposal:WithdrawProposal',
}

const PROPOSAL_FILTERS = {
  deposit: `#${VAULT_PACKAGE}:${PROPOSAL_ENTITY.deposit}`,
  withdraw: `#${VAULT_PACKAGE}:${PROPOSAL_ENTITY.withdraw}`,
}

const REQUEST_ENTITY = {
  deposit: 'Canton.TokenVault.DepositRequest:DepositRequest',
  withdraw: 'Canton.TokenVault.WithdrawRequest:WithdrawRequest',
}

const ACCEPT_CHOICE = {
  deposit: 'DepositProposal_Accept',
  withdraw: 'WithdrawProposal_Accept',
}

const SETTLE_CHOICE = {
  deposit: 'DepositRequest_Settle',
  withdraw: 'WithdrawRequest_Settle',
}

const HOLDING_FILTER = '#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding'

// An interface id, so it carries the package-name reference where a template id would carry the
// resolved package: an interface is the one thing a command names by name.
const ALLOCATION_FACTORY =
  '#splice-api-token-allocation-instruction-v1:Splice.Api.Token.AllocationInstructionV1:AllocationFactory'
const REQUEST_FILTER =
  '#splice-api-token-allocation-request-v1:Splice.Api.Token.AllocationRequestV1:AllocationRequest'
const ALLOCATION_FILTER = '#splice-api-token-allocation-v1:Splice.Api.Token.AllocationV1:Allocation'

const EMPTY_EXTRA_ARGS = { context: { values: {} }, meta: { values: {} } }

const log = (message) => process.stdout.write(`[vault-operator] ${message}\n`)
const warn = (message) => process.stderr.write(`[vault-operator] ${message}\n`)

const rpc = async (method, params) => {
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${text.slice(0, 400)}`)
  }
  const payload = JSON.parse(text)
  if (payload.error !== undefined) {
    throw new Error(text.slice(0, 600))
  }
  return payload.result
}

const ledger = (requestMethod, resource, body, query) =>
  rpc('ledgerApi', {
    requestMethod,
    resource,
    ...(body === undefined ? {} : { body }),
    ...(query === undefined ? {} : { query }),
  })

// A filter carries the package-name reference. Given a resolved package id it reads empty in
// silence, which is the worse of the two failures.
const templateFilter = (templateId, blob = false) => ({
  identifierFilter: { TemplateFilter: { value: { templateId, includeCreatedEventBlob: blob } } },
})

const interfaceFilter = (interfaceId) => ({
  identifierFilter: { InterfaceFilter: { value: { interfaceId, includeInterfaceView: true } } },
})

const readAcs = async (party, filter) => {
  const end = await ledger('get', '/v2/state/ledger-end')
  if (end?.offset === undefined) {
    throw new Error('the ledger returned no offset')
  }
  const rows = await ledger('post', '/v2/state/active-contracts', {
    filter: { filtersByParty: { [party]: { cumulative: [filter] } } },
    activeAtOffset: end.offset,
    verbose: true,
  })
  return Array.isArray(rows) ? rows : []
}

const submit = (commandId, actAs, commands, disclosedContracts = []) =>
  ledger('post', '/v2/commands/submit-and-wait-for-transaction-tree', {
    commandId,
    actAs: [actAs],
    readAs: [actAs],
    commands,
    disclosedContracts,
  })

// The same newest-wins rule the dApp discovers by, so both land on one bootstrap run's vault.
const discover = async () => {
  const userId = (await ledger('get', '/v2/authenticated-user'))?.user?.id
  if (typeof userId !== 'string' || userId === '') {
    throw new Error('the participant reported no authenticated user')
  }
  const { rights } = await ledger('get', `/v2/users/${userId}/rights`)
  const vault = (rights ?? [])
    .map((right) => right?.kind?.CanActAs?.value?.party)
    .filter((party) => typeof party === 'string' && party.startsWith(VAULT_HINT))
    .sort()
    .at(-1)
  if (vault === undefined) {
    throw new Error('no vault operator party on this ledger: run pnpm run bootstrap-vault')
  }

  const vaultRow = (await readAcs(vault, templateFilter(VAULT_FILTER)))
    .map((row) => row?.contractEntry?.JsActiveContract?.createdEvent)
    .find((created) => created?.createArgument?.vault === vault)
  if (vaultRow === undefined) {
    throw new Error(`no Vault owned by ${vault}: run pnpm run bootstrap-vault`)
  }

  // Both instruments come off the Vault rather than off a party hint, so one run's vault can never
  // be paired with another run's issuer.
  const { instrumentId, vaultInstrumentId } = vaultRow.createArgument
  const shareRow = (await readAcs(vaultInstrumentId.admin, templateFilter(CONFIG_FILTER)))
    .map((row) => row?.contractEntry?.JsActiveContract?.createdEvent)
    .find((created) => created?.createArgument?.instrumentId === vaultInstrumentId.id)
  if (shareRow === undefined) {
    throw new Error(`no ${vaultInstrumentId.id} instrument config: run pnpm run bootstrap-vault`)
  }

  // The payout allocation is exercised on the underlying's own config, which the vault is no
  // stakeholder of, so its blob is read here alongside the id.
  const underlyingRow = (await readAcs(instrumentId.admin, templateFilter(CONFIG_FILTER, true)))
    .map((row) => row?.contractEntry?.JsActiveContract?.createdEvent)
    .find((created) => created?.createArgument?.instrumentId === instrumentId.id)
  if (underlyingRow?.createdEventBlob === undefined) {
    throw new Error(
      `no disclosable ${instrumentId.id} instrument config: run pnpm run bootstrap-vault`,
    )
  }

  const resolve = async (name) => {
    const pkg = await ledger(
      'get',
      '/v2/interactive-submission/preferred-package-version',
      undefined,
      { 'package-name': name, parties: vault },
    )
    const id = pkg?.packagePreference?.packageReference?.packageId
    if (typeof id !== 'string' || id === '') {
      throw new Error(`the participant knows no package named ${name}`)
    }
    return id
  }

  return {
    forgePkg: await resolve(FORGE_PACKAGE),
    shareFactoryCid: shareRow.contractId,
    synchronizerId: vaultRow.synchronizerId,
    underlying: {
      admin: instrumentId.admin,
      blob: underlyingRow.createdEventBlob,
      configCid: underlyingRow.contractId,
      id: instrumentId.id,
    },
    vault,
    vaultCid: vaultRow.contractId,
    vaultPkg: await resolve(VAULT_PACKAGE),
  }
}

const exercise = (templateId, contractId, choice, choiceArgument) => ({
  ExerciseCommand: { templateId, contractId, choice, choiceArgument },
})

const accept = async (deployment, proposal) => {
  const stamp = Date.now()
  const { kind } = proposal
  const requestId = requestIdFor(kind, proposal.contractId, stamp)
  await submit(`op-accept-${requestId}-${stamp}`, deployment.vault, [
    exercise(
      `${deployment.vaultPkg}:${PROPOSAL_ENTITY[kind]}`,
      proposal.contractId,
      ACCEPT_CHOICE[kind],
      { requestId, vaultCid: deployment.vaultCid },
    ),
  ])
  log(`accepted ${kind} of ${proposal.amount} as ${requestId}`)
}

// The escrow is a LockedToken the vault is not always a stakeholder of, so the settle cannot read
// it without the blob. Requested as the admin of that leg's own instrument, which signs every
// holding of it: a withdraw escrows shares on one leg and the underlying on the other, and no
// single party can read both.
const escrowDisclosure = async (deployment, { admin: party, cid: escrowCid }) => {
  const found = await ledger('post', '/v2/events/events-by-contract-id', {
    contractId: escrowCid,
    requestingParties: [party],
    eventFormat: {
      filtersByParty: {
        [party]: {
          cumulative: [
            { identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: true } } } },
          ],
        },
      },
      verbose: true,
    },
  })
  const created = found?.created?.createdEvent
  if (created?.createdEventBlob === undefined) {
    throw new Error(`no disclosable escrow at ${escrowCid}`)
  }
  return {
    contractId: escrowCid,
    createdEventBlob: created.createdEventBlob,
    templateId: created.templateId,
    ...(deployment.synchronizerId === undefined
      ? {}
      : { synchronizerId: deployment.synchronizerId }),
  }
}

// The withdraw choice hardcodes an empty context for the share leg and forwards extraArgs only to
// the payout leg, but both escrows are still archived by it, so both go on the submission.
const settleArgument = (deployment, pair) =>
  pair.kind === 'deposit'
    ? {
        allocationCid: pair.allocationCid,
        shareFactoryCid: deployment.shareFactoryCid,
        extraArgs: EMPTY_EXTRA_ARGS,
      }
    : {
        shareAllocationCid: pair.shareAllocationCid,
        payoutAllocationCid: pair.payoutAllocationCid,
        shareFactoryCid: deployment.shareFactoryCid,
        extraArgs: EMPTY_EXTRA_ARGS,
      }

const settle = async (deployment, pair) => {
  const stamp = Date.now()
  const { kind, request } = pair
  const disclosed = await Promise.all(
    pair.escrows.map((escrow) => escrowDisclosure(deployment, escrow)),
  )
  await submit(
    `op-settle-${request.requestId}-${stamp}`,
    deployment.vault,
    [
      exercise(
        `${deployment.vaultPkg}:${REQUEST_ENTITY[kind]}`,
        request.contractId,
        SETTLE_CHOICE[kind],
        settleArgument(deployment, pair),
      ),
    ],
    disclosed,
  )
  log(`settled ${kind} ${request.requestId}`)
}

const vaultHoldings = async (deployment) =>
  (await readAcs(deployment.vault, interfaceFilter(HOLDING_FILTER))).flatMap((row) => {
    const created = row?.contractEntry?.JsActiveContract?.createdEvent
    const view = created?.interfaceViews?.[0]?.viewValue
    if (view === undefined) return []
    return [
      {
        amount: view.amount,
        contractId: created.contractId,
        instrumentId: view.instrumentId,
        isLocked: view.lock !== null && view.lock !== undefined,
      },
    ]
  })

// The vault is the sender of the payout leg, so it funds it from its own holdings of the
// underlying, with that instrument's config disclosed exactly as a depositor's allocation is.
const allocatePayout = async (deployment, { request, spec }) => {
  const stamp = Date.now()
  const { underlying } = deployment
  const holdings = await vaultHoldings(deployment)
  const inputHoldingCids = selectInputs({
    amount: spec.transferLeg.amount,
    holdings,
    instrumentId: { admin: underlying.admin, id: underlying.id },
  })
  if (inputHoldingCids === undefined) {
    throw new Error(`not enough ${underlying.id} held to pay out ${spec.transferLeg.amount}`)
  }
  await submit(
    `op-payout-${request.requestId}-${stamp}`,
    deployment.vault,
    [
      exercise(ALLOCATION_FACTORY, underlying.configCid, 'AllocationFactory_Allocate', {
        allocation: spec,
        expectedAdmin: underlying.admin,
        extraArgs: EMPTY_EXTRA_ARGS,
        inputHoldingCids,
        // The request's own timestamp: the factory asserts the allocation was requested in the
        // past, and this process's clock is not the participant's.
        requestedAt: request.settlement.requestedAt,
      }),
    ],
    [
      {
        contractId: underlying.configCid,
        createdEventBlob: underlying.blob,
        templateId: `${deployment.forgePkg}:Canton.TokenForge.Registry:InstrumentConfig`,
        ...(deployment.synchronizerId === undefined
          ? {}
          : { synchronizerId: deployment.synchronizerId }),
      },
    ],
  )
  log(`funded the payout leg of ${request.requestId} for ${spec.transferLeg.amount}`)
}

// One item failing is one item's problem: a lost race is expected, and anything else is still no
// reason to stop signing for the others.
const attempt = async (what, action) => {
  try {
    await action()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (isRaceLost(message)) {
      log(`${what}: already taken, skipping`)
      return
    }
    // Truncated: a participant refusal carries its whole trace context, and this line repeats
    // every tick for as long as the cause lasts.
    warn(`${what}: ${message.slice(0, 300)}`)
  }
}

const tick = async (deployment) => {
  const { vault } = deployment

  for (const kind of ['deposit', 'withdraw']) {
    const rows = await readAcs(vault, templateFilter(PROPOSAL_FILTERS[kind]))
    for (const proposal of proposalsFrom(rows, kind, vault)) {
      await attempt(`accept ${kind} ${proposal.contractId.slice(0, 10)}`, () =>
        accept(deployment, proposal),
      )
    }
  }

  const requests = requestsFrom(await readAcs(vault, interfaceFilter(REQUEST_FILTER)), vault)
  if (requests.length === 0) {
    return
  }
  const allocations = allocationsFrom(await readAcs(vault, interfaceFilter(ALLOCATION_FILTER)))

  // The payout leg first: a withdraw funded this tick can then settle in the next one, rather than
  // waiting a whole period for the read to notice its own allocation.
  for (const owed of payoutToAllocate({ allocations, requests })) {
    await attempt(`payout ${owed.request.requestId}`, () => allocatePayout(deployment, owed))
  }

  for (const pair of pairForSettle({ allocations, requests })) {
    await attempt(`settle ${pair.request.requestId}`, () => settle(deployment, pair))
  }
}

const main = async () => {
  const deployment = await discover()
  log(`vault   ${deployment.vault}`)
  log(`vaultCid ${deployment.vaultCid}`)
  log(`shares  ${deployment.shareFactoryCid}`)
  log(`polling every ${POLL_MS}ms, ctrl-c to stop`)

  let stop = false
  // The wait between ticks is interruptible, so a SIGTERM is answered at once rather than after up
  // to a whole poll period. dev-stack sends SIGTERM then SIGKILL, and the gap is not generous.
  let wake = () => {}
  const waitOrWake = () =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, POLL_MS)
      wake = () => {
        clearTimeout(timer)
        resolve()
      }
    })

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      stop = true
      log(`${signal}, stopping`)
      wake()
    })
  }

  // Sequential rather than on an interval: a tick that outruns the period would otherwise overlap
  // itself and race its own submissions.
  while (!stop) {
    await attempt('tick', () => tick(deployment))
    if (stop) break
    await waitOrWake()
  }
  log('stopped')
}

main().catch((err) => {
  warn(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
