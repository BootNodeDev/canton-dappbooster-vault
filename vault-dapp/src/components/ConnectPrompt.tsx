import { buttonClass } from '@/components/Button'
import { ConnectFace } from '@/components/ConnectFace'
import { EmptyState } from '@/components/EmptyState'

export const ConnectPrompt = (): React.JSX.Element => (
  <EmptyState
    level={1}
    title="Canton Vault"
    description="Connect a wallet to deposit into the vault, or redeem shares for the underlying."
    action={
      <ConnectFace
        className={buttonClass('primary', 'lg')}
        cancelClassName={buttonClass('secondary', 'lg')}
      />
    }
  />
)
