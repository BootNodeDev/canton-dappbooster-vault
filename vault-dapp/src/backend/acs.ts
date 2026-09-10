// The JSON Ledger API v2 reads the discovery load and the request queue share, and the one place an
// untyped `ledgerApi` answer is cast.

import type { LedgerApiParams } from '@bootnodedev/canton-connect'

export type LedgerApi = (params: LedgerApiParams) => Promise<unknown>

/** The one place an untyped `ledgerApi` answer is cast. A second inline `as` is a duplicated type. */
export const call = async <T>(ledgerApi: LedgerApi, params: LedgerApiParams): Promise<T> =>
  (await ledgerApi(params)) as T

export type InterfaceView = { interfaceId?: string; viewValue?: Record<string, unknown> }

export type CreatedEvent = {
  contractId?: string
  createArgument?: Record<string, unknown>
  createdEventBlob?: string
  interfaceViews?: InterfaceView[]
  templateId?: string
}

export type AcsEntry = { event: CreatedEvent; synchronizerId?: string }

export type AcsFilter = { identifierFilter: Record<string, unknown> }

type AcsRow = {
  contractEntry?: {
    JsActiveContract?: { createdEvent?: CreatedEvent; synchronizerId?: string }
  }
}

/** The offset every snapshot below is read at, so one round of reads sees one ledger state. */
export const ledgerEnd = async (ledgerApi: LedgerApi): Promise<string> => {
  const { offset } = await call<{ offset?: string | number }>(ledgerApi, {
    requestMethod: 'get',
    resource: '/v2/state/ledger-end',
  })
  if (offset === undefined) {
    throw new Error('the ledger did not return an offset')
  }
  return String(offset)
}

/** A template filter. `blob` asks for the disclosure payload a write by a non-stakeholder needs. */
export const templateFilter = (templateId: string, blob = false): AcsFilter => ({
  identifierFilter: { TemplateFilter: { value: { templateId, includeCreatedEventBlob: blob } } },
})

/** An interface filter, always with the view: the view is the only reason to read one. */
export const interfaceFilter = (interfaceId: string): AcsFilter => ({
  identifierFilter: { InterfaceFilter: { value: { interfaceId, includeInterfaceView: true } } },
})

export const readAcs = async (
  ledgerApi: LedgerApi,
  { filter, offset, party }: { filter: AcsFilter; offset: string; party: string },
): Promise<AcsEntry[]> => {
  const rows = await call<AcsRow[]>(ledgerApi, {
    requestMethod: 'post',
    resource: '/v2/state/active-contracts',
    body: {
      filter: { filtersByParty: { [party]: { cumulative: [filter] } } },
      activeAtOffset: offset,
      verbose: true,
    },
  })
  return (Array.isArray(rows) ? rows : []).flatMap((row) => {
    const entry = row.contractEntry?.JsActiveContract
    if (entry?.createdEvent === undefined) return []
    return [
      {
        event: entry.createdEvent,
        ...(entry.synchronizerId === undefined ? {} : { synchronizerId: entry.synchronizerId }),
      },
    ]
  })
}

/**
 * The one interface view a read asked for. Only ever one filter goes out per read, so the first
 * entry is that interface's; a view absent means the participant could not compute it.
 */
export const viewOf = (entry: AcsEntry): Record<string, unknown> | undefined =>
  entry.event.interfaceViews?.[0]?.viewValue
