// What the bootstrap left on the ledger, read back through the wallet rather than carried in a
// file: every bootstrap run mints a fresh vault and instruments, and a stale copy of either shows
// as an empty page with no error.
//
// Only the vault party is discovered by name. Both instruments and the issuer come off the Vault
// contract itself, so a run's parts cannot be mixed with another run's.

import {
  type AcsEntry,
  type CreatedEvent,
  call,
  type LedgerApi,
  ledgerEnd,
  readAcs,
  templateFilter,
} from '@/backend/acs'

/** One of the vault's two instruments, with the disclosure a write against it needs. */
export type Instrument = {
  admin: string
  configBlob: string
  configCid: string
  decimals: number
  hasFaucet: boolean
  id: string
  name: string
  symbol: string
}

export type Deployment = {
  forgePkg: string
  share: Instrument
  synchronizerId?: string
  underlying: Instrument
  vault: string
  vaultCid: string
  vaultPkg: string
}

export const FORGE_PACKAGE = 'canton-token-forge'
export const VAULT_PACKAGE = 'canton-token-vault'

// A filter takes the package-name reference, never the id it resolves to.
const VAULT_FILTER = `#${VAULT_PACKAGE}:Canton.TokenVault.Vault:Vault`
const CONFIG_FILTER = `#${FORGE_PACKAGE}:Canton.TokenForge.Registry:InstrumentConfig`
const VAULT_HINT = 'vault-operator-'

const advice = (reason: string): Error => new Error(`${reason}: run pnpm run bootstrap-vault`)

type InstrumentIdValue = { admin?: string; id?: string }

const instrumentIdOf = (value: unknown): { admin: string; id: string } => {
  const { admin, id } = (value ?? {}) as InstrumentIdValue
  if (typeof admin !== 'string' || typeof id !== 'string' || admin === '' || id === '') {
    throw advice('the vault names an instrument this app cannot read')
  }
  return { admin, id }
}

// The bootstrap grants this user `CanActAs` on the parties it creates, so its rights are the vault
// list. Reading the ledger's parties instead would also return everyone else's on a shared
// participant. The hint carries the run's timestamp, so the last one sorted is the newest.
const newestVault = async (ledgerApi: LedgerApi): Promise<string> => {
  const { user } = await call<{ user?: { id?: string } }>(ledgerApi, {
    requestMethod: 'get',
    resource: '/v2/authenticated-user',
  })
  if (user?.id === undefined) {
    throw new Error('the wallet did not report an authenticated user')
  }
  const { rights } = await call<{
    rights?: { kind?: { CanActAs?: { value?: { party?: string } } } }[]
  }>(ledgerApi, { requestMethod: 'get', resource: `/v2/users/${user.id}/rights` })
  const vault = (rights ?? [])
    .map((right) => right.kind?.CanActAs?.value?.party)
    .filter((party): party is string => party?.startsWith(VAULT_HINT) === true)
    .sort()
    .at(-1)
  if (vault === undefined) {
    throw advice('no vault operator on this ledger')
  }
  return vault
}

// Only a row carrying a blob is any use: the blob is the disclosure payload a write against a
// contract this party is no stakeholder of cannot go without.
const readDisclosable = async (
  ledgerApi: LedgerApi,
  party: string,
  templateId: string,
  offset: string,
): Promise<AcsEntry[]> => {
  const entries = await readAcs(ledgerApi, {
    filter: templateFilter(templateId, true),
    offset,
    party,
  })
  return entries.filter((entry) => entry.event.createdEventBlob !== undefined)
}

const toInstrument = (event: CreatedEvent, admin: string, id: string): Instrument => {
  const arg = event.createArgument ?? {}
  const { contractId, createdEventBlob } = event
  if (contractId === undefined || createdEventBlob === undefined) {
    throw advice(`no disclosable ${id} instrument`)
  }
  return {
    admin,
    configBlob: createdEventBlob,
    configCid: contractId,
    // Int64 arrives as a string, and a symbol or name absent is a label rather than an error.
    decimals: Number(arg.decimals ?? 10),
    hasFaucet: arg.faucet !== null && arg.faucet !== undefined,
    id,
    name: typeof arg.name === 'string' ? arg.name : id,
    symbol: typeof arg.symbol === 'string' ? arg.symbol : id,
  }
}

const readInstrument = async (
  ledgerApi: LedgerApi,
  offset: string,
  { admin, id }: { admin: string; id: string },
): Promise<Instrument> => {
  const rows = await readDisclosable(ledgerApi, admin, CONFIG_FILTER, offset)
  const found = rows.find((row) => row.event.createArgument?.instrumentId === id)
  if (found === undefined) {
    throw advice(`no ${id} instrument disclosable by ${admin}`)
  }
  return toInstrument(found.event, admin, id)
}

// Ask the participant which package it would pick for the name, so a stale id cannot silently
// produce an empty page. A command carries this resolved id; the filters above carry the name.
const resolvePackage = async (
  ledgerApi: LedgerApi,
  name: string,
  party: string,
): Promise<string> => {
  const result = await call<{
    packagePreference?: { packageReference?: { packageId?: string } }
  }>(ledgerApi, {
    requestMethod: 'get',
    resource: '/v2/interactive-submission/preferred-package-version',
    query: { 'package-name': name, parties: party },
  })
  const pkg = result.packagePreference?.packageReference?.packageId
  if (pkg === undefined || pkg === '') {
    throw advice(`the participant knows no package named ${name}`)
  }
  return pkg
}

export const loadDeployment = async (ledgerApi: LedgerApi): Promise<Deployment> => {
  const vault = await newestVault(ledgerApi)
  const offset = await ledgerEnd(ledgerApi)

  const vaults = await readDisclosable(ledgerApi, vault, VAULT_FILTER, offset)
  const row = vaults.find((entry) => entry.event.createArgument?.vault === vault)
  if (row === undefined) {
    throw advice(`no vault disclosable by ${vault}`)
  }
  const { contractId } = row.event
  if (contractId === undefined) {
    throw advice('the vault came back with no contract id')
  }

  // Both instruments come off the Vault rather than off this user's rights, so the pair is the one
  // this vault actually names.
  const arg = row.event.createArgument ?? {}
  const underlyingId = instrumentIdOf(arg.instrumentId)
  const shareId = instrumentIdOf(arg.vaultInstrumentId)

  const [underlying, share, forgePkg, vaultPkg] = await Promise.all([
    readInstrument(ledgerApi, offset, underlyingId),
    readInstrument(ledgerApi, offset, shareId),
    resolvePackage(ledgerApi, FORGE_PACKAGE, underlyingId.admin),
    resolvePackage(ledgerApi, VAULT_PACKAGE, vault),
  ])

  return {
    forgePkg,
    share,
    underlying,
    vault,
    vaultCid: contractId,
    vaultPkg,
    ...(row.synchronizerId === undefined ? {} : { synchronizerId: row.synchronizerId }),
  }
}
