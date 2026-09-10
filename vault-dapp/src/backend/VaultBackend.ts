// The seam the UI depends on: what the app can do to the ledger, with no mention of the JSON API
// or the wallet. `LedgerBackend` satisfies it against the canton-token-vault package.

import type { Holding } from '@bootnodedev/canton-dappbooster'
import type { VaultProposal, VaultRequest, VaultRequests } from '@/backend/requests'

export interface VaultBackend {
  /** Escrows the holdings funding one accepted request, which is what lets the vault settle it. */
  allocate: (partyId: string, request: VaultRequest) => Promise<void>
  /** Withdraws a proposal the vault has not accepted yet. */
  cancelProposal: (partyId: string, proposal: VaultProposal) => Promise<void>
  /** Asks the vault for a deposit. The vault accepts it backstage, which mints the request. */
  deposit: (partyId: string, amount: string) => Promise<void>
  /** Every standard holding a party owns. The vault party's own is the vault's balance. */
  holdingsOf: (partyId: string) => Promise<readonly Holding[]>
  /** The party's proposals and accepted requests, as the queue shows them. */
  requestsOf: (partyId: string) => Promise<VaultRequests>
  /** Mints from the underlying instrument's faucet to the acting party. */
  tap: (partyId: string, amount: string) => Promise<void>
  /** Asks the vault to redeem shares for the underlying, one for one. */
  withdraw: (partyId: string, amount: string) => Promise<void>
}
