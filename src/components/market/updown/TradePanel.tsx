import { useState } from 'react'
import {
  useAccount,
  useChains,
  useMagicWallet,
  useSendTransaction,
  useWaitForTransactionReceipt,
} from '@/lib/magic'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/toast-context'
import { ensureWalletChain, isUserRejected, toErrorMessage } from '@/lib/wallet'
import {
  ZEN_CONTRACT,
  ZENTRA_ENVS,
  buildZenCallData,
  isEnvConfigured,
} from '@/lib/zentra'
import { formatAmount, formatAmountInput } from '@/lib/amounts'
import { previewMarketOrder, type SellUnit } from '@/lib/marketOrder'
import { previewLimitOrder } from '@/lib/limitOrder'
import type { PredictBook } from '@/lib/orderBook'
import { QUOTE_DECIMALS, type QuoteToken } from '@/lib/market'
import { useChainModeStore } from '@/store/chainMode'
import { cn } from '@/lib/cn'

const BUY_QUICK = ['1', '5', '10']
const SELL_QUICK_QUOTE = ['0.25', '0.5', '1']
const SELL_QUICK_SHARES = ['25', '50', '100']
const LIMIT_QUICK_SHARES = ['10', '25', '50']

const fmtAmount = (raw: string, decimals: number) =>
  formatAmount(BigInt(raw || '0'), decimals, Math.min(decimals, 2))

/** 价格以「分」表示：0.5 → 50¢，缺报价显示 — */
const fmtCents = (n: number | null) => (n === null ? '—' : `${Math.round(n * 100)}¢`)

export function TradePanel({
  slug,
  quote = 'USDC',
  quoteDecimals = QUOTE_DECIMALS[quote],
  quoteRaw,
  yesRaw,
  noRaw,
  book,
  marketExists,
  enabled,
  onTraded,
}: {
  slug: string
  quote?: QuoteToken
  quoteDecimals?: number
  quoteRaw: string
  yesRaw: string
  noRaw: string
  book: PredictBook | null
  marketExists: boolean | null
  enabled: boolean
  onTraded: () => void
}) {
  const mode = useChainModeStore((s) => s.mode)
  const env = ZENTRA_ENVS[mode]
  const configured = isEnvConfigured(env)
  const toast = useToast()

  const { address } = useAccount()
  const wallet = useMagicWallet()
  const chains = useChains()
  const { sendTransactionAsync, isPending: submitting } = useSendTransaction()

  const [orderType, setOrderType] = useState<'market' | 'limit'>('market')
  const [tab, setTab] = useState<'buy' | 'sell'>('buy')
  const [sellUnit, setSellUnit] = useState<SellUnit>('usdc')
  const [side, setSide] = useState<'up' | 'down'>('up')
  const [amount, setAmount] = useState('')
  const [priceInput, setPriceInput] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>()

  const { data: receipt } = useWaitForTransactionReceipt({
    hash: txHash,
    confirmations: 1,
  })

  const quoteBalance = BigInt(quoteRaw || '0')
  const holding = BigInt(side === 'up' ? yesRaw || '0' : noRaw || '0')
  const isBuy = tab === 'buy'
  const upAsk = book?.yes.bestAsk ?? null
  const downAsk = book?.no.bestAsk ?? null
  const upBid = book?.yes.bestBid ?? null
  const downBid = book?.no.bestBid ?? null
  const sideBook = book ? (side === 'up' ? book.yes : book.no) : null
  const sideAsk = sideBook?.bestAsk ?? null
  const sideBid = sideBook?.bestBid ?? null
  const sidePrice = isBuy ? sideAsk : sideBid
  const orderSide = side === 'up' ? 'yes' : 'no'
  const quickAmounts =
    orderType === 'limit'
      ? LIMIT_QUICK_SHARES
      : isBuy
        ? BUY_QUICK
        : sellUnit === 'usdc'
          ? SELL_QUICK_QUOTE
          : SELL_QUICK_SHARES
  const label = side === 'up' ? 'UP' : 'DOWN'
  const tokenLabel = side === 'up' ? 'YES' : 'NO'

  const ensureTargetChain = async () => {
    const chain = chains.find((item) => item.id === env.withdrawChainId)
    await ensureWalletChain(wallet, {
      chainId: env.withdrawChainId,
      chainName: chain?.name ?? env.withdrawChainName,
      nativeCurrency: chain?.nativeCurrency ?? {
        name: 'Ether',
        symbol: 'ETH',
        decimals: 18,
      },
      rpcUrls: chain?.rpcUrls.default.http ?? [],
      blockExplorerUrls: chain?.blockExplorers?.default
        ? [chain.blockExplorers.default.url]
        : undefined,
    })
  }

  // 校验 + 预估 + 最终入参同源：预览行展示的就是链上会签的那份
  const marketPreview = previewMarketOrder({
    slug,
    side: orderSide,
    buy: isBuy,
    sellUnit,
    amount,
    book: sideBook,
    quoteDecimals,
    quoteLabel: quote,
    quoteBalance,
    holding,
    tokenLabel,
    marketExists,
  })
  const limitPreview = previewLimitOrder({
    slug,
    side: orderSide,
    buy: isBuy,
    price: priceInput,
    amount,
    quoteDecimals,
    quoteLabel: quote,
    quoteBalance,
    holding,
    tokenLabel,
    marketExists,
  })
  const preview = orderType === 'limit' ? limitPreview : marketPreview
  const amountTouched = amount.trim() !== ''
  const liveError = amountTouched ? preview.error : null
  const liveWarning = amountTouched && !preview.error ? preview.warning : null
  const amountInvalid = amountTouched && preview.args === null

  const handleTrade = async () => {
    setFormError(null)
    if (!address || !configured || !enabled) return
    if (!preview.args) {
      setFormError(preview.error ?? 'Enter a valid amount.')
      return
    }
    try {
      await ensureTargetChain()
      const hash = await sendTransactionAsync({
        chainId: env.withdrawChainId,
        account: address,
        to: ZEN_CONTRACT,
        value: 0n,
        data: buildZenCallData(
          orderType === 'limit' ? 'predict_limit_order' : 'predict_market_order',
          preview.args,
        ),
      })
      setTxHash(hash)
      setAmount('')
      if (orderType === 'limit') onTraded()
      toast.push({
        title: `${isBuy ? 'Buy' : 'Sell'} ${label}${orderType === 'limit' ? ' limit' : ''} order submitted`,
        variant: 'success',
      })
    } catch (err) {
      if (!isUserRejected(err)) {
        setFormError(toErrorMessage(err))
      }
    }
  }

  const handleQuick = (v: string) => {
    setAmount(String(Number(v).toFixed(2)))
    setFormError(null)
  }

  const handleMax = () => {
    const input = (value: bigint | null) =>
      value === null
        ? ''
        : formatAmountInput(value, quoteDecimals, Math.min(quoteDecimals, 2))
    if (orderType === 'limit') {
      setAmount(input(preview.maxShares ?? null))
    } else if (isBuy || sellUnit === 'usdc') {
      setAmount(input(preview.maxQuote))
    } else {
      setAmount(input(preview.maxShares ?? holding))
    }
    setFormError(null)
  }

  const switchOrderType = (next: 'market' | 'limit') => {
    if (next === orderType) return
    setOrderType(next)
    setAmount('')
    setFormError(null)
    if (next === 'limit' && priceInput.trim() === '' && sidePrice !== null) {
      setPriceInput(sidePrice.toFixed(2))
    }
  }

  const switchTab = (next: 'buy' | 'sell') => {
    if (next === tab) return
    setTab(next)
    setAmount('')
    setFormError(null)
  }

  const active = enabled && Boolean(address)

  return (
    <section className="rounded-2xl border border-border bg-bg p-5 shadow-card">
      <h2 className="text-base font-semibold text-text-h">Trade</h2>

      <div className="mt-3 flex gap-1 rounded-lg border border-border bg-bg p-0.5">
        {(['market', 'limit'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => switchOrderType(t)}
            className={cn(
              'flex-1 rounded-md px-2 py-1.5 text-xs font-semibold capitalize transition-colors',
              orderType === t
                ? 'bg-accent/10 text-accent'
                : 'text-text hover:text-text-h',
            )}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="mt-3 flex items-center gap-4 border-b border-border">
        {(['buy', 'sell'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => switchTab(t)}
            className={cn(
              '-mb-px border-b-2 pb-1.5 text-xs font-semibold uppercase tracking-wide transition-colors',
              tab === t
                ? t === 'buy'
                  ? 'border-emerald-500 text-emerald-600 dark:text-emerald-400'
                  : 'border-red-500 text-red-600 dark:text-red-400'
                : 'border-transparent text-text hover:text-text-h',
            )}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => setSide('up')}
          className={cn(
            'flex h-11 items-center justify-center gap-1.5 rounded-xl border px-2 text-sm font-semibold transition-colors',
            side === 'up'
              ? 'border-emerald-500 bg-emerald-500 text-white'
              : 'border-border bg-bg text-text-h hover:border-emerald-500/50',
          )}
        >
          <span>↑ UP</span>
          <span
            className={cn(
              'font-mono text-xs font-medium',
              side === 'up' ? 'text-white/80' : 'text-text',
            )}
          >
            {fmtCents(isBuy ? upAsk : upBid)}
          </span>
        </button>
        <button
          type="button"
          onClick={() => setSide('down')}
          className={cn(
            'flex h-11 items-center justify-center gap-1.5 rounded-xl border px-2 text-sm font-semibold transition-colors',
            side === 'down'
              ? 'border-red-500 bg-red-500 text-white'
              : 'border-border bg-bg text-text-h hover:border-red-500/50',
          )}
        >
          <span>↓ DOWN</span>
          <span
            className={cn(
              'font-mono text-xs font-medium',
              side === 'down' ? 'text-white/80' : 'text-text',
            )}
          >
            {fmtCents(isBuy ? downAsk : downBid)}
          </span>
        </button>
      </div>

      <p className="mt-2 text-center text-[11px] text-text">
        {isBuy ? 'Best ask' : 'Best bid'}
        {sidePrice === null ? ' — no orders' : ''}
      </p>

      {orderType === 'limit' && (
        <div className="mt-3">
          <label className="text-xs text-text" htmlFor="limit-price">
            Limit price ({quote} per share)
          </label>
          <input
            id="limit-price"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.50"
            value={priceInput}
            disabled={submitting || !!receipt || !configured || !enabled}
            onChange={(e) => {
              setPriceInput(e.target.value)
              setFormError(null)
            }}
            className="mt-1.5 h-11 w-full rounded-xl border border-border bg-bg px-3 font-mono text-sm text-text-h outline-none transition-colors focus:border-accent-border disabled:opacity-60"
          />
        </div>
      )}

      <div className="mt-3">
        <div className="flex items-center justify-between">
          <label className="text-xs text-text" htmlFor="trade-amount">
            {orderType === 'limit'
              ? `Shares (${tokenLabel})`
              : isBuy
                ? `Amount (${quote})`
                : sellUnit === 'usdc'
                  ? `Amount (${quote} to receive)`
                  : `Shares (${tokenLabel})`}
          </label>
          <span className="text-xs text-text">
            {isBuy ? 'Balance' : 'Available'}{' '}
            <span className="font-mono text-text-h">
              {isBuy
                ? fmtAmount(quoteRaw, quoteDecimals)
                : formatAmount(holding, quoteDecimals, Math.min(quoteDecimals, 2))}
            </span>
          </span>
        </div>
        {orderType === 'market' && !isBuy && (
          <div className="mt-1.5 flex gap-1 rounded-lg border border-border bg-bg p-0.5">
            {(['usdc', 'shares'] as const).map((u) => (
              <button
                key={u}
                type="button"
                onClick={() => {
                  setSellUnit(u)
                  setAmount('')
                  setFormError(null)
                }}
                className={cn(
                  'flex-1 rounded-md px-2 py-1 text-xs font-semibold transition-colors',
                  sellUnit === u
                    ? 'bg-red-500/10 text-red-600 dark:text-red-400'
                    : 'text-text hover:text-text-h',
                )}
              >
                {u === 'usdc' ? `By ${quote}` : 'By shares'}
              </button>
            ))}
          </div>
        )}
        <input
          id="trade-amount"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.0"
          value={amount}
          disabled={submitting || !!receipt || !configured || !enabled}
          onChange={(e) => {
            setAmount(e.target.value)
            setFormError(null)
          }}
          className="mt-1.5 h-11 w-full rounded-xl border border-border bg-bg px-3 font-mono text-sm text-text-h outline-none transition-colors focus:border-accent-border disabled:opacity-60"
        />
        <div className="mt-2 flex gap-2">
          {quickAmounts.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => handleQuick(q)}
              disabled={!enabled}
              className="flex-1 rounded-lg border border-border bg-bg py-1.5 text-sm text-text-h transition-colors hover:border-accent-border disabled:opacity-40"
            >
              {orderType === 'limit' || (!isBuy && sellUnit === 'shares') ? q : `$${q}`}
            </button>
          ))}
          <button
            type="button"
            onClick={handleMax}
            disabled={!enabled}
            className="flex-1 rounded-lg border border-border bg-bg py-1.5 text-sm text-text-h transition-colors hover:border-accent-border disabled:opacity-40"
          >
            Max
          </button>
        </div>
        {amountTouched && (
          <p
            className={cn(
              'mt-2 text-center text-[11px]',
              liveError ? 'text-red-500' : 'text-text',
            )}
          >
            {liveError ??
              (orderType === 'limit'
                ? isBuy
                  ? `Reserve ${preview.estQuote} ${quote} for ${preview.estShares} ${tokenLabel} @ ${preview.avgPrice}`
                  : `Receive ${preview.estQuote} ${quote} for ${preview.estShares} ${tokenLabel} @ ${preview.avgPrice}`
                : isBuy
                  ? `Spend ${preview.estQuote} ${quote} ≈ ${preview.estShares} ${tokenLabel}`
                  : `Receive ≈ ${preview.estQuote} ${quote} (${preview.estShares} ${tokenLabel})`)}
          </p>
        )}
        {liveWarning && (
          <p className="mt-1 text-center text-[11px] text-amber-600 dark:text-amber-400">
            {liveWarning}
          </p>
        )}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 rounded-xl border border-border bg-bg p-3 text-center">
        <div>
          <p className="text-xs text-text">Your YES</p>
          <p className="font-mono text-sm text-emerald-600 dark:text-emerald-400">
            {formatAmount(BigInt(yesRaw || '0'), quoteDecimals, Math.min(quoteDecimals, 2))}
          </p>
        </div>
        <div>
          <p className="text-xs text-text">Your NO</p>
          <p className="font-mono text-sm text-red-600 dark:text-red-400">
            {formatAmount(BigInt(noRaw || '0'), quoteDecimals, Math.min(quoteDecimals, 2))}
          </p>
        </div>
      </div>

      {!configured && (
        <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
          {env.withdrawChainName} is not configured yet. The production indexer
          details are pending.
        </div>
      )}
      {!enabled && configured && (
        <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
          Trading is paused while viewing past rounds. Go to the current round
          to place orders.
        </div>
      )}
      {marketExists === false && configured && (
        <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
          This market is not live on-chain yet. Orders are disabled until the
          market is created.
        </div>
      )}
      {!address && configured && (
        <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
          Connect a wallet to trade.
        </div>
      )}

      {formError && (
        <div className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-500">
          {formError}
        </div>
      )}

      {txHash && !receipt && (
        <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
          Transaction submitted:{' '}
          <a
            href={`${env.explorerBase}/tx/${txHash}`}
            target="_blank"
            rel="noreferrer"
            className="font-mono underline"
          >
            {txHash.slice(0, 12)}…
          </a>{' '}
          Waiting for confirmation…
        </div>
      )}
      {receipt && (
        <div className="mt-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-600 dark:text-emerald-400">
          {orderType === 'limit' ? 'Limit order' : 'Order'} confirmed.{' '}
          <a
            href={`${env.explorerBase}/tx/${txHash}`}
            target="_blank"
            rel="noreferrer"
            className="font-mono underline"
          >
            {txHash?.slice(0, 12)}…
          </a>
        </div>
      )}

      <Button
        size="lg"
        className={cn(
          'mt-4 w-full',
          side === 'down' && '!bg-red-500 !hover:bg-red-500/90',
        )}
        loading={submitting}
        disabled={
          !configured || !active || !!receipt || amountInvalid || marketExists === false
        }
        onClick={() => {
          void handleTrade()
        }}
      >
        {receipt
          ? 'Order placed'
          : submitting
            ? 'Confirming…'
            : orderType === 'limit'
              ? `${isBuy ? 'Buy' : 'Sell'} ${label} limit${priceInput.trim() ? ` @ ${priceInput}` : ''}`
              : `${isBuy ? 'Buy' : 'Sell'} ${label}${sidePrice !== null ? ` ${fmtCents(sidePrice)}` : ''}`}
      </Button>

      <p className="mt-3 break-all text-center font-mono text-[10px] leading-relaxed text-text">
        {orderType === 'limit' ? 'predict_limit_order' : 'predict_market_order'}{' '}
        <span className={cn(amountInvalid && 'text-red-500')}>
          {JSON.stringify(
            preview.args ??
              (orderType === 'limit'
                ? [slug, '0', orderSide, '0']
                : [slug, null, orderSide, '—']),
          )}
        </span>
      </p>

      {receipt && (
        <button
          type="button"
          onClick={() => {
            setTxHash(undefined)
            onTraded()
            window.setTimeout(onTraded, 10_000)
          }}
          className="mt-3 block w-full text-center text-sm text-accent hover:underline"
        >
          Trade again / refresh holdings
        </button>
      )}
    </section>
  )
}