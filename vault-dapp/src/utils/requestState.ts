// The one place a proposal or a request becomes a state and the action it owes, so the badge, the
// button and the empty states cannot disagree.

import type { RequestKind } from '@/backend/commands'
import type { VaultProposal, VaultRequest, VaultRequests } from '@/backend/requests'

export type QueueState = 'awaiting_allocation' | 'awaiting_vault' | 'expired' | 'settling'

export type QueueAction = 'allocate' | 'cancel' | 'none'

// Two axes, and both are needed to render a row: `stage` says whether the vault has answered yet
// and so which action is owed, `kind` which choreography the amount belongs to.
export type QueueRow =
  | {
      action: 'cancel'
      amount: string
      contractId: string
      kind: RequestKind
      proposal: VaultProposal
      stage: 'proposal'
      state: 'awaiting_vault'
    }
  | {
      action: QueueAction
      amount: string
      contractId: string
      kind: RequestKind
      request: VaultRequest
      stage: 'request'
      state: QueueState
    }

// A deadline that will not parse is treated as still open, so the row keeps offering its action and
// the ledger says no rather than the queue hiding a request on a value it failed to read.
const passed = (deadline: string, nowMs: number): boolean => {
  const at = Date.parse(deadline)
  return !Number.isNaN(at) && nowMs >= at
}

/**
 * Once allocated, the vault owes the settle and the window is `settleBefore`; before that the
 * depositor owes the allocation and the window is `allocateBefore`. Past either the request is
 * dead: no choice on it can be exercised any more.
 */
export const requestState = (request: VaultRequest, nowMs: number): QueueState => {
  if (request.allocated) {
    return passed(request.settleBefore, nowMs) ? 'expired' : 'settling'
  }
  return passed(request.allocateBefore, nowMs) ? 'expired' : 'awaiting_allocation'
}

const requestRow = (request: VaultRequest, nowMs: number): QueueRow => {
  const state = requestState(request, nowMs)
  return {
    action: state === 'awaiting_allocation' ? 'allocate' : 'none',
    amount: request.amount,
    contractId: request.contractId,
    kind: request.kind,
    request,
    stage: 'request',
    state,
  }
}

const proposalRow = (proposal: VaultProposal): QueueRow => ({
  action: 'cancel',
  amount: proposal.amount,
  contractId: proposal.contractId,
  kind: proposal.kind,
  proposal,
  stage: 'proposal',
  state: 'awaiting_vault',
})

// Descending, and the ACS read carries no order guarantee, so without this rows would jump position
// between refreshes. A request id carries the timestamp the vault accepted at, so newest first.
const byKeyDesc = (a: string, b: string): number => (a < b ? 1 : a > b ? -1 : 0)

/**
 * The queue as the page renders it: proposals first, since the vault has yet to see them, then
 * requests newest first.
 */
export const queueRows = ({ proposals, requests }: VaultRequests, nowMs: number): QueueRow[] => [
  ...[...proposals]
    .sort((a, b) => byKeyDesc(a.contractId, b.contractId))
    .map((proposal) => proposalRow(proposal)),
  ...[...requests]
    .sort((a, b) => byKeyDesc(a.requestId, b.requestId))
    .map((request) => requestRow(request, nowMs)),
]
