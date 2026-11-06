import { Link } from 'react-router-dom'
import { useState } from 'react'
import { useAccount, useDisconnect } from '@/lib/magic'
import {
  useConnect,
  useConnectors,
  useDisconnect as useWagmiDisconnect,
} from 'wagmi'
import { useToast } from '@/components/ui/toast-context'
import { copyToClipboard, clearAuthStorage, isUserRejected, lastWagmiConnectorUid, shortAddress, toErrorMessage } from '@/lib/wallet'
import { supabase, supabaseConfigured } from '@/lib/supabase'
import { useSession } from '@/hooks/useSession'
import { AccountBadge } from './AccountBadge'

export function AccountDropdown() {
  const { address, chain } = useAccount()
  const { user } = useSession()
  const { disconnectAsync } = useDisconnect()
  const { disconnectAsync: wagmiDisconnect } = useWagmiDisconnect()
  const { connectAsync, isPending: reconnecting } = useConnect()
  const connectors = useConnectors()
  const toast = useToast()
  const [open, setOpen] = useState(false)

  const handleReconnect = async () => {
    const uid = lastWagmiConnectorUid()
    const connector =
      connectors.find((item) => item.uid === uid) ??
      connectors.find((item) => item.type === 'injected')
    if (!connector) {
      toast.push({ title: 'No wallet available to reconnect', variant: 'error' })
      return
    }
    try {
      await connectAsync({ connector })
      toast.push({ title: 'Wallet reconnected', variant: 'success' })
      setOpen(false)
    } catch (err) {
      toast.push({
        title: 'Reconnect failed',
        description: isUserRejected(err) ? 'Connection cancelled' : toErrorMessage(err),
        variant: 'error',
      })
    }
  }

  // 钱包可能在浏览器重启后未自动重连（如 MetaMask 锁定时 eth_accounts 返回空），
  // 登录态以 Supabase 会话为准，地址优先用钱包的，退回会话里的元数据地址。
  const displayAddress = address ?? user?.address ?? null

  if (!displayAddress) {
    return (
      <Link
        to="/login"
        className="flex h-9 items-center rounded-full border border-border bg-bg px-3 text-sm text-text hover:border-accent-border hover:text-text-h"
      >
        Sign in
      </Link>
    )
  }

  const handleCopy = async () => {
    try {
      await copyToClipboard(displayAddress)
      toast.push({ title: 'Address copied', variant: 'success' })
    } catch {
      toast.push({ title: 'Copy failed', variant: 'error' })
    }
    setOpen(false)
  }

  const handleLogout = async () => {
    setOpen(false)
    try {
      if (supabaseConfigured() && supabase) {
        await supabase.auth.signOut()
      }
    } catch {
      /* 会话可能已失效，忽略 */
    }
    await disconnectAsync().catch(() => {})
    await wagmiDisconnect().catch(() => {})
    clearAuthStorage()
    window.location.assign('/login')
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="transition-opacity hover:opacity-85"
      >
        <AccountBadge address={displayAddress} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-2 w-64 overflow-hidden rounded-xl border border-border bg-bg shadow-card">
            <div className="border-b border-border px-4 py-3">
              <p className="text-xs text-text">Current account</p>
              <p className="mt-0.5 truncate font-mono text-sm text-text-h">
                {displayAddress}
              </p>
              {chain?.name && (
                <p className="mt-1 text-xs text-text">
                  Network: <span className="text-text-h">{chain.name}</span>
                </p>
              )}
              {!address && (
                <>
                  <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                    Wallet not connected — reconnect to sign transactions.
                  </p>
                  <button
                    type="button"
                    disabled={reconnecting}
                    onClick={() => {
                      void handleReconnect()
                    }}
                    className="mt-2 w-full rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {reconnecting ? 'Reconnecting…' : 'Reconnect wallet'}
                  </button>
                </>
              )}
            </div>
            <div className="p-1.5">
              <button
                type="button"
                onClick={() => {
                  void handleCopy()
                }}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-text-h transition-colors hover:bg-black/5 dark:hover:bg-white/10"
              >
                <svg viewBox="0 0 24 24" fill="none" className="size-4 text-text">
                  <rect
                    x="9"
                    y="9"
                    width="11"
                    height="11"
                    rx="2"
                    stroke="currentColor"
                    strokeWidth="2"
                  />
                  <path
                    d="M5 15V5a2 2 0 0 1 2-2h10"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
                Copy address ({shortAddress(displayAddress)})
              </button>
              <button
                type="button"
                onClick={() => {
                  void handleLogout()
                }}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-red-500 transition-colors hover:bg-red-500/10"
              >
                <svg viewBox="0 0 24 24" fill="none" className="size-4">
                  <path
                    d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                Sign out
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}