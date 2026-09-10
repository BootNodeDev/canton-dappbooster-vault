import { Identifier } from '@bootnodedev/canton-dappbooster'
import { type ReactNode, useEffect, useRef } from 'react'
import type { Instrument } from '@/backend/deployment'
import { Card } from '@/components/Card'
import { ConnectPrompt } from '@/components/ConnectPrompt'
import { Balances } from '@/pages/Vault/Balances'
import { Faucet } from '@/pages/Vault/Faucet'
import { ProposalForm } from '@/pages/Vault/ProposalForm'
import { Requests } from '@/pages/Vault/Requests'
import { useBackend } from '@/providers/Backend'
import { useTokenFigures } from '@/providers/Tokens'
import { useVault, useVaultStore } from '@/store/useVaultStore'

const Row = ({ label, children }: { children: ReactNode; label: string }): React.JSX.Element => (
  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border py-2 last:border-0">
    <dt className="w-40 shrink-0 text-sm text-fg-muted">{label}</dt>
    <dd className="min-w-0 text-sm">{children}</dd>
  </div>
)

const InstrumentCard = ({
  instrument,
  kind,
}: {
  instrument: Instrument
  kind: string
}): React.JSX.Element => (
  <Card className="p-5">
    <h2 className="mb-3 text-base font-bold">
      {instrument.symbol} <span className="font-normal text-fg-muted">· {kind}</span>
    </h2>
    <dl>
      <Row label="Name">{instrument.name}</Row>
      <Row label="Admin">
        <Identifier value={instrument.admin} label="admin party id" />
      </Row>
      <Row label="Config">
        <Identifier value={instrument.configCid} label="instrument config id" />
      </Row>
      <Row label="Decimals">{instrument.decimals}</Row>
      <Row label="Faucet">{instrument.hasFaucet ? 'yes' : 'no'}</Row>
    </dl>
  </Card>
)

// What the queue looks like, so a change to it can be told from a poll that found nothing new. A
// settle archives the request and a mint lands a holding in the same transaction, so the queue
// changing is exactly when the balances have.
const signatureOf = (rows: readonly { allocated?: boolean; contractId: string }[]): string =>
  rows.map((row) => `${row.contractId}:${row.allocated === true}`).join('|')

export const Vault = (): React.JSX.Element => {
  const { deployment } = useBackend()
  // Once per page: this is what reads the queue and keeps polling it.
  useVault()
  const proposals = useVaultStore((state) => state.proposals)
  const requests = useVaultStore((state) => state.requests)
  const { refresh: refreshFigures } = useTokenFigures()
  const signature = `${signatureOf(proposals)}/${signatureOf(requests)}`
  const seen = useRef<string>(undefined)

  // Only on a change, never on the timer itself: a figure blanks while its read is in flight, and
  // re-reading every tick would flash every balance on the page.
  useEffect(() => {
    const previous = seen.current
    seen.current = signature
    if (previous !== undefined && previous !== signature) {
      refreshFigures()
    }
  }, [refreshFigures, signature])

  // The shell holds the page until the read has answered either way, so a missing deployment here
  // can only mean a missing party.
  if (deployment === undefined) {
    return <ConnectPrompt />
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-xl font-bold">Vault</h1>
        <Faucet />
      </div>
      <Balances />
      <div className="grid gap-6 lg:grid-cols-2">
        <ProposalForm kind="deposit" />
        <ProposalForm kind="withdraw" />
      </div>
      <Requests />
      <Card className="p-5">
        <dl>
          <Row label="Vault party">
            <Identifier value={deployment.vault} label="vault party id" />
          </Row>
          <Row label="Vault contract">
            <Identifier value={deployment.vaultCid} label="vault contract id" />
          </Row>
          <Row label="Synchronizer">
            {deployment.synchronizerId === undefined ? (
              'not reported'
            ) : (
              <Identifier value={deployment.synchronizerId} label="synchronizer id" />
            )}
          </Row>
          <Row label="Vault package">
            <Identifier value={deployment.vaultPkg} label="vault package id" />
          </Row>
          <Row label="Registry package">
            <Identifier value={deployment.forgePkg} label="registry package id" />
          </Row>
        </dl>
      </Card>
      <div className="grid gap-6 sm:grid-cols-2">
        <InstrumentCard instrument={deployment.underlying} kind="underlying" />
        <InstrumentCard instrument={deployment.share} kind="shares" />
      </div>
    </div>
  )
}
