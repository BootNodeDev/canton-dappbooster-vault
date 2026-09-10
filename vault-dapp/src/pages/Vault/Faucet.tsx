import { useState } from 'react'
import { Button } from '@/components/Button'
import { useParty } from '@/hooks/useParty'
import { useBackend } from '@/providers/Backend'
import { useTokenFigures } from '@/providers/Tokens'
import { displayAmount } from '@/utils/amount'
import { errorText } from '@/utils/errorText'
import { toast } from '@/utils/toast'

// The faucet's own per-tap cap, which the instrument enforces: a larger amount is refused
// on-ledger rather than trimmed.
const TAP_AMOUNT = '1000.0'

export const Faucet = (): React.JSX.Element | null => {
  const { backend, deployment } = useBackend()
  const { party } = useParty()
  const { refresh } = useTokenFigures()
  const [pending, setPending] = useState(false)

  // An instrument with no faucet offers nothing to press.
  if (backend === undefined || deployment === undefined || !deployment.underlying.hasFaucet) {
    return null
  }
  const partyId = party?.partyId
  if (partyId === undefined) {
    return null
  }

  const tap = async (): Promise<void> => {
    setPending(true)
    try {
      await backend.tap(partyId, TAP_AMOUNT)
      refresh()
      toast.success(`Got ${displayAmount(TAP_AMOUNT)} ${deployment.underlying.symbol}`)
    } catch (err: unknown) {
      toast.error(errorText(err))
    } finally {
      setPending(false)
    }
  }

  return (
    <Button size="sm" pending={pending} onClick={() => void tap()}>
      {`Get ${displayAmount(TAP_AMOUNT)} ${deployment.underlying.symbol}`}
    </Button>
  )
}
