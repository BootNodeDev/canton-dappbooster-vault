import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  allocationsFrom,
  isRaceLost,
  LEGS,
  pairForSettle,
  payoutToAllocate,
  proposalsFrom,
  requestIdFor,
  requestsFrom,
  scaled,
  selectInputs,
} from './lib/vaultOperator.mjs'

const VAULT = 'vault-operator-1::abc'
const DEPOSITOR = 'nando::abc'

const settlement = (id, executor = VAULT) => ({
  executor,
  settlementRef: { cid: null, id },
  requestedAt: '2026-09-10T12:00:00Z',
  allocateBefore: '2026-09-10T13:00:00Z',
  settleBefore: '2026-09-10T14:00:00Z',
  meta: { values: {} },
})

const USDX = { admin: 'token-issuer-1::abc', id: 'USDX' }
const VSH = { admin: VAULT, id: 'VSH' }

const leg = (amount, sender = DEPOSITOR, receiver = VAULT, instrumentId = USDX) => ({
  sender,
  receiver,
  amount,
  instrumentId,
  meta: { values: {} },
})

const viewRow = (contractId, viewValue) => ({
  contractEntry: {
    JsActiveContract: { createdEvent: { contractId, interfaceViews: [{ viewValue }] } },
  },
})

const requestRow = (contractId, id, amount, executor = VAULT) =>
  viewRow(contractId, {
    settlement: settlement(id, executor),
    transferLegs: { deposit: leg(amount) },
    meta: { values: {} },
  })

// Two legs, and the payout one is the vault's own to fund.
const withdrawRow = (contractId, id, amount) =>
  viewRow(contractId, {
    settlement: settlement(id),
    transferLegs: {
      [LEGS.shares]: leg(amount, DEPOSITOR, VAULT, VSH),
      [LEGS.payout]: leg(amount, VAULT, DEPOSITOR, USDX),
    },
    meta: { values: {} },
  })

const allocationRow = (contractId, id, amount, overrides = {}) =>
  viewRow(contractId, {
    allocation: {
      settlement: settlement(id),
      transferLegId: 'deposit',
      transferLeg: leg(amount),
      ...overrides,
    },
    holdingCids: [`00escrow-${contractId}`],
    meta: { values: {} },
  })

const legAllocationRow = (contractId, id, amount, transferLegId) =>
  viewRow(contractId, {
    allocation: {
      settlement: settlement(id),
      transferLegId,
      transferLeg:
        transferLegId === LEGS.shares
          ? leg(amount, DEPOSITOR, VAULT, VSH)
          : leg(amount, VAULT, DEPOSITOR, USDX),
    },
    holdingCids: [`00escrow-${contractId}`],
    meta: { values: {} },
  })

describe('requestIdFor', () => {
  it('carries the proposal it came from, so one tick cannot mint two of the same', () => {
    // Scenario: a depositor with two open proposals for the same amount. On the stamp alone both
    // accepts would reference one settlement and nothing afterwards could tell them apart.
    const stamp = 1757000000000
    assert.notEqual(
      requestIdFor('deposit', '00aaaaaaaaaa11', stamp),
      requestIdFor('deposit', '00bbbbbbbbbb22', stamp),
    )
    assert.equal(requestIdFor('deposit', '00aaaaaaaaaa11', stamp), 'dep-1757000000000-00aaaaaaaa')
  })

  it('names the kind, so a log line says which choreography a reference belongs to', () => {
    assert.equal(
      requestIdFor('withdraw', '00aaaaaaaaaa11', 1757000000000),
      'wd-1757000000000-00aaaaaaaa',
    )
  })
})

describe('proposalsFrom', () => {
  it('takes the proposals naming this vault and leaves another vault alone', () => {
    const rows = [
      {
        contractEntry: {
          JsActiveContract: {
            createdEvent: {
              contractId: '00mine',
              createArgument: { amount: '25.0', depositor: DEPOSITOR, vault: VAULT },
            },
          },
        },
      },
      {
        contractEntry: {
          JsActiveContract: {
            createdEvent: {
              contractId: '00theirs',
              createArgument: { amount: '5.0', depositor: DEPOSITOR, vault: 'vault-2::abc' },
            },
          },
        },
      },
    ]

    assert.deepEqual(proposalsFrom(rows, 'deposit', VAULT), [
      { amount: '25.0', contractId: '00mine', kind: 'deposit' },
    ])
  })

  it('reports nothing for an answer that is not a list', () => {
    assert.deepEqual(proposalsFrom(undefined, 'deposit', VAULT), [])
  })
})

describe('requestsFrom', () => {
  it('reads the settlement and the leg off the view, not off the template', () => {
    // Scenario: the settle choice compares both field for field, so the view is the only source
    // that cannot disagree with what it will compare against.
    const [request] = requestsFrom([requestRow('00req', 'dep-1', '25.0')], VAULT)

    assert.equal(request.contractId, '00req')
    assert.equal(request.requestId, 'dep-1')
    assert.equal(request.kind, 'deposit')
    assert.deepEqual(request.settlement, settlement('dep-1'))
    assert.deepEqual(request.legs[LEGS.deposit], leg('25.0'))
  })

  // The legs its view names, not its template id: the legs are what the settle choice compares.
  it('reads a withdraw as a withdraw, keeping both of its legs', () => {
    const [request] = requestsFrom([withdrawRow('00wd', 'wd-1', '15.0')], VAULT)

    assert.equal(request.kind, 'withdraw')
    assert.deepEqual(request.legs[LEGS.shares], leg('15.0', DEPOSITOR, VAULT, VSH))
    assert.deepEqual(request.legs[LEGS.payout], leg('15.0', VAULT, DEPOSITOR, USDX))
  })

  it('drops a request another vault executes', () => {
    assert.deepEqual(
      requestsFrom([requestRow('00req', 'dep-1', '25.0', 'vault-2::abc')], VAULT),
      [],
    )
  })

  // The interface filter matches every AllocationRequest on the ledger, a foreign package's
  // included, and funding a leg the vault cannot settle would escrow against nothing.
  it('drops a request naming no leg it knows', () => {
    const rows = [
      viewRow('00other', {
        settlement: settlement('x-1'),
        transferLegs: { 'some-other-leg': leg('5.0') },
      }),
    ]

    assert.deepEqual(requestsFrom(rows, VAULT), [])
  })
})

describe('allocationsFrom', () => {
  it('carries the escrow and the party that can read it, which the settle cannot go without', () => {
    const [allocation] = allocationsFrom([allocationRow('00alloc', 'dep-1', '25.0')])

    assert.equal(allocation.contractId, '00alloc')
    assert.deepEqual(allocation.escrow, { admin: USDX.admin, cid: '00escrow-00alloc' })
    assert.equal(allocation.requestId, 'dep-1')
    assert.equal(allocation.transferLegId, 'deposit')
  })

  // A LockedToken is signed by the admin of its own instrument, so a withdraw's two escrows are
  // readable by two different parties and one requesting party cannot fetch both blobs.
  it('names the escrow admin per leg, which differs across a withdraw', () => {
    const [shares] = allocationsFrom([legAllocationRow('00sh', 'wd-1', '15.0', LEGS.shares)])
    const [payout] = allocationsFrom([legAllocationRow('00pay', 'wd-1', '15.0', LEGS.payout)])

    assert.equal(shares.escrow.admin, VSH.admin)
    assert.equal(payout.escrow.admin, USDX.admin)
  })

  it('drops an allocation whose leg names no instrument admin to read the escrow as', () => {
    const rows = [
      viewRow('00alloc', {
        allocation: { settlement: settlement('dep-1'), transferLegId: 'deposit', transferLeg: {} },
        holdingCids: ['00escrow'],
      }),
    ]

    assert.deepEqual(allocationsFrom(rows), [])
  })

  it('drops an allocation holding no escrow to disclose', () => {
    const rows = [
      viewRow('00alloc', {
        allocation: { settlement: settlement('dep-1'), transferLegId: 'deposit' },
        holdingCids: [],
      }),
    ]

    assert.deepEqual(allocationsFrom(rows), [])
  })
})

describe('pairForSettle', () => {
  const requests = requestsFrom([requestRow('00req', 'dep-1', '25.0')], VAULT)

  it('pairs a request with the allocation funding its deposit leg', () => {
    const allocations = allocationsFrom([allocationRow('00alloc', 'dep-1', '25.0')])

    assert.deepEqual(pairForSettle({ allocations, requests }), [
      {
        allocationCid: '00alloc',
        escrows: [{ admin: USDX.admin, cid: '00escrow-00alloc' }],
        kind: 'deposit',
        request: requests[0],
      },
    ])
  })

  it('leaves a request nothing has funded', () => {
    assert.deepEqual(pairForSettle({ allocations: [], requests }), [])
  })

  it('refuses an allocation naming another settlement reference', () => {
    const allocations = allocationsFrom([allocationRow('00alloc', 'dep-2', '25.0')])

    assert.deepEqual(pairForSettle({ allocations, requests }), [])
  })

  it('refuses an allocation for another leg of the same settlement', () => {
    const allocations = allocationsFrom([
      allocationRow('00alloc', 'dep-1', '25.0', { transferLegId: 'withdraw-shares-in' }),
    ])

    assert.deepEqual(pairForSettle({ allocations, requests }), [])
  })

  // Matching on the reference alone would submit a settle the ledger then refuses, which reads as
  // an operator bug rather than as an allocation that never matched.
  it('refuses an allocation whose leg differs by amount alone', () => {
    const allocations = allocationsFrom([allocationRow('00alloc', 'dep-1', '24.9999999999')])

    assert.deepEqual(pairForSettle({ allocations, requests }), [])
  })

  it('refuses an allocation whose settlement differs by a deadline alone', () => {
    const drifted = allocationRow('00alloc', 'dep-1', '25.0')
    drifted.contractEntry.JsActiveContract.createdEvent.interfaceViews[0].viewValue.allocation.settlement.settleBefore =
      '2026-09-10T15:00:00Z'

    assert.deepEqual(pairForSettle({ allocations: allocationsFrom([drifted]), requests }), [])
  })

  // Both legs, and the escrows of both: the withdraw choice archives each of them, even though it
  // forwards extraArgs only to the payout leg.
  it('waits for both legs of a withdraw, then carries both escrows', () => {
    const withdraws = requestsFrom([withdrawRow('00wd', 'wd-1', '15.0')], VAULT)
    const shares = legAllocationRow('00sh', 'wd-1', '15.0', LEGS.shares)
    const payout = legAllocationRow('00pay', 'wd-1', '15.0', LEGS.payout)

    assert.deepEqual(
      pairForSettle({ allocations: allocationsFrom([shares]), requests: withdraws }),
      [],
    )
    assert.deepEqual(
      pairForSettle({ allocations: allocationsFrom([payout]), requests: withdraws }),
      [],
    )
    assert.deepEqual(
      pairForSettle({ allocations: allocationsFrom([shares, payout]), requests: withdraws }),
      [
        {
          escrows: [
            { admin: VSH.admin, cid: '00escrow-00sh' },
            { admin: USDX.admin, cid: '00escrow-00pay' },
          ],
          kind: 'withdraw',
          payoutAllocationCid: '00pay',
          request: withdraws[0],
          shareAllocationCid: '00sh',
        },
      ],
    )
  })

  it('pairs each of two requests with its own allocation', () => {
    const both = requestsFrom(
      [requestRow('00r1', 'dep-1', '25.0'), requestRow('00r2', 'dep-2', '10.0')],
      VAULT,
    )
    const allocations = allocationsFrom([
      allocationRow('00a2', 'dep-2', '10.0'),
      allocationRow('00a1', 'dep-1', '25.0'),
    ])

    assert.deepEqual(
      pairForSettle({ allocations, requests: both }).map((pair) => [
        pair.request.requestId,
        pair.allocationCid,
      ]),
      [
        ['dep-1', '00a1'],
        ['dep-2', '00a2'],
      ],
    )
  })
})

describe('payoutToAllocate', () => {
  const withdraws = requestsFrom([withdrawRow('00wd', 'wd-1', '15.0')], VAULT)

  // Allocating before the depositor has funded the shares leg would escrow the vault's own
  // underlying against a withdraw nobody may ever complete, and it would stay escrowed until
  // settleBefore.
  it('owes nothing until the depositor has funded the shares leg', () => {
    assert.deepEqual(payoutToAllocate({ allocations: [], requests: withdraws }), [])
  })

  it('owes the payout leg once the shares leg is funded, copied out of the view', () => {
    const allocations = allocationsFrom([legAllocationRow('00sh', 'wd-1', '15.0', LEGS.shares)])

    assert.deepEqual(payoutToAllocate({ allocations, requests: withdraws }), [
      {
        request: withdraws[0],
        spec: {
          settlement: settlement('wd-1'),
          transferLeg: leg('15.0', VAULT, DEPOSITOR, USDX),
          transferLegId: LEGS.payout,
        },
      },
    ])
  })

  it('owes nothing once it has already funded the payout leg', () => {
    const allocations = allocationsFrom([
      legAllocationRow('00sh', 'wd-1', '15.0', LEGS.shares),
      legAllocationRow('00pay', 'wd-1', '15.0', LEGS.payout),
    ])

    assert.deepEqual(payoutToAllocate({ allocations, requests: withdraws }), [])
  })

  it('owes nothing on a deposit, whose one leg belongs to the depositor', () => {
    const allocations = allocationsFrom([allocationRow('00alloc', 'dep-1', '25.0')])
    const deposits = requestsFrom([requestRow('00req', 'dep-1', '25.0')], VAULT)

    assert.deepEqual(payoutToAllocate({ allocations, requests: deposits }), [])
  })
})

describe('scaled', () => {
  it('compares on the integer, so no float decides whether an amount is covered', () => {
    assert.equal(scaled('1.5'), 15000000000n)
    assert.equal(scaled('0.0000000001'), 1n)
  })

  it('refuses a value it cannot hold exactly', () => {
    assert.equal(scaled('0.00000000001'), undefined)
    assert.equal(scaled('lots'), undefined)
  })
})

describe('selectInputs', () => {
  const holding = (contractId, amount, extra = {}) => ({
    amount,
    contractId,
    instrumentId: USDX,
    isLocked: false,
    ...extra,
  })

  it('takes the largest holdings first and stops once the leg is covered', () => {
    assert.deepEqual(
      selectInputs({
        amount: '15.0',
        holdings: [holding('00a', '10.0'), holding('00b', '40.0'), holding('00c', '5.0')],
        instrumentId: USDX,
      }),
      ['00b'],
    )
  })

  // A payout contending with another withdraw's escrow is what makes this reachable, and the vault
  // is never under-collateralised otherwise: every share was minted against a deposit.
  it('reports undefined when the unlocked holdings fall short', () => {
    assert.equal(
      selectInputs({
        amount: '15.0',
        holdings: [holding('00a', '100.0', { isLocked: true }), holding('00b', '5.0')],
        instrumentId: USDX,
      }),
      undefined,
    )
  })

  it('ignores another instrument, even one holding plenty', () => {
    assert.deepEqual(
      selectInputs({
        amount: '15.0',
        holdings: [holding('00a', '100.0', { instrumentId: VSH }), holding('00b', '20.0')],
        instrumentId: USDX,
      }),
      ['00b'],
    )
  })
})

describe('isRaceLost', () => {
  it('reads a consumed contract as another actor having got there first', () => {
    assert.ok(isRaceLost('CONTRACT_NOT_FOUND(11,abc): Contract could not be found'))
    assert.ok(isRaceLost('LOCAL_VERDICT_LOCKED_CONTRACTS(2,abc)'))
  })

  it('leaves anything else to be reported', () => {
    assert.equal(isRaceLost('PERMISSION_DENIED'), false)
    assert.equal(isRaceLost('allocation transfer leg mismatch'), false)
  })
})
