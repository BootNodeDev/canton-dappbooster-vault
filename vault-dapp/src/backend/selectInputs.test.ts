import type { Holding } from '@bootnodedev/canton-dappbooster'
import { describe, expect, it } from 'vitest'
import { selectInputs } from '@/backend/selectInputs'

const USDX = { admin: 'token-issuer-1::ns', id: 'USDX' }
const VSH = { admin: 'vault-operator-1::ns', id: 'VSH' }

const holding = (cid: string, amount: string, extra: Partial<Holding> = {}): Holding => ({
  amount,
  contractId: cid,
  instrumentId: USDX,
  isLocked: false,
  ...extra,
})

describe('selectInputs', () => {
  it('takes the largest holdings first and stops once the amount is covered', () => {
    // Scenario: a 25 deposit against three holdings. 40 alone covers it, so the other two are left
    // unspent rather than archived for nothing.
    expect(
      selectInputs({
        amount: '25.0',
        holdings: [holding('00a', '10.0'), holding('00b', '40.0'), holding('00c', '5.0')],
        instrumentId: USDX,
      }),
    ).toEqual(['00b'])
  })

  it('adds holdings until they cover the amount', () => {
    expect(
      selectInputs({
        amount: '25.0',
        holdings: [holding('00a', '10.0'), holding('00b', '20.0'), holding('00c', '5.0')],
        instrumentId: USDX,
      }),
    ).toEqual(['00b', '00a'])
  })

  it('never spends a locked holding, which is escrowed against another settlement', () => {
    expect(
      selectInputs({
        amount: '25.0',
        holdings: [holding('00a', '100.0', { isLocked: true }), holding('00b', '25.0')],
        instrumentId: USDX,
      }),
    ).toEqual(['00b'])
  })

  it('ignores another instrument, even one holding plenty', () => {
    expect(
      selectInputs({
        amount: '25.0',
        holdings: [holding('00a', '100.0', { instrumentId: VSH }), holding('00b', '30.0')],
        instrumentId: USDX,
      }),
    ).toEqual(['00b'])
  })

  // A read a moment old is what makes this reachable from a form that ceilings on the balance.
  it('reports undefined when the spendable holdings fall short', () => {
    expect(
      selectInputs({
        amount: '25.0',
        holdings: [holding('00a', '10.0'), holding('00b', '14.9999999999')],
        instrumentId: USDX,
      }),
    ).toBeUndefined()
  })

  it('covers an amount its holdings meet exactly, to the last of ten places', () => {
    // The comparison is on scaled integers, so a sum that lands exactly on the target covers it.
    expect(
      selectInputs({
        amount: '0.0000000003',
        holdings: [holding('00a', '0.0000000001'), holding('00b', '0.0000000002')],
        instrumentId: USDX,
      }),
    ).toEqual(['00b', '00a'])
  })

  it('reports undefined for an amount no holding could cover', () => {
    expect(
      selectInputs({ amount: '0.0', holdings: [holding('00a', '10.0')], instrumentId: USDX }),
    ).toBeUndefined()
    expect(
      selectInputs({ amount: 'lots', holdings: [holding('00a', '10.0')], instrumentId: USDX }),
    ).toBeUndefined()
  })

  it('picks the same holdings twice over when two carry the same amount', () => {
    // The ACS read carries no order guarantee, so without the tie-break the two would swap between
    // reads and a resubmission would contend with a different pair.
    const holdings = [holding('00b', '25.0'), holding('00a', '25.0')]

    expect(selectInputs({ amount: '25.0', holdings, instrumentId: USDX })).toEqual(['00a'])
    expect(
      selectInputs({ amount: '25.0', holdings: [...holdings].reverse(), instrumentId: USDX }),
    ).toEqual(['00a'])
  })
})
