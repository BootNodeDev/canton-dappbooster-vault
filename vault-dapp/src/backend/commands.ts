// JSON-Ledger-API v2 command builders. No I/O, so they are unit-tested directly.
//
// A command names a template by the resolved package id the deployment holds, never the
// `#package-name` reference a filter takes: the prepare-and-execute path the wallet signs needs a
// concrete package. An interface id is the exception, since no upgrade resolves it.

import type { Instrument } from '@/backend/deployment'
import type { DisclosedContract, LedgerCommand } from '@/backend/wallet'

/** Which of the vault's two choreographies a proposal or request belongs to. */
export type RequestKind = 'deposit' | 'withdraw'

const CONFIG_ENTITY = 'Canton.TokenForge.Registry:InstrumentConfig'

// The two proposals carry identical fields and differ only in the template they create and the
// cancel they offer, which is the whole of what a kind decides here.
const PROPOSAL_ENTITY: Record<RequestKind, string> = {
  deposit: 'Canton.TokenVault.DepositProposal:DepositProposal',
  withdraw: 'Canton.TokenVault.WithdrawProposal:WithdrawProposal',
}

const CANCEL_CHOICE: Record<RequestKind, string> = {
  deposit: 'DepositProposal_Cancel',
  withdraw: 'WithdrawProposal_Cancel',
}

// An interface id, so it carries the package-name reference where a template id would carry the
// resolved package: an interface is the one thing a command names by name.
const ALLOCATION_FACTORY =
  '#splice-api-token-allocation-instruction-v1:Splice.Api.Token.AllocationInstructionV1:AllocationFactory'

// `emptyChoiceContext` and `emptyMetadata` as JSON-LF: both are a record around a TextMap.
const EMPTY_EXTRA_ARGS = { context: { values: {} }, meta: { values: {} } }

const exercise = (
  templateId: string,
  contractId: string,
  choice: string,
  choiceArgument: Record<string, unknown>,
): LedgerCommand => ({ ExerciseCommand: { templateId, contractId, choice, choiceArgument } })

/**
 * Self-service mint from an instrument's faucet, capped per tap by the instrument's own
 * `maxPerTap`. Controlled by the tapping party alone, which is what a depositor can do unaided.
 */
export const buildTapCommand = ({
  amount,
  forgePkg,
  instrument,
  user,
}: {
  amount: string
  forgePkg: string
  instrument: Instrument
  user: string
}): LedgerCommand =>
  exercise(`${forgePkg}:${CONFIG_ENTITY}`, instrument.configCid, 'InstrumentConfig_Tap', {
    user,
    amount,
  })

/**
 * The disclosure any write against an instrument needs: the tapping or allocating party is no
 * stakeholder of the `InstrumentConfig`, so the participant cannot read it for them.
 */
export const instrumentDisclosure = (
  instrument: Instrument,
  forgePkg: string,
): DisclosedContract => ({
  contractId: instrument.configCid,
  createdEventBlob: instrument.configBlob,
  templateId: `${forgePkg}:${CONFIG_ENTITY}`,
})

/**
 * A settlement and the one leg being funded, lifted out of a request's `AllocationRequest` view.
 * Both halves stay opaque on purpose: `*_Settle` compares them field for field, so they are
 * carried through verbatim and never rebuilt from the request's own fields.
 */
export type AllocationSpec = {
  settlement: unknown
  transferLeg: unknown
  transferLegId: string
}

/** The depositor's ask, which the vault turns into a request by accepting it. */
export const buildProposalCommand = ({
  amount,
  depositor,
  kind,
  vault,
  vaultPkg,
}: {
  amount: string
  depositor: string
  kind: RequestKind
  vault: string
  vaultPkg: string
}): LedgerCommand => ({
  CreateCommand: {
    createArguments: { amount, depositor, vault },
    templateId: `${vaultPkg}:${PROPOSAL_ENTITY[kind]}`,
  },
})

/** Withdraws a proposal the vault has not accepted yet. Controlled by the depositor alone. */
export const buildCancelProposalCommand = ({
  kind,
  proposalCid,
  vaultPkg,
}: {
  kind: RequestKind
  proposalCid: string
  vaultPkg: string
}): LedgerCommand =>
  exercise(`${vaultPkg}:${PROPOSAL_ENTITY[kind]}`, proposalCid, CANCEL_CHOICE[kind], {})

/**
 * Escrows the depositor's holdings against one leg of a request. Exercised on the instrument's
 * `InstrumentConfig` under the `AllocationFactory` interface, which is where the choice is declared.
 */
export const buildAllocateCommand = ({
  inputHoldingCids,
  instrument,
  requestedAt,
  spec,
}: {
  inputHoldingCids: readonly string[]
  instrument: Instrument
  requestedAt: string
  spec: AllocationSpec
}): LedgerCommand =>
  exercise(ALLOCATION_FACTORY, instrument.configCid, 'AllocationFactory_Allocate', {
    allocation: spec,
    expectedAdmin: instrument.admin,
    extraArgs: EMPTY_EXTRA_ARGS,
    inputHoldingCids: [...inputHoldingCids],
    requestedAt,
  })
