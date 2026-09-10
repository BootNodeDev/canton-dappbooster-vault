import { type Holding, readHoldings } from '@bootnodedev/canton-dappbooster'
import {
  buildAllocateCommand,
  buildCancelProposalCommand,
  buildProposalCommand,
  buildTapCommand,
  instrumentDisclosure,
} from '@/backend/commands'
import type { Deployment, Instrument } from '@/backend/deployment'
import {
  readVaultRequests,
  type VaultProposal,
  type VaultRequest,
  type VaultRequests,
} from '@/backend/requests'
import { selectInputs } from '@/backend/selectInputs'
import type { VaultBackend } from '@/backend/VaultBackend'
import type { DisclosedContract, LedgerCommand, WalletFns } from '@/backend/wallet'

export class LedgerBackend implements VaultBackend {
  private readonly deployment: Deployment
  private readonly wallet: WalletFns

  // Fields assigned in the body rather than declared as parameters: `erasableSyntaxOnly` rejects
  // a constructor parameter property, which emits code.
  constructor(deployment: Deployment, wallet: WalletFns) {
    this.deployment = deployment
    this.wallet = wallet
  }

  holdingsOf(partyId: string): Promise<readonly Holding[]> {
    return readHoldings(this.wallet.ledgerApi, partyId)
  }

  requestsOf(partyId: string): Promise<VaultRequests> {
    return readVaultRequests(this.wallet.ledgerApi, {
      party: partyId,
      vault: this.deployment.vault,
    })
  }

  async tap(partyId: string, amount: string): Promise<void> {
    const { forgePkg, underlying } = this.deployment
    await this.submit(
      partyId,
      buildTapCommand({ amount, forgePkg, instrument: underlying, user: partyId }),
      [instrumentDisclosure(underlying, forgePkg)],
    )
  }

  async deposit(partyId: string, amount: string): Promise<void> {
    const { vault, vaultPkg } = this.deployment
    await this.submit(
      partyId,
      buildProposalCommand({ amount, depositor: partyId, kind: 'deposit', vault, vaultPkg }),
      [],
    )
  }

  // The whole proposal rather than its id: the kind decides both the template and the choice, and
  // a caller holding a row already knows it.
  async withdraw(partyId: string, amount: string): Promise<void> {
    const { vault, vaultPkg } = this.deployment
    await this.submit(
      partyId,
      buildProposalCommand({ amount, depositor: partyId, kind: 'withdraw', vault, vaultPkg }),
      [],
    )
  }

  async cancelProposal(partyId: string, proposal: VaultProposal): Promise<void> {
    const { vaultPkg } = this.deployment
    await this.submit(
      partyId,
      buildCancelProposalCommand({
        kind: proposal.kind,
        proposalCid: proposal.contractId,
        vaultPkg,
      }),
      [],
    )
  }

  // One path for both kinds: the instrument comes off the leg the request says this party sends,
  // so a deposit funds in the underlying and a withdraw in the shares with nothing branching.
  //
  // The inputs are chosen here rather than by the caller: they come off a holdings read, and a
  // stale one is what makes the shortfall reachable at all.
  async allocate(partyId: string, request: VaultRequest): Promise<void> {
    const { forgePkg } = this.deployment
    const instrument = this.instrumentFor(request.instrumentId)
    const holdings = await this.holdingsOf(partyId)
    const inputHoldingCids = selectInputs({
      amount: request.amount,
      holdings,
      instrumentId: request.instrumentId,
    })
    if (inputHoldingCids === undefined) {
      throw new Error(`not enough ${instrument.symbol} to fund ${request.amount}`)
    }
    await this.submit(
      partyId,
      // The request's own timestamp, not the browser's: the contract asserts the allocation was
      // requested in the past, and a clock ahead of the participant's fails that.
      buildAllocateCommand({
        inputHoldingCids,
        instrument,
        requestedAt: request.requestedAt,
        spec: request.spec,
      }),
      [instrumentDisclosure(instrument, forgePkg)],
    )
  }

  // Only the two the Vault itself names, so an allocation can never be exercised on a factory this
  // deployment did not discover.
  private instrumentFor({ admin, id }: { admin: string; id: string }): Instrument {
    const found = [this.deployment.underlying, this.deployment.share].find(
      (one) => one.admin === admin && one.id === id,
    )
    if (found === undefined) {
      throw new Error(`this vault does not name an instrument ${id} issued by ${admin}`)
    }
    return found
  }

  // `actAs` is always explicit: canton-connect defaults it to the connected party, and the
  // wallet's own primary could differ from the one the UI shows.
  private async submit(
    actAs: string,
    command: LedgerCommand,
    disclosed: readonly DisclosedContract[],
  ): Promise<void> {
    const sync = this.deployment.synchronizerId
    await this.wallet.execute({
      actAs: [actAs],
      readAs: [actAs],
      commands: [command],
      disclosedContracts:
        sync === undefined
          ? [...disclosed]
          : disclosed.map((one) => ({ ...one, synchronizerId: sync })),
    })
  }
}
