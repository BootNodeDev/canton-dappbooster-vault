import type { LedgerApiParams } from '@bootnodedev/canton-connect'
import { valueAt } from '#src/utils/json'
import type { Holding } from '#src/utils/sumHoldings'

// The v1 interface every standard token implements. `#package-name` form survives a package upgrade
const HOLDING_INTERFACE = '#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding'

// The contract id sits on the created event rather than in the view, so it is passed in.
const holdingFromView = (view: unknown, contractId: string): Holding | undefined => {
  const value = valueAt(view, 'viewValue')
  const admin = valueAt(value, 'instrumentId', 'admin')
  const id = valueAt(value, 'instrumentId', 'id')
  const amount = valueAt(value, 'amount')

  if (typeof admin !== 'string' || typeof id !== 'string' || typeof amount !== 'string') {
    return undefined
  }

  const lock = valueAt(value, 'lock')

  return {
    amount,
    contractId,
    instrumentId: { admin, id },
    isLocked: lock !== null && lock !== undefined,
  }
}

const holdingsFromAcsRows = (rows: unknown): readonly Holding[] => {
  if (!Array.isArray(rows)) return []

  return rows.flatMap((row) => {
    const created = valueAt(row, 'contractEntry', 'JsActiveContract', 'createdEvent')
    const contractId = valueAt(created, 'contractId')
    const views = valueAt(created, 'interfaceViews')
    if (typeof contractId !== 'string' || !Array.isArray(views)) return []
    return views.flatMap((view) => holdingFromView(view, contractId) ?? [])
  })
}

const acsRequest = (partyId: string, offset: string | number): LedgerApiParams => ({
  requestMethod: 'post',
  resource: '/v2/state/active-contracts',
  body: {
    filter: {
      filtersByParty: {
        [partyId]: {
          cumulative: [
            {
              identifierFilter: {
                InterfaceFilter: {
                  value: { interfaceId: HOLDING_INTERFACE, includeInterfaceView: true },
                },
              },
            },
          ],
        },
      },
    },
    activeAtOffset: offset,
    verbose: true,
  },
})

/**
 * Every standard holding one party owns, one entry per contract. Reach for {@link useHoldings}
 * instead wherever the connected party is the subject: this is for reading another party's, such
 * as a vault's own balance.
 *
 * @throws when the ledger returns no offset for the snapshot to read at.
 *
 * @example
 * const holdings = await readHoldings(ledgerApi, partyId)
 * sumHoldings(holdings) // [{ balance: '10.5', instrumentId, locked: '0' }]
 *
 * @category Utilities
 */
export const readHoldings = async (
  ledgerApi: (params: LedgerApiParams) => Promise<unknown>,
  partyId: string,
): Promise<readonly Holding[]> => {
  const end = await ledgerApi({ requestMethod: 'get', resource: '/v2/state/ledger-end' })
  const offset = valueAt(end, 'offset')
  if (typeof offset !== 'string' && typeof offset !== 'number') {
    throw new Error('the ledger did not return an offset')
  }
  return holdingsFromAcsRows(await ledgerApi(acsRequest(partyId, offset)))
}
