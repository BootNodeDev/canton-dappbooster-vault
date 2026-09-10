// The two wallet-session calls the backend needs, injected as plain functions so the backend stays
// constructible outside React while the functions themselves come from canton-connect's hooks.

import type { LedgerApiParams, PrepareExecuteParams } from '@bootnodedev/canton-connect'

// JSON Ledger API v2 commands. Unlike the vesting dApp this one also creates: the vault has no
// factory choice for a proposal, so a depositor's first write is a CreateCommand.
export type LedgerCommand =
  | {
      CreateCommand: {
        createArguments: Record<string, unknown>
        templateId: string
      }
    }
  | {
      ExerciseCommand: {
        choice: string
        choiceArgument: Record<string, unknown>
        contractId: string
        templateId: string
      }
    }

// Explicitly-disclosed contract (JSON Ledger API v2 disclosedContracts entry).
export type DisclosedContract = {
  contractId: string
  createdEventBlob: string
  synchronizerId?: string
  templateId: string
}

export type WalletFns = {
  execute: (params: PrepareExecuteParams) => Promise<unknown>
  ledgerApi: (params: LedgerApiParams) => Promise<unknown>
}
