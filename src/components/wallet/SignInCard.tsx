import { useCallback, useEffect, useRef, useState } from 'react'
import { useChainId, useChains, useDisconnect } from '@/lib/magic'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { isWalletNotRegistered, shortAddress, toErrorMessage, clearAuthStorage } from '@/lib/wallet'
import { supabase, supabaseConfigured } from '@/lib/supabase'
import { useSiweLogin } from '@/hooks/useSiweLogin'
import { Avatar } from './Avatar'

type RegStatus = 'checking' | 'ready' | 'unregistered' | 'failed'

type RegResult =
  | { ok: true; message: string }
  | { ok: false; kind: 'unregistered' | 'failed'; error: string }

async function resolveRegStatus(address: string): Promise<RegResult> {
  try {
    if (!supabaseConfigured() || !supabase) {
      return { ok: false, kind: 'failed', error: 'Supabase not configured' }
    }
    const { data, error } = await supabase.functions.invoke('siwe-verify', {
      body: { address },
    })
    if (error) throw error
    if (!data?.message) {
      return { ok: false, kind: 'failed', error: data?.error ?? 'The server did not return a signing message' }
    }
    return { ok: true, message: data.message }
  } catch (err) {
    if (isWalletNotRegistered(err)) {
      return { ok: false, kind: 'unregistered', error: toErrorMessage(err) }
    }
    const msg = toErrorMessage(err)
    const lower = msg.toLowerCase()
    if (lower.includes('not registered')) {
      return { ok: false, kind: 'unregistered', error: msg }
    }
    return { ok: false, kind: 'failed', error: msg }
  }
}

interface SignInCardProps {
  address: string
}

export function SignInCard({ address }: SignInCardProps) {
  const chainId = useChainId()
  const chains = useChains()
  const { disconnectAsync } = useDisconnect()
  const { login, verifying, error, clearError } = useSiweLogin(address)
  const [regStatus, setRegStatus] = useState<RegStatus>('checking')
  const [regError, setRegError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const autoStarted = useRef(false)

  const chainName =
    chains.find((chain) => chain.id === chainId)?.name ?? `Chain ${chainId}`

  const applyResult = useCallback((result: RegResult) => {
    if (result.ok) {
      setMessage(result.message)
      setRegStatus('ready')
      return
    }
    if (result.kind === 'unregistered') {
      setRegStatus('unregistered')
      return
    }
    setRegError(result.error)
    setRegStatus('failed')
  }, [])

  useEffect(() => {
    let cancelled = false
    void resolveRegStatus(address).then((result) => {
      if (!cancelled) applyResult(result)
    })
    return () => {
      cancelled = true
    }
  }, [address, applyResult])

  useEffect(() => {
    if (regStatus === 'ready' && message && !autoStarted.current) {
      autoStarted.current = true
      void login(message)
    }
  }, [regStatus, message, login])

  const recheck = () => {
    autoStarted.current = false
    setRegStatus('checking')
    setMessage(null)
    setRegError(null)
    void resolveRegStatus(address).then(applyResult)
  }

  const retrySign = () => {
    clearError()
    if (message) void login(message)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 rounded-xl border border-border bg-bg p-3">
        <Avatar address={address} size={36} />
        <div className="min-w-0 flex-1">
          <p className="text-xs text-text">You will sign in with the following address</p>
          <p className="truncate font-mono text-sm text-text-h">{address}</p>
        </div>
      </div>

      {regStatus === 'checking' && (
        <div className="flex items-center gap-2 rounded-xl border border-border bg-bg p-3 text-sm text-text">
          <Spinner className="size-4 text-accent" />
          Preparing signing message…
        </div>
      )}

      {regStatus === 'ready' && (
        <>
          <div className="space-y-1.5 rounded-xl border border-border p-3 text-xs text-text">
            <div className="flex justify-between gap-4">
              <span>Network</span>
              <span className="font-medium text-text-h">{chainName}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span>Signing address</span>
              <span className="font-mono text-text-h">{shortAddress(address, 6)}</span>
            </div>
            {message && (
              <details>
                <summary className="cursor-pointer text-accent hover:underline">
                  View message
                </summary>
                <p className="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap break-all leading-relaxed text-text">
                  {message}
                </p>
              </details>
            )}
          </div>

          {error ? (
            <div className="space-y-3">
              <div className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-500">
                <span className="flex-1">{error}</span>
              </div>
              <Button size="lg" className="w-full" loading={verifying} onClick={retrySign}>
                {verifying ? 'Verifying signature…' : 'Retry signature'}
              </Button>
            </div>
          ) : (
            <Button size="lg" className="w-full" loading={verifying} onClick={retrySign}>
              {verifying ? 'Requesting wallet signature…' : 'Sign In'}
            </Button>
          )}
          {verifying && (
            <p className="text-center text-xs text-text">
              Confirm this signature request in your wallet window
            </p>
          )}
        </>
      )}

      {regStatus === 'unregistered' && (
        <div className="space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4">
          <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
            This wallet is not registered
          </p>
          <code className="block break-all rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            {address}
          </code>
          <p className="text-xs text-text">
            Sign-in requires the wallet address to be registered in the system.
            Use a registered wallet, or bind this address in the backend first,
            then re-check.
          </p>
          <Button variant="secondary" size="sm" onClick={recheck}>
            Re-check
          </Button>
        </div>
      )}

      {regStatus === 'failed' && (
        <div className="space-y-3 rounded-xl border border-red-500/30 bg-red-500/10 p-4">
          <p className="text-sm font-medium text-red-500">
            Could not start sign-in: {regError ?? 'Verification failed'}
          </p>
          <Button variant="secondary" size="sm" onClick={recheck}>
            Retry
          </Button>
        </div>
      )}

      <button
        type="button"
        disabled={verifying}
        onClick={() => {
          disconnectAsync()
            .catch(() => {})
            .finally(() => {
              clearAuthStorage()
              window.location.reload()
            })
        }}
        className="block w-full text-center text-sm text-text transition-colors hover:text-text-h disabled:pointer-events-none disabled:opacity-50"
      >
        Change wallet / Cancel
      </button>
    </div>
  )
}