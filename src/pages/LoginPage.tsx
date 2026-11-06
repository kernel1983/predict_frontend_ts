import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import { Spinner } from '@/components/ui/Spinner'
import { ConnectWalletButton } from '@/components/wallet/ConnectWalletButton'
import { SignInCard } from '@/components/wallet/SignInCard'
import { WalletModal } from '@/components/wallet/WalletModal'
import { useAccount, useMagicContextSafe, useMagicLogout } from '@/lib/magic'
import { useAccount as useWagmiAccount, useDisconnect as useWagmiDisconnect } from 'wagmi'
import { useSession } from '@/hooks/useSession'
import { clearAuthStorage } from '@/lib/wallet'

export default function LoginPage() {
  const { user, status } = useSession()
  const { address, isConnected } = useAccount()
  const magic = useMagicContextSafe()
  const logoutMagic = useMagicLogout()
  const wagmiAccount = useWagmiAccount()
  const { disconnectAsync: wagmiDisconnect } = useWagmiDisconnect()
  const [walletModalOpen, setWalletModalOpen] = useState(false)
  const [googlePending, setGooglePending] = useState(false)
  const [googleError, setGoogleError] = useState<string | null>(null)

  if (status === 'loading') {
    return (
      <div className="flex min-h-svh items-center justify-center text-accent">
        <Spinner className="size-8" />
      </div>
    )
  }

  if (user) {
    return <Navigate to="/" replace />
  }

  const phase = isConnected && address ? 'signin' : 'connect'

  const handleGoogleLogin = async () => {
    setGoogleError(null)
    setGooglePending(true)
    try {
      if (wagmiAccount.isConnected) void wagmiDisconnect().catch(() => {})
      // 重定向到 Google；回跳后由 MagicProviders 的 getRedirectResult 完成登录
      await magic?.loginWithGoogle()
    } catch (err) {
      setGooglePending(false)
      setGoogleError(
        err instanceof Error ? err.message : 'Google login failed. Please try again.',
      )
    }
  }

  const handleWalletConnected = () => {
    // 互斥：登出 Magic 邮箱会话
    void logoutMagic().catch(() => {})
  }

  const handleReset = () => {
    clearAuthStorage()
    window.location.reload()
  }

  return (
    <div className="flex min-h-svh items-center justify-center bg-bg px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-8 flex items-center justify-center gap-2 text-xl font-semibold text-text-h">
          <span className="flex size-8 items-center justify-center rounded-lg bg-accent text-base font-bold text-white">
            P
          </span>
          predict
        </div>

        <div className="rounded-2xl border border-border bg-bg p-6 shadow-card">
          <h1 className="text-xl font-semibold text-text-h">Sign in to predict</h1>
          <p className="mb-6 mt-1.5 text-sm text-text">
            Continue with Google or a Web3 wallet — new accounts get a wallet
            created automatically.
          </p>

          <div className="min-h-40">
            {phase === 'connect' ? (
              <div className="space-y-3">
                <ConnectWalletButton
                  loading={googlePending}
                  label="Continue with Google"
                  onClick={() => {
                    void handleGoogleLogin()
                  }}
                />
                {googleError && (
                  <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-500">
                    {googleError}
                  </div>
                )}
                <div className="flex items-center gap-3 py-1">
                  <span className="h-px flex-1 bg-border" />
                  <span className="text-xs text-text">or</span>
                  <span className="h-px flex-1 bg-border" />
                </div>
                <ConnectWalletButton
                  label="Connect wallet"
                  onClick={() => setWalletModalOpen(true)}
                />
              </div>
            ) : (
              <SignInCard address={address!} key={address} />
            )}
          </div>

          <p className="mt-6 text-center text-xs text-text">
            By signing in you agree to the{' '}
            <span className="text-accent">Terms of Service</span> and{' '}
            <span className="text-accent">Privacy Policy</span>
          </p>

          <button
            type="button"
            onClick={handleReset}
            className="mt-4 block w-full text-center text-xs text-text underline hover:text-text-h"
          >
            Can't sign in or out? Reset local state
          </button>
        </div>

        <WalletModal
          open={walletModalOpen}
          onClose={() => setWalletModalOpen(false)}
          onConnected={handleWalletConnected}
        />
      </div>
    </div>
  )
}
