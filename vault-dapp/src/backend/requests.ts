// The request queue, read as the connected party. The depositor is a signatory of its own request
// and of the `TokenAllocation` funding it, so the browser sees both without the operator's help.
//
// A deposit and a withdraw are one code path here. Both are read through the same
// `AllocationRequest` interface, and in both the party owes exactly the leg it is the sender of, so
// nothing needs to know which kind it is looking at until the UI comes to label it.

import {
  type AcsEntry,
  interfaceFilter,
  type LedgerApi,
  ledgerEnd,
  readAcs,
  templateFilter,
  viewOf,
} from '@/backend/acs'
import type { AllocationSpec, RequestKind } from '@/backend/commands'
import { VAULT_PACKAGE } from '@/backend/deployment'

// The leg ids the two settle choices compare against, which are also the keys their views file
// their legs under. A leg named anything else belongs to a package this app does not drive.
const KIND_BY_LEG: Record<string, RequestKind> = {
  deposit: 'deposit',
  'withdraw-shares-in': 'withdraw',
}

const PROPOSAL_FILTERS: Record<RequestKind, string> = {
  deposit: `#${VAULT_PACKAGE}:Canton.TokenVault.DepositProposal:DepositProposal`,
  withdraw: `#${VAULT_PACKAGE}:Canton.TokenVault.WithdrawProposal:WithdrawProposal`,
}

const REQUEST_FILTER =
  '#splice-api-token-allocation-request-v1:Splice.Api.Token.AllocationRequestV1:AllocationRequest'
const ALLOCATION_FILTER = '#splice-api-token-allocation-v1:Splice.Api.Token.AllocationV1:Allocation'

/** A proposal the vault has not answered yet. The party that made it can still cancel it. */
export type VaultProposal = {
  amount: string
  contractId: string
  kind: RequestKind
}

/**
 * An accepted request, with the allocation spec copied out of its `AllocationRequest` view and
 * `allocated` saying whether this party has already funded the leg it owes. `instrumentId` is that
 * leg's own, which is what decides the factory the allocation is exercised on.
 */
export type VaultRequest = {
  allocateBefore: string
  allocated: boolean
  amount: string
  contractId: string
  instrumentId: { admin: string; id: string }
  kind: RequestKind
  requestId: string
  requestedAt: string
  settleBefore: string
  spec: AllocationSpec
}

export type VaultRequests = {
  proposals: readonly VaultProposal[]
  requests: readonly VaultRequest[]
}

type SettlementValue = {
  allocateBefore?: string
  executor?: string
  requestedAt?: string
  settleBefore?: string
  settlementRef?: { id?: string }
}

type TransferLegValue = {
  amount?: string
  instrumentId?: { admin?: string; id?: string }
  sender?: string
}

type RequestView = {
  settlement?: SettlementValue
  transferLegs?: Record<string, TransferLegValue | undefined>
}

type AllocationValue = {
  allocation?: { settlement?: SettlementValue; transferLegId?: string }
}

type ProposalArgument = { amount?: string; vault?: string }

// One key per funded leg, which is the pair a settle choice matches on.
const legKey = (requestId: string, transferLegId: string): string =>
  JSON.stringify([requestId, transferLegId])

const allocatedLegs = (entries: readonly AcsEntry[]): Set<string> => {
  const keys = new Set<string>()
  for (const entry of entries) {
    const { allocation } = (viewOf(entry) ?? {}) as AllocationValue
    const requestId = allocation?.settlement?.settlementRef?.id
    const transferLegId = allocation?.transferLegId
    if (requestId !== undefined && transferLegId !== undefined) {
      keys.add(legKey(requestId, transferLegId))
    }
  }
  return keys
}

// The party owes the leg it sends, and only that one: a withdraw's payout leg is the vault's to
// fund. Exactly one, so a request naming this party as sender twice is left alone rather than
// half-funded on a guess.
const senderLeg = (
  legs: Record<string, TransferLegValue | undefined>,
  party: string,
): { kind: RequestKind; leg: TransferLegValue; transferLegId: string } | undefined => {
  const owed = Object.entries(legs).filter(([, leg]) => leg?.sender === party)
  const [transferLegId, leg] = owed[0] ?? []
  if (owed.length !== 1 || transferLegId === undefined || leg === undefined) return undefined
  const kind = KIND_BY_LEG[transferLegId]
  return kind === undefined ? undefined : { kind, leg, transferLegId }
}

// Scoped to this vault by the settlement's executor: the interface filter matches every
// AllocationRequest on the ledger, a foreign package's included.
const toRequest = (
  entry: AcsEntry,
  { allocated, party, vault }: { allocated: Set<string>; party: string; vault: string },
): VaultRequest | undefined => {
  const view = viewOf(entry) as RequestView | undefined
  const settlement = view?.settlement
  const { contractId } = entry.event
  const requestId = settlement?.settlementRef?.id
  if (settlement === undefined || contractId === undefined) return undefined
  if (settlement.executor !== vault || requestId === undefined) return undefined

  const owed = senderLeg(view?.transferLegs ?? {}, party)
  if (owed === undefined) return undefined
  const { admin, id } = owed.leg.instrumentId ?? {}
  if (admin === undefined || id === undefined) return undefined

  const { allocateBefore, requestedAt, settleBefore } = settlement
  if (allocateBefore === undefined || requestedAt === undefined || settleBefore === undefined) {
    return undefined
  }
  return {
    allocateBefore,
    allocated: allocated.has(legKey(requestId, owed.transferLegId)),
    amount: owed.leg.amount ?? '0',
    contractId,
    instrumentId: { admin, id },
    kind: owed.kind,
    requestId,
    requestedAt,
    settleBefore,
    // Both halves verbatim out of the view: the settle choice compares them field for field.
    spec: { settlement, transferLeg: owed.leg, transferLegId: owed.transferLegId },
  }
}

const toProposal = (
  entry: AcsEntry,
  kind: RequestKind,
  vault: string,
): VaultProposal | undefined => {
  const { amount, vault: named } = (entry.event.createArgument ?? {}) as ProposalArgument
  const { contractId } = entry.event
  if (contractId === undefined || amount === undefined || named !== vault) return undefined
  return { amount, contractId, kind }
}

/** Everything the queue shows for one party, read at a single offset. */
export const readVaultRequests = async (
  ledgerApi: LedgerApi,
  { party, vault }: { party: string; vault: string },
): Promise<VaultRequests> => {
  const offset = await ledgerEnd(ledgerApi)
  const [deposits, withdrawals, requests, allocations] = await Promise.all([
    readAcs(ledgerApi, { filter: templateFilter(PROPOSAL_FILTERS.deposit), offset, party }),
    readAcs(ledgerApi, { filter: templateFilter(PROPOSAL_FILTERS.withdraw), offset, party }),
    readAcs(ledgerApi, { filter: interfaceFilter(REQUEST_FILTER), offset, party }),
    readAcs(ledgerApi, { filter: interfaceFilter(ALLOCATION_FILTER), offset, party }),
  ])
  const allocated = allocatedLegs(allocations)
  return {
    proposals: [
      ...deposits.flatMap((entry) => toProposal(entry, 'deposit', vault) ?? []),
      ...withdrawals.flatMap((entry) => toProposal(entry, 'withdraw', vault) ?? []),
    ],
    requests: requests.flatMap((entry) => toRequest(entry, { allocated, party, vault }) ?? []),
  }
}
