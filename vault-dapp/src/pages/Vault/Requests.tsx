import { useState } from 'react'
import type { RequestKind } from '@/backend/commands'
import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import { EmptyState } from '@/components/EmptyState'
import { Loading } from '@/components/Loading'
import { useParty } from '@/hooks/useParty'
import { useBackend } from '@/providers/Backend'
import { useVaultStore } from '@/store/useVaultStore'
import { displayAmount } from '@/utils/amount'
import { errorText } from '@/utils/errorText'
import { type QueueRow, type QueueState, queueRows } from '@/utils/requestState'
import { toast } from '@/utils/toast'

// The state reaches assistive tech as this sentence rather than as the badge's colour.
const STATE_TEXT: Record<QueueState, string> = {
  awaiting_allocation: 'Waiting for your funds',
  awaiting_vault: 'Waiting for the vault',
  expired: 'Expired',
  settling: 'Funded, the vault is settling',
}

const STATE_TONE: Record<QueueState, string> = {
  awaiting_allocation: 'border-primary text-primary-strong',
  awaiting_vault: 'border-border-strong text-fg-muted',
  expired: 'border-danger text-danger',
  settling: 'border-border-strong text-fg',
}

const ACTION_TEXT = { allocate: 'Fund', cancel: 'Cancel' }

const KIND_TEXT: Record<RequestKind, string> = { deposit: 'Deposit', withdraw: 'Withdraw' }

const Row = ({
  row,
  onAct,
  pending,
  symbol,
}: {
  onAct: (row: QueueRow) => void
  pending: boolean
  row: QueueRow
  symbol: string
}): React.JSX.Element => (
  <li className="flex flex-wrap items-center gap-3 border-b border-border py-3 last:border-0">
    <span className="w-20 shrink-0 text-sm text-fg-muted">{KIND_TEXT[row.kind]}</span>
    <span className="font-mono text-sm font-bold tabular-nums" title={row.amount}>
      {`${displayAmount(row.amount)} ${symbol}`}
    </span>
    <span className={`rounded-full border px-2 py-0.5 text-xs ${STATE_TONE[row.state]}`}>
      {STATE_TEXT[row.state]}
    </span>
    <span className="ml-auto">
      {row.action === 'none' ? null : (
        <Button
          // Several rows carry the same verb, so the row's own figure is what tells them apart.
          aria-label={`${ACTION_TEXT[row.action]} the ${displayAmount(row.amount)} ${symbol} ${KIND_TEXT[
            row.kind
          ].toLowerCase()}`}
          size="sm"
          variant={row.action === 'cancel' ? 'secondary' : 'primary'}
          pending={pending}
          onClick={() => onAct(row)}
        >
          {ACTION_TEXT[row.action]}
        </Button>
      )}
    </span>
  </li>
)

export const Requests = (): React.JSX.Element | null => {
  const { backend, deployment } = useBackend()
  const { party } = useParty()
  // Selected one by one rather than as the whole store: the poll flips `loading` every tick, and
  // subscribing to it would re-render the queue with nothing about it changed.
  const allocate = useVaultStore((state) => state.allocate)
  const cancel = useVaultStore((state) => state.cancel)
  const error = useVaultStore((state) => state.error)
  const loaded = useVaultStore((state) => state.loaded)
  const proposals = useVaultStore((state) => state.proposals)
  const requests = useVaultStore((state) => state.requests)
  const [acting, setActing] = useState<string>()

  const partyId = party?.partyId
  if (backend === undefined || deployment === undefined || partyId === undefined) {
    return null
  }

  // The instrument a row's own leg is denominated in, which a proposal has yet to carry: a deposit
  // sends the underlying and a withdraw the shares, either stage.
  const symbolOf = (kind: RequestKind): string =>
    kind === 'deposit' ? deployment.underlying.symbol : deployment.share.symbol

  // Read at render: the windows run to the hour, so nothing here needs a ticking clock.
  const rows = queueRows({ proposals, requests }, Date.now())

  const act = async (row: QueueRow): Promise<void> => {
    setActing(row.contractId)
    try {
      if (row.stage === 'proposal') {
        await cancel(backend, partyId, row.proposal)
        toast.success(`Cancelled the ${displayAmount(row.amount)} ${row.kind}`)
      } else {
        await allocate(backend, partyId, row.request)
        toast.success(`Funded the ${displayAmount(row.amount)} ${row.kind}`)
      }
    } catch (err: unknown) {
      toast.error(errorText(err))
    } finally {
      setActing(undefined)
    }
  }

  if (!loaded && error === undefined) {
    return <Loading />
  }

  return (
    <Card className="p-5">
      <h2 className="mb-1 text-base font-bold">Requests</h2>
      {/* Inline rather than a toast: this describes the list itself, and the rows beside it are
          as old as the last read that worked. */}
      {error !== undefined && (
        <p role="alert" className="mb-2 text-sm text-danger">
          {`Could not read the queue, so these rows may be stale. ${error}`}
        </p>
      )}
      {rows.length === 0 ? (
        <EmptyState
          title="No requests"
          description="A deposit or a withdraw shows up here until it settles."
        />
      ) : (
        <ul>
          {rows.map((row) => (
            <Row
              key={row.contractId}
              row={row}
              symbol={symbolOf(row.kind)}
              pending={acting === row.contractId}
              onAct={(one) => void act(one)}
            />
          ))}
        </ul>
      )}
    </Card>
  )
}
