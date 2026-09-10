import {
  mergeTokens,
  type PartialToken,
  sumHoldings,
  type Token,
  TokenListProvider,
  tokenKey,
} from '@bootnodedev/canton-dappbooster'
import { useHoldings } from '@bootnodedev/canton-dappbooster/connect'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { Instrument } from '@/backend/deployment'
import { useBackend } from '@/providers/Backend'

// Labels come off the two InstrumentConfigs the vault names, which is this stack's whole
// catalogue: there is no curated asset list and no registry HTTP API to ask.
const fromDeployment = (instruments: readonly Instrument[]): readonly PartialToken[] =>
  instruments.map(({ admin, id, name, symbol }) => ({
    instrumentId: { admin, id },
    name,
    symbol,
  }))

// A row carries a figure or it does not, so a read that failed and one still running look the same
// on it. This is what tells them apart, and what lets a field say so.
export interface TokenFigures {
  failed: boolean
  refresh: () => void
  /** What the vault holds of the underlying, the figure a depositor's shares are backed by. */
  tvl: string | undefined
}

const FiguresContext = createContext<TokenFigures | undefined>(undefined)

export const Tokens = ({ children }: { children: ReactNode }): React.JSX.Element => {
  const { error: holdingsError, holdings, refetch: refetchHoldings } = useHoldings()
  const { backend, deployment } = useBackend()
  const [tvl, setTvl] = useState<string>()
  const [tvlFailed, setTvlFailed] = useState(false)
  // Only the newest read may report. Bumped on unmount too, so a read in flight then lands nowhere.
  const newest = useRef(0)

  // The vault's own holdings, read as the vault party rather than the connected one, which the
  // participant allows because the bootstrap granted this user rights on it.
  const readTvl = useCallback((): void => {
    newest.current += 1
    const request = newest.current
    setTvl(undefined)
    setTvlFailed(false)
    if (backend === undefined || deployment === undefined) return
    const underlying = deployment.underlying
    backend.holdingsOf(deployment.vault).then(
      (held) => {
        if (request !== newest.current) return
        const row = sumHoldings(held).find(
          ({ instrumentId }) =>
            tokenKey(instrumentId) === tokenKey({ admin: underlying.admin, id: underlying.id }),
        )
        setTvl(row?.balance ?? '0')
      },
      () => {
        if (request === newest.current) setTvlFailed(true)
      },
    )
  }, [backend, deployment])

  useEffect(() => {
    readTvl()
    return () => {
      newest.current += 1
    }
  }, [readTvl])

  // Its identity moves with the session and not with the figures, so a caller can ask for a read on
  // mount without a failed one asking again forever.
  const refresh = useCallback(() => {
    readTvl()
    refetchHoldings()
  }, [readTvl, refetchHoldings])

  const figures = useMemo<TokenFigures>(
    () => ({ failed: tvlFailed || holdingsError !== undefined, refresh, tvl }),
    [holdingsError, refresh, tvl, tvlFailed],
  )

  const tokens = useMemo<readonly Token[]>(() => {
    if (deployment === undefined) return []
    const instruments = [deployment.underlying, deployment.share]
    // Scoped to this vault's two instruments rather than to everything the party holds: a token
    // from an earlier deployment shares an id under a different admin, and a row for it here
    // would read as this vault's.
    const keys = new Set(instruments.map(({ admin, id }) => tokenKey({ admin, id })))
    const held = sumHoldings(holdings ?? []).filter(({ instrumentId }) =>
      keys.has(tokenKey(instrumentId)),
    )
    const rows = mergeTokens([fromDeployment(instruments), held])
    // The read enumerates every holding, so once it answers, a token missing from it is one the
    // party holds none of rather than one nobody asked about.
    if (holdings === undefined) return rows
    return rows.map((row) => (row.balance === undefined ? { ...row, balance: '0' } : row))
  }, [deployment, holdings])

  return (
    <FiguresContext.Provider value={figures}>
      <TokenListProvider tokens={tokens}>{children}</TokenListProvider>
    </FiguresContext.Provider>
  )
}

export const useTokenFigures = (): TokenFigures => {
  const state = useContext(FiguresContext)
  if (state === undefined) {
    throw new Error('useTokenFigures must be used within a Tokens')
  }
  return state
}
