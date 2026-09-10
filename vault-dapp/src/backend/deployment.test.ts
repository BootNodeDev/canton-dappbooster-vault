import { describe, expect, it } from 'vitest'
import type { LedgerApi } from '@/backend/acs'
import { loadDeployment } from '@/backend/deployment'

const VAULT = 'vault-operator-1700000000001::ns'
const OLDER = 'vault-operator-1600000000000::ns'
const ISSUER = 'token-issuer-1700000000001::ns'

const row = (
  createdEvent: Record<string, unknown>,
  synchronizerId?: string,
): Record<string, unknown> => ({
  contractEntry: {
    JsActiveContract: { createdEvent, ...(synchronizerId ? { synchronizerId } : {}) },
  },
})

const vaultEvent = {
  contractId: '00vault',
  createArgument: {
    instrumentId: { admin: ISSUER, id: 'USDX' },
    vault: VAULT,
    vaultInstrumentId: { admin: VAULT, id: 'VSH' },
  },
  createdEventBlob: 'dmF1bHQ=',
  templateId: 'vaultpkg:Canton.TokenVault.Vault:Vault',
}

const configEvent = (id: string, extra: Record<string, unknown> = {}) => ({
  contractId: `00${id}`,
  createArgument: {
    decimals: '10',
    faucet: null,
    instrumentId: id,
    name: `${id} token`,
    symbol: id,
    ...extra,
  },
  createdEventBlob: `${id}blob`,
  templateId: 'forgepkg:Canton.TokenForge.Registry:InstrumentConfig',
})

// The reads loadDeployment makes, keyed by resource and by the party a filter names, so a test
// overrides only what it is about. `parties` records every party a filter was sent for.
const ledger = (
  overrides: {
    configs?: Record<string, unknown[]>
    packages?: unknown
    rights?: unknown[]
    vaults?: unknown[]
  } = {},
): { ledgerApi: LedgerApi; parties: () => string[] } => {
  const parties: string[] = []
  const ledgerApi: LedgerApi = async (params) => {
    const resource = params.resource as string
    if (resource === '/v2/authenticated-user') {
      return { user: { id: 'user-1' } }
    }
    if (resource.endsWith('/rights')) {
      return {
        rights: overrides.rights ?? [
          { kind: { CanActAs: { value: { party: OLDER } } } },
          { kind: { CanActAs: { value: { party: VAULT } } } },
          { kind: { CanActAs: { value: { party: ISSUER } } } },
        ],
      }
    }
    if (resource === '/v2/state/ledger-end') {
      return { offset: 42 }
    }
    if (resource.endsWith('preferred-package-version')) {
      return (
        overrides.packages ?? {
          packagePreference: {
            packageReference: {
              packageId: (params.query as { 'package-name': string })['package-name'],
            },
          },
        }
      )
    }
    const filter = (params.body as { filter?: { filtersByParty?: Record<string, unknown> } })
      ?.filter
    const party = Object.keys(filter?.filtersByParty ?? {})[0] ?? ''
    parties.push(party)
    const templateId = (
      filter?.filtersByParty?.[party] as {
        cumulative?: {
          identifierFilter?: { TemplateFilter?: { value?: { templateId?: string } } }
        }[]
      }
    )?.cumulative?.[0]?.identifierFilter?.TemplateFilter?.value?.templateId
    if (templateId?.includes('TokenVault.Vault') === true) {
      return overrides.vaults ?? [row(vaultEvent, 'sync::1')]
    }
    const configs = overrides.configs ?? {
      [ISSUER]: [row(configEvent('USDX', { faucet: { maxPerTap: '1000.0' } }))],
      [VAULT]: [row(configEvent('VSH'))],
    }
    return configs[party] ?? []
  }
  return { ledgerApi, parties: () => parties }
}

describe('loadDeployment', () => {
  it('returns the vault, both instruments and the two package ids', async () => {
    const { ledgerApi } = ledger()

    await expect(loadDeployment(ledgerApi)).resolves.toEqual({
      forgePkg: 'canton-token-forge',
      share: {
        admin: VAULT,
        configBlob: 'VSHblob',
        configCid: '00VSH',
        decimals: 10,
        hasFaucet: false,
        id: 'VSH',
        name: 'VSH token',
        symbol: 'VSH',
      },
      synchronizerId: 'sync::1',
      underlying: {
        admin: ISSUER,
        configBlob: 'USDXblob',
        configCid: '00USDX',
        decimals: 10,
        hasFaucet: true,
        id: 'USDX',
        name: 'USDX token',
        symbol: 'USDX',
      },
      vault: VAULT,
      vaultCid: '00vault',
      vaultPkg: 'canton-token-vault',
    })
  })

  // Every run leaves its vault behind, so the newest is the one this page means.
  it('reads as the newest vault operator among the rights', async () => {
    const { ledgerApi, parties } = ledger()

    await loadDeployment(ledgerApi)

    expect(parties()[0]).toBe(VAULT)
  })

  // The issuer is never guessed from a party hint: mixing one run's issuer with another run's
  // vault would name an instrument the vault does not hold.
  it('takes the underlying issuer off the vault contract, not off the rights', async () => {
    const other = 'token-issuer-9999999999999::ns'
    const { ledgerApi, parties } = ledger({
      configs: {
        [other]: [row(configEvent('USDX', { faucet: { maxPerTap: '1.0' } }))],
        [ISSUER]: [row(configEvent('USDX', { faucet: { maxPerTap: '1000.0' } }))],
        [VAULT]: [row(configEvent('VSH'))],
      },
      rights: [
        { kind: { CanActAs: { value: { party: VAULT } } } },
        { kind: { CanActAs: { value: { party: other } } } },
      ],
    })

    const deployment = await loadDeployment(ledgerApi)

    expect(deployment.underlying.admin).toBe(ISSUER)
    expect(parties()).not.toContain(other)
  })

  it('omits the synchronizer id when the vault row carries none', async () => {
    const { ledgerApi } = ledger({ vaults: [row(vaultEvent)] })

    await expect(loadDeployment(ledgerApi)).resolves.not.toHaveProperty('synchronizerId')
  })

  it('names the bootstrap script when no vault operator was ever created', async () => {
    const { ledgerApi } = ledger({ rights: [{ kind: { ParticipantAdmin: { value: {} } } }] })

    await expect(loadDeployment(ledgerApi)).rejects.toThrow(
      /no vault operator.*pnpm run bootstrap-vault/,
    )
  })

  // A row with no blob cannot be disclosed, so it is as good as absent.
  it('rejects a vault row that came back without its disclosure blob', async () => {
    const { ledgerApi } = ledger({ vaults: [row({ contractId: '00vault' })] })

    await expect(loadDeployment(ledgerApi)).rejects.toThrow(/no vault disclosable/)
  })

  it('rejects a vault whose share instrument is not on the ledger', async () => {
    const { ledgerApi } = ledger({
      configs: { [ISSUER]: [row(configEvent('USDX'))], [VAULT]: [] },
    })

    await expect(loadDeployment(ledgerApi)).rejects.toThrow(/no VSH instrument disclosable/)
  })

  it('rejects a participant that knows neither package by name', async () => {
    const { ledgerApi } = ledger({ packages: {} })

    await expect(loadDeployment(ledgerApi)).rejects.toThrow(/knows no package named/)
  })
})
