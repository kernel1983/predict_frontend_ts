import { useState } from 'react'
import { useAccount, useLoginType } from '@/lib/magic'
import { AppLayout } from '@/components/layout/AppLayout'
import { DepositModal } from '@/components/wallet/DepositModal'
import { ClaimCard } from '@/components/wallet/ClaimCard'
import { WithdrawCard } from '@/components/wallet/WithdrawCard'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { useUsdcBalance } from '@/hooks/useUsdcBalance'
import { useUsdgBalance } from '@/hooks/useUsdgBalance'
import { useSession } from '@/hooks/useSession'
import {
  computeDepositAddress,
  depositFactoriesByMode,
  type DepositFactoryConfig,
} from '@/lib/deposit'
import { formatAmount } from '@/lib/amounts'
import { formatUsdc } from '@/lib/zentra'
import { MIN_DEPOSIT_USDC, MIN_WITHDRAW_USDC, ZENTRA_ENVS } from '@/lib/zentra'
import { useChainModeStore } from '@/store/chainMode'

export default function PortfolioPage() {
  const { address, connector } = useAccount()
  const loginType = useLoginType()
  const { user } = useSession()
  const { mode } = useChainModeStore()
  const env = ZENTRA_ENVS[mode]
  const { data: balance, isLoading, error, refetch } = useUsdcBalance(address)
  const { data: usdgBalance, isLoading: usdgLoading, refetch: refetchUsdg } = useUsdgBalance(address)
  const [depositOpen, setDepositOpen] = useState(false)
  const [withdrawOpen, setWithdrawOpen] = useState(false)

  const factories: DepositFactoryConfig[] = depositFactoriesByMode[mode]
  const predicted = address
    ? factories.map((config) => ({
        config,
        address: computeDepositAddress(config.factory, address, config.initCode),
      }))
    : []

  return (
    <AppLayout>
      <h1 className="text-2xl font-semibold text-text-h">Portfolio</h1>
      <p className="mt-1 text-sm text-text">Your available account balance.</p>

      <section className="mt-6 grid gap-5 lg:max-w-4xl lg:grid-cols-2">
        <div className="rounded-2xl border border-border bg-bg p-5 shadow-card">
          <p className="text-sm text-text">Available</p>
          <div className="mt-2 flex items-baseline justify-between gap-3">
            <p className="font-mono text-3xl font-semibold text-text-h">
              {isLoading ? '…' : error ? '—' : `${formatUsdc(balance ?? 0n, 2)} USDC`}
            </p>
          </div>
          <div className="mt-2 flex items-baseline justify-between gap-3">
            <p className="font-mono text-xl font-semibold text-text-h">
              {usdgLoading ? '…' : `${formatAmount(usdgBalance ?? 0n, 6, 2)} USDG`}
            </p>
            <span className="text-xs text-text">USDG</span>
          </div>
          {error && (
            <p className="mt-2 text-sm text-red-500">
              Unable to load your balance right now.
            </p>
          )}
          <div className="mt-5 flex flex-wrap gap-3">
            <Button onClick={() => setDepositOpen(true)}>Deposit</Button>
            <Button variant="secondary" onClick={() => setWithdrawOpen(true)}>
              Withdraw
            </Button>
          </div>
        </div>

        {env.mintEnabled && (
          <ClaimCard
            address={address}
            onMinted={() => {
              void refetch()
              void refetchUsdg()
            }}
          />
        )}
      </section>

      <DepositModal
        open={depositOpen}
        onClose={() => setDepositOpen(false)}
        predicted={predicted}
        deposits={user?.deposits ?? {}}
        walletConnected={Boolean(address)}
        mainnet={mode === 'mainnet'}
      />

      <section className="mt-6 max-w-4xl rounded-2xl border border-border bg-bg p-5 shadow-card">
        <h2 className="text-base font-semibold text-text-h">Account &amp; funding</h2>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-text">
              Login method
            </p>
            <p className="text-sm text-text-h">
              {loginType === 'magic'
                ? 'Google (Magic wallet)'
                : loginType === 'wallet'
                  ? `Wallet (${connector?.name ?? 'browser wallet'})`
                  : 'Not signed in'}
            </p>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-text">
              Controlling wallet address
            </p>
            <p className="break-all font-mono text-sm text-text-h">
              {address ?? '—'}
            </p>
          </div>
        </div>

        <div className="mt-5 border-t border-border pt-4">
          <p className="text-xs font-medium uppercase tracking-wide text-text">
            Deposit
          </p>
          <ul className="mt-2 space-y-1.5 text-sm text-text">
            <li>
              Networks:{' '}
              <span className="text-text-h">
                {factories.length > 0
                  ? factories.map((factory) => factory.chainName).join(', ')
                  : 'Not configured'}
              </span>
            </li>
            <li>
              Currency: <span className="text-text-h">USDC</span>
            </li>
            <li>
              Minimum deposit:{' '}
              <span className="text-text-h">{MIN_DEPOSIT_USDC} USDC</span>
            </li>
            <li>
              Deposit address:{' '}
              <span className="break-all font-mono text-text-h">
                {predicted[0]?.address ?? '—'}
              </span>
            </li>
          </ul>
          <p className="mt-2 text-xs text-text">
            Funds are credited to your Zentra account on the selected network
            after the deposit is detected.
          </p>
        </div>

        <div className="mt-5 border-t border-border pt-4">
          <p className="text-xs font-medium uppercase tracking-wide text-text">
            Withdraw
          </p>
          <ul className="mt-2 space-y-1.5 text-sm text-text">
            <li>
              Network:{' '}
              <span className="text-text-h">
                {env.withdrawChainName}
              </span>
            </li>
            <li>
              Currency: <span className="text-text-h">USDC</span>
            </li>
            <li>
              Minimum withdrawal:{' '}
              <span className="text-text-h">{MIN_WITHDRAW_USDC} USDC</span>
            </li>
            <li>
              Destination:{' '}
              <span className="break-all font-mono text-text-h">
                {address ?? '—'}
              </span>{' '}
              (your controlling wallet on {env.withdrawChainName})
            </li>
          </ul>
        </div>
      </section>

      <Modal
        open={withdrawOpen}
        onClose={() => setWithdrawOpen(false)}
        title="Withdraw"
      >
        <WithdrawCard address={address} />
      </Modal>
    </AppLayout>
  )
}
