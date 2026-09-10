import { describe, expect, it } from 'vitest'
import { displayAmount } from '@/utils/amount'

describe('displayAmount', () => {
  // A ledger amount is Numeric 10 and a constant in this app is written with one place, so the
  // same figure reached the screen two ways before this existed.
  it('shows two places whatever the input carries', () => {
    expect(displayAmount('1000.0000000000')).toBe('1,000.00')
    expect(displayAmount('1000.0')).toBe('1,000.00')
    expect(displayAmount('0')).toBe('0.00')
  })

  // Rounding up would show a balance the party does not have, and the amount fields ceiling on it.
  it('truncates rather than rounds', () => {
    expect(displayAmount('0.129')).toBe('0.12')
    expect(displayAmount('9.999')).toBe('9.99')
  })

  it('groups the whole part', () => {
    expect(displayAmount('1234567.5')).toBe('1,234,567.50')
  })
})
