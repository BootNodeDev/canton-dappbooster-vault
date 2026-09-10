import { afterEach, describe, expect, it } from 'vitest'
import { toast, toaster } from '@/utils/toast'

describe('toast lifetime', () => {
  afterEach(() => {
    toaster.remove()
  })

  it('lets a plain toast time out on the shared duration', () => {
    toast.success('Deposited 25.00 USDX')
    expect(toaster.getVisibleToasts()[0].duration).toBe(3200)
  })

  // A participant refusal is long and usually has to be copied somewhere before it can be acted
  // on, which a toast that vanishes on a timer makes impossible.
  it('keeps an error until it is dismissed', () => {
    toast.error('Wallet refused the submission')
    expect(toaster.getVisibleToasts()[0].duration).toBe(Number.POSITIVE_INFINITY)
  })
})
