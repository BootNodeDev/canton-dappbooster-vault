import { TokenInput, tokenKey, useTokenList, validateAmount } from '@bootnodedev/canton-dappbooster'
import { useState } from 'react'
import type { RequestKind } from '@/backend/commands'
import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import { FieldError } from '@/components/FieldError'
import { useParty } from '@/hooks/useParty'
import { useBackend } from '@/providers/Backend'
import { useVaultStore } from '@/store/useVaultStore'
import { displayAmount, isPositive } from '@/utils/amount'
import { AMOUNT_ERROR_TEXT } from '@/utils/amountErrorText'
import { errorText } from '@/utils/errorText'
import { toast } from '@/utils/toast'

const TITLE: Record<RequestKind, string> = { deposit: 'Deposit', withdraw: 'Withdraw' }

// Both kinds are the same form pointed the other way round: one sends the underlying and receives
// shares, the other the reverse, and the vault is 1:1 either way.
export const ProposalForm = ({ kind }: { kind: RequestKind }): React.JSX.Element | null => {
  const { backend, deployment } = useBackend()
  const { party } = useParty()
  const { tokens } = useTokenList()
  const deposit = useVaultStore((state) => state.deposit)
  const withdraw = useVaultStore((state) => state.withdraw)
  const [raw, setRaw] = useState('')
  const [pending, setPending] = useState(false)

  const partyId = party?.partyId
  if (backend === undefined || deployment === undefined || partyId === undefined) {
    return null
  }

  const { share, underlying } = deployment
  const [send, receive] = kind === 'deposit' ? [underlying, share] : [share, underlying]
  const errorId = `${kind}-amount-error`
  const balance = tokens.find(
    (token) => tokenKey(token.instrumentId) === tokenKey({ admin: send.admin, id: send.id }),
  )?.balance
  // Recomputed from the balance rather than kept from the last keystroke: the poll moves the
  // ceiling, so a stored code would keep flagging an amount that is now affordable.
  const amountError = validateAmount(raw, balance === undefined ? {} : { max: balance })
  const message = amountError === undefined ? undefined : AMOUNT_ERROR_TEXT[amountError]
  const valid = amountError === undefined && isPositive(raw)

  // A field error belongs on the field; a submission that failed is an event and belongs in a
  // toast, which is also the only place a participant refusal can be read in full and copied.
  const submit = async (): Promise<void> => {
    setPending(true)
    try {
      await (kind === 'deposit' ? deposit : withdraw)(backend, partyId, raw)
      setRaw('')
      toast.success(`Proposed a ${kind} of ${displayAmount(raw)} ${send.symbol}`)
    } catch (err: unknown) {
      toast.error(errorText(err))
    } finally {
      setPending(false)
    }
  }

  return (
    <Card className="p-5">
      <h2 className="mb-3 text-base font-bold">{TITLE[kind]}</h2>
      <TokenInput
        aria-describedby={message === undefined ? undefined : errorId}
        balance={balance}
        balanceState={balance === undefined ? 'loading' : undefined}
        className="border-0 p-0"
        id={`${kind}-amount`}
        label={`Your ${send.symbol}`}
        onChange={(next) => setRaw(next)}
        token={{ symbol: send.symbol }}
        // The field renders `~$0.00` for an unset value, which reads as a price of zero. This
        // stack quotes no instrument, so it says so.
        usdValue="Not Available"
        value={raw}
      />
      {message !== undefined && <FieldError id={errorId} message={message} className="mt-2" />}
      <Button
        className="mt-5 w-full"
        size="sm"
        disabled={!valid}
        pending={pending}
        onClick={() => void submit()}
      >
        {`${TITLE[kind]} ${send.symbol}`}
      </Button>
      <p className="mt-3 text-xs text-fg-muted">
        {`The vault accepts the proposal, then you fund it. You get ${receive.symbol} one for one.`}
      </p>
    </Card>
  )
}
