#!/usr/bin/env node
// Bootstrap the vault demo: an issuer party owning the underlying instrument, a vault party
// owning the share instrument and the Vault itself. Depositors are wallet accounts, so no
// other party is created here.
//
// Nothing is written out. The dApp finds all of it by reading this run's rights and the
// contracts back off the ledger, so a run that ends here is a run the dApp can already see.
//
// Two parties rather than one because the Vault only constrains the share instrument's admin
// (`ensure vaultInstrumentId.admin == vault`): a vault that also mints its own underlying would
// hide the disclosure the deposit leg really needs.
//
// Run with the local stack up, wallet-service answering and both DARs deployed.

const RPC_URL = process.env.RPC_URL ?? 'http://localhost:3010/rpc'
const FORGE_PACKAGE = 'canton-token-forge'
const VAULT_PACKAGE = 'canton-token-vault'
const STAMP = Date.now()

const UNDERLYING = { id: 'USDX', name: 'US Dollar X', symbol: 'USDX' }
const SHARE = { id: 'VSH', name: 'Vault Share', symbol: 'VSH' }
// InstrumentConfig ensures 0..10, and the kit parses every ledger amount at 10.
const DECIMALS = 10
const FAUCET_MAX_PER_TAP = '1000.0'

const rpc = async (method, params) => {
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }),
  })
  const text = await response.text()
  // Status before parse: a proxy error page or an empty body from a still-starting
  // wallet-service would otherwise surface as a JSON syntax error instead of the failure.
  if (!response.ok) {
    throw new Error(`${method} failed: HTTP ${response.status} ${text.slice(0, 400)}`)
  }
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error(`${method} returned no JSON: ${text.slice(0, 400)}`)
  }
  if (payload.error !== undefined) {
    throw new Error(`${method} failed: ${text.slice(0, 400)}`)
  }
  return payload.result
}

const ledger = (requestMethod, resource, body, query) =>
  rpc('ledgerApi', {
    requestMethod,
    resource,
    ...(body === undefined ? {} : { body }),
    ...(query === undefined ? {} : { query }),
  })

/** Both hints carry one run's stamp, so the dApp's newest-wins sort picks a matching pair. */
export const partyHints = (stamp) => ({
  issuer: `token-issuer-${stamp}`,
  vault: `vault-operator-${stamp}`,
})

/**
 * An InstrumentConfig's createArguments. `decimals` is an Int64, which the JSON Ledger API
 * takes as a string, and `faucet` is an Optional, so its absence is null rather than omitted.
 */
export const instrumentConfigArgs = ({ admin, id, name, symbol, decimals, maxPerTap }) => ({
  admin,
  instrumentId: id,
  name,
  symbol,
  decimals: String(decimals),
  faucet: maxPerTap === undefined ? null : { maxPerTap },
  meta: { values: {} },
})

/** A Vault's createArguments. Each leg names its instrument as `{admin, id}`, not as text. */
export const vaultArgs = ({ vault, underlying, share }) => ({
  vault,
  instrumentId: { admin: underlying.admin, id: underlying.id },
  vaultInstrumentId: { admin: share.admin, id: share.id },
})

const createParty = async (hint) => {
  const result = await ledger('post', '/v2/parties', { partyIdHint: hint })
  const party = result?.partyDetails?.party
  if (typeof party !== 'string' || party.length === 0) {
    throw new Error(`no party id for hint ${hint}: ${JSON.stringify(result)}`)
  }
  // wallet-service keeps its bearer token private, so ask the participant who it authenticated
  // as. The dApp reads these rights back to discover both parties.
  const userId = (await ledger('get', '/v2/authenticated-user'))?.user?.id
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new Error('participant did not report an authenticated user')
  }
  await ledger('post', `/v2/users/${userId}/rights`, {
    userId,
    identityProviderId: '',
    rights: [{ kind: { CanActAs: { value: { party } } } }],
  })
  return party
}

// Ask the participant which package it would pick for the name, so a stale id cannot silently
// produce an empty dashboard. Fails loudly with PACKAGE_NAMES_NOT_FOUND if a DAR is missing.
const resolvePackage = async (name, party) => {
  const result = await ledger(
    'get',
    '/v2/interactive-submission/preferred-package-version',
    undefined,
    { 'package-name': name, parties: party },
  )
  const pkg = result?.packagePreference?.packageReference?.packageId
  if (typeof pkg !== 'string' || pkg.length === 0) {
    throw new Error(`participant returned no package id for ${name}`)
  }
  return pkg
}

const create = (commandId, party, templateId, createArguments) =>
  ledger('post', '/v2/commands/submit-and-wait-for-transaction-tree', {
    commandId,
    actAs: [party],
    readAs: [party],
    commands: [{ CreateCommand: { templateId, createArguments } }],
  })

// A filter takes the package-name reference; a participant rejects the package id a
// CreateCommand carries.
const readOne = async (party, templateId, match) => {
  const end = await ledger('get', '/v2/state/ledger-end')
  if (end?.offset === undefined) {
    throw new Error('participant returned no ledger-end offset')
  }
  const rows = await ledger('post', '/v2/state/active-contracts', {
    filter: {
      filtersByParty: {
        [party]: {
          cumulative: [
            {
              identifierFilter: {
                TemplateFilter: { value: { templateId, includeCreatedEventBlob: true } },
              },
            },
          ],
        },
      },
    },
    activeAtOffset: end.offset,
    verbose: true,
  })
  const found = (Array.isArray(rows) ? rows : [])
    .map((row) => row?.contractEntry?.JsActiveContract?.createdEvent)
    .filter((event) => event?.createdEventBlob !== undefined)
    .find((event) => match(event.createArgument))
  if (found === undefined) {
    throw new Error(`created ${templateId} but no disclosable row came back from the ACS read`)
  }
  return found.contractId
}

const main = async () => {
  const hints = partyHints(STAMP)
  const issuer = await createParty(hints.issuer)
  const vault = await createParty(hints.vault)
  console.log(`issuer     ${issuer}`)
  console.log(`vault      ${vault}`)

  const forgePkg = process.env.FORGE_PKG ?? (await resolvePackage(FORGE_PACKAGE, issuer))
  const vaultPkg = process.env.VAULT_PKG ?? (await resolvePackage(VAULT_PACKAGE, vault))
  const configTid = `${forgePkg}:Canton.TokenForge.Registry:InstrumentConfig`
  const configFilter = `#${FORGE_PACKAGE}:Canton.TokenForge.Registry:InstrumentConfig`
  console.log(`forge      ${forgePkg}`)
  console.log(`vault pkg  ${vaultPkg}`)

  // The faucet is what lets a depositor fund itself from the browser: Tap is controlled by the
  // tapping party alone, while Mint needs the admin to co-sign.
  await create(`vault-underlying-${STAMP}`, issuer, configTid, {
    ...instrumentConfigArgs({
      admin: issuer,
      ...UNDERLYING,
      decimals: DECIMALS,
      maxPerTap: FAUCET_MAX_PER_TAP,
    }),
  })
  const underlyingCid = await readOne(
    issuer,
    configFilter,
    (arg) => arg?.instrumentId === UNDERLYING.id,
  )
  console.log(`${UNDERLYING.symbol}       ${underlyingCid}`)

  await create(`vault-share-${STAMP}`, vault, configTid, {
    ...instrumentConfigArgs({ admin: vault, ...SHARE, decimals: DECIMALS }),
  })
  const shareCid = await readOne(vault, configFilter, (arg) => arg?.instrumentId === SHARE.id)
  console.log(`${SHARE.symbol}        ${shareCid}`)

  await create(`vault-${STAMP}`, vault, `${vaultPkg}:Canton.TokenVault.Vault:Vault`, {
    ...vaultArgs({
      vault,
      underlying: { admin: issuer, id: UNDERLYING.id },
      share: { admin: vault, id: SHARE.id },
    }),
  })
  const vaultCid = await readOne(
    vault,
    `#${VAULT_PACKAGE}:Canton.TokenVault.Vault:Vault`,
    (arg) => arg?.vault === vault,
  )
  console.log(`vault cid  ${vaultCid}`)
}

if (import.meta.filename === process.argv[1]) {
  await main()
}
