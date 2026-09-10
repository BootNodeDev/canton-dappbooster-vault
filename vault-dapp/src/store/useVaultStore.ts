import { useEffect } from 'react'
import { create } from 'zustand'
import type { VaultProposal, VaultRequest } from '@/backend/requests'
import type { VaultBackend } from '@/backend/VaultBackend'
import { useParty } from '@/hooks/useParty'
import { useBackend } from '@/providers/Backend'
import { errorText } from '@/utils/errorText'

interface VaultState {
  error: string | undefined
  // The poll below sets `loading` every tick, so it says nothing about whether there is anything to
  // show yet. That is what `loaded` is for: it turns true once, and a queue asked for and found
  // empty is what tells the empty state apart from a first read still running.
  loaded: boolean
  loading: boolean
  proposals: readonly VaultProposal[]
  requests: readonly VaultRequest[]

  allocate: (backend: VaultBackend, partyId: string, request: VaultRequest) => Promise<void>
  cancel: (backend: VaultBackend, partyId: string, proposal: VaultProposal) => Promise<void>
  clear: () => void
  deposit: (backend: VaultBackend, partyId: string, amount: string) => Promise<void>
  refresh: (backend: VaultBackend, partyId: string) => Promise<void>
  withdraw: (backend: VaultBackend, partyId: string, amount: string) => Promise<void>
}

// Only the newest refresh may commit: over the network a slow read for the previous party can
// resolve last and clobber the fresh view.
let refreshEpoch = 0

// The vault accepts and settles backstage, so a row changes with nothing happening in this tab.
// Well inside the hour the allocation window runs to, and cheap against a local participant.
const POLL_MS = 5000

export const useVaultStore = create<VaultState>((set, get) => ({
  error: undefined,
  loaded: false,
  loading: false,
  proposals: [],
  requests: [],

  // Bumps the epoch too, so a read in flight for the party being dropped cannot land after it.
  clear: () => {
    refreshEpoch++
    set({ error: undefined, loaded: false, loading: false, proposals: [], requests: [] })
  },

  refresh: async (backend, partyId) => {
    const epoch = ++refreshEpoch
    set({ error: undefined, loading: true })
    try {
      const { proposals, requests } = await backend.requestsOf(partyId)
      if (epoch !== refreshEpoch) return
      set({ loaded: true, loading: false, proposals, requests })
    } catch (err) {
      if (epoch !== refreshEpoch) return
      set({ error: errorText(err), loading: false })
    }
  },

  // Every write re-reads rather than mutating a row: a proposal becomes a request under a new
  // contract id, and an allocation is a contract of its own the row only reports on.
  deposit: async (backend, partyId, amount) => {
    await backend.deposit(partyId, amount)
    await get().refresh(backend, partyId)
  },

  cancel: async (backend, partyId, proposal) => {
    await backend.cancelProposal(partyId, proposal)
    await get().refresh(backend, partyId)
  },

  withdraw: async (backend, partyId, amount) => {
    await backend.withdraw(partyId, amount)
    await get().refresh(backend, partyId)
  },

  allocate: async (backend, partyId, request) => {
    await backend.allocate(partyId, request)
    await get().refresh(backend, partyId)
  },
}))

/**
 * Wires the store to the context backend and the acting party, re-reading whenever either changes
 * and on a timer after that. Call it once per page: a second caller is a second poll.
 *
 * An undefined backend means no deployment or no wallet session yet, so a page renders its connect
 * placeholder instead.
 */
export const useVault = (): { backend: VaultBackend | undefined; partyId: string } => {
  const { backend } = useBackend()
  const { party } = useParty()
  const partyId = party?.partyId ?? ''
  const clear = useVaultStore((state) => state.clear)
  const refresh = useVaultStore((state) => state.refresh)

  useEffect(() => {
    // Dropping the rows on disconnect is the point: they belong to the party that has just gone.
    if (backend === undefined || partyId === '') {
      clear()
      return
    }
    void refresh(backend, partyId)
    const timer = setInterval(() => void refresh(backend, partyId), POLL_MS)
    return () => clearInterval(timer)
  }, [backend, clear, partyId, refresh])

  return { backend, partyId }
}
