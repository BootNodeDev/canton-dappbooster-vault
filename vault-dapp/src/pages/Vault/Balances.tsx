import { useTokenList } from '@bootnodedev/canton-dappbooster'
import { Card } from '@/components/Card'
import { useTokenFigures } from '@/providers/Tokens'
import { displayAmount } from '@/utils/amount'

// The exact value goes in the title, since the figure itself is truncated to two places.
const Figure = ({
  exact,
  label,
  value,
}: {
  exact?: string
  label: string
  value: string
}): React.JSX.Element => (
  <div className="flex flex-col gap-1">
    <span className="text-sm text-fg-muted">{label}</span>
    <span className="font-mono text-xl font-bold tabular-nums" title={exact}>
      {value}
    </span>
  </div>
)

// A row carries no figure both while its read is in flight and after one fails, so the two are
// told apart by what `useTokenFigures` reports rather than by the absence itself.
const figureText = (value: string | undefined, failed: boolean): string => {
  if (value !== undefined) return displayAmount(value)
  return failed ? 'N/A' : '...'
}

export const Balances = (): React.JSX.Element => {
  const { tokens } = useTokenList()
  const { failed, tvl } = useTokenFigures()

  return (
    <Card className="flex flex-wrap items-start gap-10 p-5">
      {tokens.map((token) => (
        <Figure
          key={`${token.instrumentId.admin}/${token.instrumentId.id}`}
          exact={token.balance}
          label={`Your ${token.symbol}`}
          value={figureText(token.balance, failed)}
        />
      ))}
      <Figure exact={tvl} label="Vault holdings" value={figureText(tvl, failed)} />
    </Card>
  )
}
