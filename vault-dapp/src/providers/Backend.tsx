import { useExecute, useLedger, useParty } from '@bootnodedev/canton-connect'
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react'
import { type Deployment, loadDeployment } from '@/backend/deployment'
import { LedgerBackend } from '@/backend/LedgerBackend'
import type { VaultBackend } from '@/backend/VaultBackend'
import { errorText } from '@/utils/errorText'

// `deployment` is undefined until the wallet reports a party, because it is itself an on-ledger
// read: pages render a connect prompt rather than empty data. So a page with no deployment and
// nothing pending can only mean no party.
export interface BackendState {
  backend: VaultBackend | undefined
  deployment: Deployment | undefined
  loadError: string | undefined
  loadPending: boolean
  sessionPending: boolean
}

// canton-connect cannot say whether a restore is still in flight: its status sits at `idle` both
// before `sdk.init()` resolves and forever after when there was no session to restore. So a page
// waits this long for a party to appear before concluding there is none, which is what stops the
// connect card flashing on every reload.
const SESSION_GRACE_MS = 1500

const BackendContext = createContext<BackendState | undefined>(undefined)

export const Backend = ({ children }: { children: ReactNode }): React.JSX.Element => {
  const [deployment, setDeployment] = useState<Deployment | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const { execute } = useExecute()
  const { ledgerApi } = useLedger()
  // A restored-but-locked session reports `connected` with no party, so the party is the gate: it
  // is what every read filters on and every submit acts as. Only its existence, though: depending
  // on the object would re-read the ledger whenever the wallet re-pushes the same account.
  const { party } = useParty()
  const hasParty = party !== undefined
  const [checkingSession, setCheckingSession] = useState(true)

  useEffect(() => {
    const timer = setTimeout(() => setCheckingSession(false), SESSION_GRACE_MS)
    return () => clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (!hasParty) {
      return
    }
    let cancelled = false

    void loadDeployment(ledgerApi).then(
      (loaded) => {
        if (!cancelled) {
          setDeployment(loaded)
        }
      },
      (err: unknown) => {
        if (!cancelled) {
          setLoadError(errorText(err))
        }
      },
    )

    return () => {
      cancelled = true
    }
  }, [hasParty, ledgerApi])

  // Its own memo, because the grace timer below flips a purely visual flag: sharing one would
  // mint a new backend identity mid-session and re-run every read that keys off it.
  const backend = useMemo(
    () =>
      deployment === undefined ? undefined : new LedgerBackend(deployment, { execute, ledgerApi }),
    [deployment, execute, ledgerApi],
  )

  const value = useMemo<BackendState>(
    () => ({
      backend,
      deployment,
      loadError,
      loadPending: hasParty && deployment === undefined && loadError === undefined,
      sessionPending: checkingSession && !hasParty,
    }),
    [backend, checkingSession, deployment, hasParty, loadError],
  )

  return <BackendContext.Provider value={value}>{children}</BackendContext.Provider>
}

export const useBackend = (): BackendState => {
  const state = useContext(BackendContext)
  if (state === undefined) {
    throw new Error('useBackend must be used within a Backend')
  }
  return state
}
