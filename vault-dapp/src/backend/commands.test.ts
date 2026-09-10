import { describe, expect, it } from 'vitest'
import {
  type AllocationSpec,
  buildAllocateCommand,
  buildCancelProposalCommand,
  buildProposalCommand,
  buildTapCommand,
  instrumentDisclosure,
} from '@/backend/commands'
import type { Instrument } from '@/backend/deployment'

const FORGE_PKG = 'forgepkg'
const VAULT_PKG = 'vaultpkg'
const underlying: Instrument = {
  admin: 'token-issuer-1::ns',
  configBlob: 'YmxvYg==',
  configCid: '00cfg',
  decimals: 10,
  hasFaucet: true,
  id: 'USDX',
  name: 'US Dollar X',
  symbol: 'USDX',
}

describe('buildTapCommand', () => {
  it('exercises the faucet on the instrument config, by resolved package id', () => {
    // Scenario: a depositor funding itself. The choice is controlled by the tapping party alone,
    // so `user` is the acting party and no admin co-signs.
    expect(
      buildTapCommand({
        amount: '1000.0',
        forgePkg: FORGE_PKG,
        instrument: underlying,
        user: 'nando::ns',
      }),
    ).toEqual({
      ExerciseCommand: {
        choice: 'InstrumentConfig_Tap',
        choiceArgument: { amount: '1000.0', user: 'nando::ns' },
        contractId: '00cfg',
        templateId: 'forgepkg:Canton.TokenForge.Registry:InstrumentConfig',
      },
    })
  })

  // The `#package-name` form belongs on a filter. The prepare-and-execute path needs a concrete
  // package for the transaction the wallet signs, and the participant rejects the reference there.
  it('never spells the package as a name reference', () => {
    const command = buildTapCommand({
      amount: '1.0',
      forgePkg: FORGE_PKG,
      instrument: underlying,
      user: 'nando::ns',
    })

    expect('ExerciseCommand' in command && command.ExerciseCommand.templateId).not.toContain('#')
  })
})

describe('instrumentDisclosure', () => {
  it('carries the blob under the same resolved template id as the command', () => {
    // Scenario: the tapping party is no stakeholder of the config, so without this the
    // participant cannot read the contract the choice is exercised on.
    expect(instrumentDisclosure(underlying, FORGE_PKG)).toEqual({
      contractId: '00cfg',
      createdEventBlob: 'YmxvYg==',
      templateId: 'forgepkg:Canton.TokenForge.Registry:InstrumentConfig',
    })
  })
})

describe('buildProposalCommand', () => {
  it('creates the proposal, since the vault has no factory choice for one', () => {
    // Scenario: the depositor's first write. A create rather than an exercise, which is why the
    // wallet's prepare-and-sign path has to carry a CreateCommand at all.
    expect(
      buildProposalCommand({
        amount: '25.0',
        depositor: 'nando::ns',
        kind: 'deposit',
        vault: 'vault-operator-1::ns',
        vaultPkg: VAULT_PKG,
      }),
    ).toEqual({
      CreateCommand: {
        createArguments: { amount: '25.0', depositor: 'nando::ns', vault: 'vault-operator-1::ns' },
        templateId: 'vaultpkg:Canton.TokenVault.DepositProposal:DepositProposal',
      },
    })
  })

  // Identical fields, so the kind decides nothing but the template. Sending a withdraw against the
  // deposit template would be accepted by the participant and mint the wrong request.
  it('changes only the template for a withdraw', () => {
    const args = {
      amount: '15.0',
      depositor: 'nando::ns',
      vault: 'vault-operator-1::ns',
      vaultPkg: VAULT_PKG,
    }
    const deposit = buildProposalCommand({ ...args, kind: 'deposit' })
    const withdraw = buildProposalCommand({ ...args, kind: 'withdraw' })

    expect('CreateCommand' in withdraw && withdraw.CreateCommand).toEqual({
      createArguments: { amount: '15.0', depositor: 'nando::ns', vault: 'vault-operator-1::ns' },
      templateId: 'vaultpkg:Canton.TokenVault.WithdrawProposal:WithdrawProposal',
    })
    expect('CreateCommand' in deposit && deposit.CreateCommand.createArguments).toEqual(
      'CreateCommand' in withdraw && withdraw.CreateCommand.createArguments,
    )
  })
})

describe('buildCancelProposalCommand', () => {
  it('takes no argument, being controlled by the depositor alone', () => {
    expect(
      buildCancelProposalCommand({ kind: 'deposit', proposalCid: '00prop', vaultPkg: VAULT_PKG }),
    ).toEqual({
      ExerciseCommand: {
        choice: 'DepositProposal_Cancel',
        choiceArgument: {},
        contractId: '00prop',
        templateId: 'vaultpkg:Canton.TokenVault.DepositProposal:DepositProposal',
      },
    })
  })

  // Each template declares its own cancel, so the choice name moves with the template.
  it('names the withdraw template its own cancel', () => {
    expect(
      buildCancelProposalCommand({ kind: 'withdraw', proposalCid: '00wd', vaultPkg: VAULT_PKG }),
    ).toEqual({
      ExerciseCommand: {
        choice: 'WithdrawProposal_Cancel',
        choiceArgument: {},
        contractId: '00wd',
        templateId: 'vaultpkg:Canton.TokenVault.WithdrawProposal:WithdrawProposal',
      },
    })
  })
})

describe('buildAllocateCommand', () => {
  const spec: AllocationSpec = {
    settlement: { executor: 'vault-operator-1::ns', settlementRef: { cid: null, id: 'dep-1' } },
    transferLeg: { amount: '25.0', receiver: 'vault-operator-1::ns', sender: 'nando::ns' },
    transferLegId: 'deposit',
  }

  it('exercises the factory under the interface id, on the instrument config', () => {
    // Scenario: funding the deposit leg. The choice is declared on AllocationFactory, which the
    // InstrumentConfig implements, so the contract id is the config's and the id is the interface's.
    expect(
      buildAllocateCommand({
        inputHoldingCids: ['00hold'],
        instrument: underlying,
        requestedAt: '2026-09-10T12:00:00Z',
        spec,
      }),
    ).toEqual({
      ExerciseCommand: {
        choice: 'AllocationFactory_Allocate',
        choiceArgument: {
          allocation: spec,
          expectedAdmin: 'token-issuer-1::ns',
          extraArgs: { context: { values: {} }, meta: { values: {} } },
          inputHoldingCids: ['00hold'],
          requestedAt: '2026-09-10T12:00:00Z',
        },
        contractId: '00cfg',
        templateId:
          '#splice-api-token-allocation-instruction-v1:Splice.Api.Token.AllocationInstructionV1:AllocationFactory',
      },
    })
  })

  it('passes the settlement and the leg through untouched', () => {
    // The settle choice compares both field for field, so a rebuilt record is the failure mode.
    // Identity, not equality: a copy that reorders or drops a field would pass a deep compare.
    const command = buildAllocateCommand({
      inputHoldingCids: [],
      instrument: underlying,
      requestedAt: '2026-09-10T12:00:00Z',
      spec,
    })
    const sent = 'ExerciseCommand' in command ? command.ExerciseCommand.choiceArgument : {}
    const allocation = sent.allocation as AllocationSpec

    expect(allocation.settlement).toBe(spec.settlement)
    expect(allocation.transferLeg).toBe(spec.transferLeg)
  })
})
