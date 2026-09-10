import { describe, expect, it, vi } from 'vitest'
import type { Deployment } from '@/backend/deployment'
import { LedgerBackend } from '@/backend/LedgerBackend'
import type { VaultProposal, VaultRequest } from '@/backend/requests'
import type { WalletFns } from '@/backend/wallet'

const VAULT = 'vault-operator-1::ns'
const PARTY = 'nando::ns'

const deployment: Deployment = {
  forgePkg: 'forgepkg',
  share: {
    admin: VAULT,
    configBlob: 'c2hhcmU=',
    configCid: '00share',
    decimals: 10,
    hasFaucet: false,
    id: 'VSH',
    name: 'Vault Share',
    symbol: 'VSH',
  },
  synchronizerId: 'global-domain::1',
  underlying: {
    admin: 'token-issuer-1::ns',
    configBlob: 'dW5kZXI=',
    configCid: '00under',
    decimals: 10,
    hasFaucet: true,
    id: 'USDX',
    name: 'US Dollar X',
    symbol: 'USDX',
  },
  vault: VAULT,
  vaultCid: '00vault',
  vaultPkg: 'vaultpkg',
}

const wallet = (overrides: Partial<WalletFns> = {}): WalletFns => ({
  execute: vi.fn(async () => undefined),
  ledgerApi: vi.fn(async (params) =>
    params.resource === '/v2/state/ledger-end' ? { offset: 42 } : [],
  ),
  ...overrides,
})

describe('LedgerBackend.tap', () => {
  it('submits as the acting party with the instrument disclosed', async () => {
    const fns = wallet()

    await new LedgerBackend(deployment, fns).tap(PARTY, '1000.0')

    expect(fns.execute).toHaveBeenCalledWith({
      actAs: [PARTY],
      readAs: [PARTY],
      commands: [
        {
          ExerciseCommand: {
            choice: 'InstrumentConfig_Tap',
            choiceArgument: { amount: '1000.0', user: PARTY },
            contractId: '00under',
            templateId: 'forgepkg:Canton.TokenForge.Registry:InstrumentConfig',
          },
        },
      ],
      disclosedContracts: [
        {
          contractId: '00under',
          createdEventBlob: 'dW5kZXI=',
          synchronizerId: 'global-domain::1',
          templateId: 'forgepkg:Canton.TokenForge.Registry:InstrumentConfig',
        },
      ],
    })
  })

  // canton-connect defaults `actAs` to the connected party, and the wallet's own primary can
  // differ from the party the UI shows, so the backend always says which party it means.
  it('never leaves actAs for the wallet to choose', async () => {
    const fns = wallet()

    await new LedgerBackend(deployment, fns).tap(PARTY, '1.0')

    const [params] = (fns.execute as ReturnType<typeof vi.fn>).mock.calls[0] ?? []
    expect(params).toMatchObject({ actAs: [PARTY] })
  })

  // A disclosure without the synchronizer the contract lives on is refused at the participant,
  // and a deployment that reported none must not invent one.
  it('omits the synchronizer id where the deployment carries none', async () => {
    const fns = wallet()
    const { synchronizerId: _unused, ...noSync } = deployment

    await new LedgerBackend(noSync, fns).tap(PARTY, '1.0')

    const [params] = (fns.execute as ReturnType<typeof vi.fn>).mock.calls[0] ?? []
    expect(params?.disclosedContracts?.[0]).not.toHaveProperty('synchronizerId')
  })
})

describe('LedgerBackend.holdingsOf', () => {
  it('reads the party it is given rather than the connected one', async () => {
    const fns = wallet()

    await new LedgerBackend(deployment, fns).holdingsOf(VAULT)

    const parties = (fns.ledgerApi as ReturnType<typeof vi.fn>).mock.calls
      .map(([params]) => params.body?.filter?.filtersByParty)
      .filter((byParty) => byParty !== undefined)
      .flatMap((byParty) => Object.keys(byParty))
    expect(parties).toEqual([VAULT])
  })
})

const holdingRow = (contractId: string, amount: string): unknown => ({
  contractEntry: {
    JsActiveContract: {
      createdEvent: {
        contractId,
        interfaceViews: [
          {
            viewValue: {
              amount,
              instrumentId: { admin: 'token-issuer-1::ns', id: 'USDX' },
              lock: null,
            },
          },
        ],
      },
    },
  },
})

const shareHoldingRow = (contractId: string, amount: string): unknown => ({
  contractEntry: {
    JsActiveContract: {
      createdEvent: {
        contractId,
        interfaceViews: [
          { viewValue: { amount, instrumentId: { admin: VAULT, id: 'VSH' }, lock: null } },
        ],
      },
    },
  },
})

// A wallet whose holdings read answers, which is what an allocation funds itself from.
const walletHolding = (rows: unknown[]): WalletFns =>
  wallet({
    ledgerApi: vi.fn(async (params) =>
      params.resource === '/v2/state/ledger-end' ? { offset: 42 } : rows,
    ),
  })

const request: VaultRequest = {
  allocateBefore: '2026-09-10T13:00:00Z',
  allocated: false,
  amount: '25.0',
  contractId: '00req',
  instrumentId: { admin: 'token-issuer-1::ns', id: 'USDX' },
  kind: 'deposit',
  requestId: 'dep-1',
  requestedAt: '2026-09-10T12:00:00Z',
  settleBefore: '2026-09-10T14:00:00Z',
  spec: {
    settlement: { settlementRef: { id: 'dep-1' } },
    transferLeg: { amount: '25.0' },
    transferLegId: 'deposit',
  },
}

describe('LedgerBackend.deposit', () => {
  it('creates the proposal with no disclosure, the depositor being its only signatory', async () => {
    const fns = wallet()

    await new LedgerBackend(deployment, fns).deposit(PARTY, '25.0')

    expect(fns.execute).toHaveBeenCalledWith({
      actAs: [PARTY],
      readAs: [PARTY],
      commands: [
        {
          CreateCommand: {
            createArguments: { amount: '25.0', depositor: PARTY, vault: VAULT },
            templateId: 'vaultpkg:Canton.TokenVault.DepositProposal:DepositProposal',
          },
        },
      ],
      disclosedContracts: [],
    })
  })
})

const proposal: VaultProposal = { amount: '10.0', contractId: '00prop', kind: 'deposit' }

describe('LedgerBackend.withdraw', () => {
  it('creates a WithdrawProposal, which the vault turns into a two-leg request', async () => {
    const fns = wallet()

    await new LedgerBackend(deployment, fns).withdraw(PARTY, '15.0')

    const [params] = (fns.execute as ReturnType<typeof vi.fn>).mock.calls[0] ?? []
    expect(params?.commands?.[0]).toEqual({
      CreateCommand: {
        createArguments: { amount: '15.0', depositor: PARTY, vault: VAULT },
        templateId: 'vaultpkg:Canton.TokenVault.WithdrawProposal:WithdrawProposal',
      },
    })
  })
})

describe('LedgerBackend.cancelProposal', () => {
  it('exercises the cancel the depositor controls', async () => {
    const fns = wallet()

    await new LedgerBackend(deployment, fns).cancelProposal(PARTY, proposal)

    const [params] = (fns.execute as ReturnType<typeof vi.fn>).mock.calls[0] ?? []
    expect(params?.commands?.[0]).toEqual({
      ExerciseCommand: {
        choice: 'DepositProposal_Cancel',
        choiceArgument: {},
        contractId: '00prop',
        templateId: 'vaultpkg:Canton.TokenVault.DepositProposal:DepositProposal',
      },
    })
  })
})

describe('LedgerBackend.allocate', () => {
  it('funds the leg from the holdings it reads, with the instrument disclosed', async () => {
    // Scenario: one 30 holding against a 25 request. The spec goes out as the read gave it, and
    // `requestedAt` is the request's own, never the browser's clock.
    const fns = walletHolding([holdingRow('00hold', '30.0')])

    await new LedgerBackend(deployment, fns).allocate(PARTY, request)

    const [params] = (fns.execute as ReturnType<typeof vi.fn>).mock.calls[0] ?? []
    expect(params?.commands?.[0]).toEqual({
      ExerciseCommand: {
        choice: 'AllocationFactory_Allocate',
        choiceArgument: {
          allocation: request.spec,
          expectedAdmin: 'token-issuer-1::ns',
          extraArgs: { context: { values: {} }, meta: { values: {} } },
          inputHoldingCids: ['00hold'],
          requestedAt: '2026-09-10T12:00:00Z',
        },
        contractId: '00under',
        templateId:
          '#splice-api-token-allocation-instruction-v1:Splice.Api.Token.AllocationInstructionV1:AllocationFactory',
      },
    })
    expect(params?.disclosedContracts?.[0]).toMatchObject({ contractId: '00under' })
  })

  // A withdraw funds its leg in shares, and the leg is the only thing that says so. Reading the
  // instrument off the deployment's `underlying` instead would escrow the wrong token.
  it('funds a share leg against the share instrument, with the share config disclosed', async () => {
    const shareRequest: VaultRequest = {
      ...request,
      amount: '15.0',
      instrumentId: { admin: VAULT, id: 'VSH' },
      kind: 'withdraw',
      spec: { ...request.spec, transferLegId: 'withdraw-shares-in' },
    }
    const fns = walletHolding([shareHoldingRow('00vsh', '20.0')])

    await new LedgerBackend(deployment, fns).allocate(PARTY, shareRequest)

    const [params] = (fns.execute as ReturnType<typeof vi.fn>).mock.calls[0] ?? []
    expect(params?.commands?.[0]).toMatchObject({
      ExerciseCommand: {
        choiceArgument: { expectedAdmin: VAULT, inputHoldingCids: ['00vsh'] },
        contractId: '00share',
      },
    })
    expect(params?.disclosedContracts?.[0]).toMatchObject({ contractId: '00share' })
  })

  it('refuses an instrument this vault does not name', async () => {
    const foreign: VaultRequest = {
      ...request,
      instrumentId: { admin: 'someone::ns', id: 'FAKE' },
    }
    const fns = walletHolding([])

    await expect(new LedgerBackend(deployment, fns).allocate(PARTY, foreign)).rejects.toThrow(
      'does not name an instrument FAKE',
    )
  })

  // Reachable from a queue whose balances are a moment old, so it has to fail before the wallet
  // prompts rather than let the participant refuse a signed submission.
  it('refuses before submitting when the holdings fall short', async () => {
    const fns = walletHolding([holdingRow('00hold', '1.0')])

    await expect(new LedgerBackend(deployment, fns).allocate(PARTY, request)).rejects.toThrow(
      'not enough USDX',
    )
    expect(fns.execute).not.toHaveBeenCalled()
  })
})
