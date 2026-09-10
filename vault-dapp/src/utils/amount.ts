import { formatAmount, parseAmount } from '@bootnodedev/canton-dappbooster'

// Two places, always, so a balance and a literal never render differently: the kit passes a
// fraction through verbatim, and a ledger amount carries ten zeros where a constant carries one.
const PLACES = 2

/**
 * A figure as the UI shows it. Truncated rather than rounded, because a balance that reads higher
 * than it is invites a submission the ledger refuses; the exact value belongs in a title.
 */
export const displayAmount = (value: string): string => {
  const [whole = '0', fraction = ''] = value.split('.')
  return formatAmount(`${whole}.${`${fraction}${'0'.repeat(PLACES)}`.slice(0, PLACES)}`)
}

// A ledger amount never goes through a float, so the check is on the scaled integer. An amount that
// will not parse is not positive either, which is what the form's own validation reports on.
export const isPositive = (value: string): boolean => (parseAmount(value) ?? 0n) > 0n
