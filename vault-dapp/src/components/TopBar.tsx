import { Identifier, useTheme } from '@bootnodedev/canton-dappbooster'
import { DisconnectButton } from '@bootnodedev/canton-dappbooster/connect'
import { Moon, Sun } from 'lucide-react'
import { buttonClass } from '@/components/Button'
import { ConnectFace } from '@/components/ConnectFace'
import { useParty } from '@/hooks/useParty'

// The party alone decides the face, never `isConnected`: a standing session reports no party while
// the account read is in flight, after it fails, and once a lock clears it, and the connect face is
// the right answer to all three.
export const TopBar = (): React.JSX.Element => {
  const { party } = useParty()
  const { resolved, toggle } = useTheme()
  const next = resolved === 'dark' ? 'light' : 'dark'

  return (
    <header className="border-b border-border bg-surface/60">
      <div className="mx-auto flex w-full max-w-6xl items-center gap-4 px-5 py-3 sm:px-8">
        <span className="font-bold">Canton Vault</span>
        <div className="flex-1" />
        <button
          type="button"
          aria-label={`Switch to ${next} theme`}
          title={`Switch to ${next} theme`}
          className={buttonClass('ghost', 'icon')}
          onClick={toggle}
        >
          {resolved === 'dark' ? <Moon size={16} /> : <Sun size={16} />}
        </button>
        {party === undefined ? (
          <ConnectFace className={buttonClass('primary', 'sm')} />
        ) : (
          <>
            <Identifier value={party.partyId} />
            <DisconnectButton className={buttonClass('secondary', 'sm')} />
          </>
        )}
      </div>
    </header>
  )
}
