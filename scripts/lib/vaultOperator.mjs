// The vault side's decisions, kept apart from the loop that acts on them so they can be tested
// without a ledger. Nothing here does I/O and nothing here holds state: every choice the operator
// exercises is consuming, so the ledger is the only lock it needs.

import { isDeepStrictEqual } from 'node:util'

/** The leg ids the two settle choices compare against, and the keys their views file legs under. */
export const LEGS = {
  deposit: 'deposit',
  payout: 'withdraw-underlying-out',
  shares: 'withdraw-shares-in',
}

// Every ledger amount is a `Numeric 10`, so this is the scale every comparison happens at.
const PRECISION = 10
const DECIMAL = /^\d+(\.\d+)?$/

const PREFIX = { deposit: 'dep', withdraw: 'wd' }

/**
 * The settlement reference an accept mints. Carries the proposal it came from, so two proposals
 * accepted in one tick cannot share a reference and be told apart afterwards only by amount.
 */
export const requestIdFor = (kind, contractId, stamp) =>
  `${PREFIX[kind]}-${stamp}-${contractId.slice(0, 10)}`

/** A ledger amount as a scaled integer, which is the only exact way to compare two. */
export const scaled = (value) => {
  const text = String(value)
  if (!DECIMAL.test(text)) return undefined
  const [int, frac = ''] = text.split('.')
  if (frac.length > PRECISION) return undefined
  return BigInt(`${int}${frac.padEnd(PRECISION, '0')}`)
}

const createdOf = (row) => row?.contractEntry?.JsActiveContract?.createdEvent

/** A proposal is only ever accepted, so its amount is for the log and its id for the choice. */
export const proposalsFrom = (rows, kind, vault) =>
  (Array.isArray(rows) ? rows : []).flatMap((row) => {
    const created = createdOf(row)
    const arg = created?.createArgument
    if (created?.contractId === undefined || arg?.vault !== vault) return []
    return [{ amount: arg.amount, contractId: created.contractId, kind }]
  })

// Which choreography a request belongs to, off the legs its view names rather than off its template
// id: the legs are what the settle choice compares, so they cannot disagree with it.
const kindOf = (legs) => {
  if (legs[LEGS.deposit] !== undefined) return 'deposit'
  return legs[LEGS.shares] !== undefined ? 'withdraw' : undefined
}

/**
 * The requests the vault owes something on, off their `AllocationRequest` views rather than their
 * template fields: the view is what the settle choice compares an allocation against, so a rebuilt
 * settlement or leg is the one failure the operator could cause on its own. Every leg is kept,
 * because a withdraw's payout leg is the vault's own to fund.
 */
export const requestsFrom = (rows, vault) =>
  (Array.isArray(rows) ? rows : []).flatMap((row) => {
    const created = createdOf(row)
    const view = created?.interfaceViews?.[0]?.viewValue
    const settlement = view?.settlement
    const legs = view?.transferLegs
    if (created?.contractId === undefined || settlement === undefined || legs === undefined)
      return []
    if (settlement.executor !== vault) return []
    const kind = kindOf(legs)
    if (kind === undefined) return []
    return [
      {
        contractId: created.contractId,
        kind,
        legs,
        requestId: settlement.settlementRef?.id,
        settlement,
      },
    ]
  })

/**
 * The escrow comes off the view too: it is the disclosure a settle cannot go without. It carries
 * the party that can read it, which is the admin of the leg's own instrument, because that admin
 * signs every `LockedToken` of it. A withdraw's two escrows are two different instruments, so one
 * requesting party cannot read both.
 */
export const allocationsFrom = (rows) =>
  (Array.isArray(rows) ? rows : []).flatMap((row) => {
    const created = createdOf(row)
    const view = created?.interfaceViews?.[0]?.viewValue
    const allocation = view?.allocation
    const cid = view?.holdingCids?.[0]
    const admin = allocation?.transferLeg?.instrumentId?.admin
    if (created?.contractId === undefined || allocation === undefined) return []
    if (typeof cid !== 'string' || typeof admin !== 'string') return []
    return [
      {
        contractId: created.contractId,
        escrow: { admin, cid },
        requestId: allocation.settlement?.settlementRef?.id,
        settlement: allocation.settlement,
        transferLeg: allocation.transferLeg,
        transferLegId: allocation.transferLegId,
      },
    ]
  })

// Matched on the whole of what a settle choice compares: the settlement record, the leg id and the
// leg record. A match on the reference alone would submit a settle the ledger then refuses.
const allocationFor = (allocations, request, legId) =>
  allocations.find(
    (allocation) =>
      allocation.transferLegId === legId &&
      allocation.requestId === request.requestId &&
      isDeepStrictEqual(allocation.settlement, request.settlement) &&
      isDeepStrictEqual(allocation.transferLeg, request.legs[legId]),
  )

/**
 * The withdraws whose payout leg the vault still owes, and only those whose shares leg the
 * depositor has already funded. Allocating before that would escrow the vault's own underlying
 * against a withdraw nobody may ever fund, and it would stay escrowed until `settleBefore`.
 */
export const payoutToAllocate = ({ allocations, requests }) =>
  requests.flatMap((request) => {
    if (request.kind !== 'withdraw') return []
    if (allocationFor(allocations, request, LEGS.shares) === undefined) return []
    if (allocationFor(allocations, request, LEGS.payout) !== undefined) return []
    const transferLeg = request.legs[LEGS.payout]
    if (transferLeg === undefined) return []
    // Verbatim out of the view, as the depositor's own allocation is.
    return [
      {
        request,
        spec: { settlement: request.settlement, transferLeg, transferLegId: LEGS.payout },
      },
    ]
  })

/**
 * The requests ready to settle: a deposit once its one leg is funded, a withdraw once both are.
 * Each carries the escrows the submission has to disclose, since the vault is a stakeholder of
 * neither.
 */
export const pairForSettle = ({ allocations, requests }) =>
  requests.flatMap((request) => {
    if (request.kind === 'deposit') {
      const funded = allocationFor(allocations, request, LEGS.deposit)
      return funded === undefined
        ? []
        : [
            {
              allocationCid: funded.contractId,
              escrows: [funded.escrow],
              kind: 'deposit',
              request,
            },
          ]
    }
    const shares = allocationFor(allocations, request, LEGS.shares)
    const payout = allocationFor(allocations, request, LEGS.payout)
    if (shares === undefined || payout === undefined) return []
    return [
      {
        escrows: [shares.escrow, payout.escrow],
        kind: 'withdraw',
        payoutAllocationCid: payout.contractId,
        request,
        shareAllocationCid: shares.contractId,
      },
    ]
  })

/**
 * The holdings to fund an allocation with, largest first so the command names as few as possible.
 * `undefined` when the vault's own unlocked holdings of that instrument do not cover the leg, which
 * a payout contending with another withdraw's escrow makes reachable.
 */
export const selectInputs = ({ amount, holdings, instrumentId }) => {
  const target = scaled(amount)
  if (target === undefined || target <= 0n) return undefined

  const candidates = holdings
    .filter(
      (holding) =>
        !holding.isLocked &&
        holding.instrumentId?.admin === instrumentId.admin &&
        holding.instrumentId?.id === instrumentId.id,
    )
    .map((holding) => ({ cid: holding.contractId, value: scaled(holding.amount) }))
    .filter((one) => one.value !== undefined)
    // By cid where two are equal, so one read always picks the same holdings.
    .sort((a, b) => (a.value === b.value ? (a.cid < b.cid ? -1 : 1) : a.value > b.value ? -1 : 1))

  const chosen = []
  let running = 0n
  for (const { cid, value } of candidates) {
    if (running >= target) break
    chosen.push(cid)
    running += value
  }
  return running >= target ? chosen : undefined
}

/**
 * Whether a failed submission is another actor having got there first. Every choice here is
 * consuming, so a second attempt on the same contract loses this way rather than double-spending,
 * and a tick that logs it and moves on is the whole of the concurrency handling.
 */
export const isRaceLost = (message) =>
  /CONTRACT_NOT_FOUND|CONTRACT_NOT_ACTIVE|LOCAL_VERDICT_LOCKED_CONTRACTS/.test(String(message))
