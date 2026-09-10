import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { instrumentConfigArgs, partyHints, vaultArgs } from './bootstrap-vault.mjs'

describe('vault bootstrap payloads', () => {
  it('spells an InstrumentConfig the way the JSON Ledger API takes it', () => {
    // Scenario: the underlying instrument, whose faucet is what lets a depositor fund
    // itself from the browser. decimals is an Int64, which the participant rejects as a
    // JSON number, and meta is a Metadata record rather than a bare map.
    assert.deepEqual(
      instrumentConfigArgs({
        admin: 'token-issuer-1::abc',
        id: 'USDX',
        name: 'US Dollar X',
        symbol: 'USDX',
        decimals: 10,
        maxPerTap: '1000.0',
      }),
      {
        admin: 'token-issuer-1::abc',
        instrumentId: 'USDX',
        name: 'US Dollar X',
        symbol: 'USDX',
        decimals: '10',
        faucet: { maxPerTap: '1000.0' },
        meta: { values: {} },
      },
    )
  })

  it('sends an absent faucet as null, since Optional has no omitted form', () => {
    // Scenario: the share instrument. Shares are minted by the vault's settle through the
    // burn-mint factory, so a faucet on them would hand out unbacked shares.
    const args = instrumentConfigArgs({
      admin: 'vault-operator-1::abc',
      id: 'VSH',
      name: 'Vault Share',
      symbol: 'VSH',
      decimals: 10,
    })

    assert.equal(args.faucet, null)
    assert.ok('faucet' in args)
  })

  it('names each Vault leg by instrument id record rather than by text', () => {
    // Scenario: the Vault's own `ensure` compares vaultInstrumentId.admin to the vault
    // party, so a leg flattened to a string would fail preprocessing before that ran.
    assert.deepEqual(
      vaultArgs({
        vault: 'vault-operator-1::abc',
        underlying: { admin: 'token-issuer-1::abc', id: 'USDX' },
        share: { admin: 'vault-operator-1::abc', id: 'VSH' },
      }),
      {
        vault: 'vault-operator-1::abc',
        instrumentId: { admin: 'token-issuer-1::abc', id: 'USDX' },
        vaultInstrumentId: { admin: 'vault-operator-1::abc', id: 'VSH' },
      },
    )
  })

  it('stamps both hints from one run, so the dApp picks a matching pair', () => {
    // Scenario: every run leaves its parties active on the local ledger, and the dApp takes
    // the newest of each by sorting the hint. Two different stamps would pair a new vault
    // with an old issuer, whose instrument the new Vault does not name.
    assert.deepEqual(partyHints(1757000000000), {
      issuer: 'token-issuer-1757000000000',
      vault: 'vault-operator-1757000000000',
    })
  })
})
