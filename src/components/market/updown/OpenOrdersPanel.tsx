import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useChainId, useSendTransaction, useSwitchChain } from '@/lib/magic'
import { useToast } from '@/components/ui/toast-context'
import { isUserRejected, toErrorMessage } from '@/lib/wallet'
import {
  ZEN_CONTRACT,
  ZENTRA_ENVS,
  buildLimitOrderCancelData,
  fetchPredictOpenOrders,
  isEnvConfigured,
  type PredictOpenOrder,
} from '@/lib/zentra'
import { formatAmount } from '@/lib/amounts'
import { QUOTE_DECIMALS, type QuoteToken } from '@/lib/market'
import { useChainModeStore } from '@/store/chainMode'
import { cn } from '@/lib/cn'

export function OpenOrdersPanel({
  address,
  slug,
  refreshKey,
  onChanged,
  quote = 'USDC',
  quoteDecimals,
}: {
  address: string | undefined
  slug: string
  refreshKey: number
  onChanged: () => void
  quote?: QuoteToken
  quoteDecimals?: number
}) {
  const mode = useChainModeStore((s) => s.mode)
  const env = ZENTRA_ENVS[mode]
  const configured = isEnvConfigured(env)
  const decimals = quoteDecimals ?? QUOTE_DECIMALS[quote]
  const toast = useToast()

  const { sendTransactionAsync, isPending: submitting } = useSendTransaction()
  const { switchChainAsync } = useSwitchChain()
  const currentChainId = useChainId()

  const [busyId, setBusyId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const ordersQuery = useQuery({
    queryKey: [
      'predict-open-orders',
      mode,
      slug,
      address?.toLowerCase() ?? '',
      quote,
      decimals,
      refreshKey,
    ],
    queryFn: () => fetchPredictOpenOrders(slug, address ?? '', decimals),
    enabled: configured && Boolean(address),
    refetchInterval: 5_000,
  })

  const orders = ordersQuery.data ?? []
  const fmt = (raw: bigint) => formatAmount(raw, decimals, Math.min(decimals, 2))

  const cancel = async (order: PredictOpenOrder) => {
    if (!address || !configured) return
    setError(null)
    setBusyId(order.id)
    try {
      if (currentChainId !== env.withdrawChainId) {
        await switchChainAsync({ chainId: env.withdrawChainId })
      }
      await sendTransactionAsync({
        chainId: env.withdrawChainId,
        to: ZEN_CONTRACT,
        value: 0n,
        data: buildLimitOrderCancelData(slug, order.token, order.side, order.id),
      })
      toast.push({
        title: `Cancel ${order.side} ${order.token.toUpperCase()} submitted`,
        variant: 'success',
      })
      window.setTimeout(() => {
        setBusyId(null)
        void ordersQuery.refetch()
        onChanged()
      }, 4_000)
    } catch (err) {
      setBusyId(null)
      if (!isUserRejected(err)) setError(toErrorMessage(err))
    }
  }

  return (
    <section className="rounded-2xl border border-border bg-bg p-5 shadow-card">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-text-h">Open limit orders</h2>
        {ordersQuery.isFetching && !ordersQuery.isLoading && (
          <span className="text-[11px] text-text">Updating…</span>
        )}
      </div>

      {!address && (
        <p className="mt-3 text-sm text-text">Connect a wallet to see your orders.</p>
      )}

      {address && !configured && (
        <p className="mt-3 text-sm text-text">
          {env.withdrawChainName} is not configured yet.
        </p>
      )}

      {address && configured && ordersQuery.isLoading && (
        <div className="mt-4 h-20 animate-pulse rounded-xl bg-black/5 dark:bg-white/10" />
      )}

      {address && configured && !ordersQuery.isLoading && orders.length === 0 && (
        <p className="mt-3 text-sm text-text">No open limit orders.</p>
      )}

      {orders.length > 0 && (
        <ul className="mt-3 divide-y divide-border">
          {orders.map((order) => (
            <li key={`${order.token}-${order.side}-${order.id}`} className="py-3">
              <div className="flex items-center justify-between gap-2">
                <span
                  className={cn(
                    'text-sm font-semibold capitalize',
                    order.side === 'buy'
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-red-600 dark:text-red-400',
                  )}
                >
                  {order.side} {order.token.toUpperCase()}
                </span>
                <span className="font-mono text-sm text-text-h">
                  {fmt(order.baseRaw)} shares
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between gap-2">
                <span className="text-[11px] text-text">
                  {Math.round(order.price * 100)}¢ ·{' '}
                  {order.side === 'buy'
                    ? `Escrow ${fmt(order.quoteRaw)} ${quote}`
                    : `Receive ${fmt(order.quoteRaw)} ${quote}`}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    void cancel(order)
                  }}
                  disabled={submitting || busyId === order.id}
                  className="rounded-lg border border-border px-2.5 py-1 text-xs font-semibold text-text-h transition-colors hover:border-red-500/50 hover:text-red-500 disabled:opacity-40"
                >
                  {busyId === order.id ? 'Cancelling…' : 'Cancel'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {(ordersQuery.error || error) && (
        <div className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 p-2.5 text-xs text-red-500">
          {error ?? toErrorMessage(ordersQuery.error)}
        </div>
      )}
    </section>
  )
}
