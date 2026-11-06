import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAccount, useMagicWallet, useSendTransaction } from '@/lib/magic'
import { useQuery } from '@tanstack/react-query'
import { AppLayout } from '@/components/layout/AppLayout'
import { Button } from '@/components/ui/Button'
import { PriceSourceSwitch } from '@/components/market/PriceSourceSwitch'
import { BalancesPanel } from '@/components/market/updown/BalancesPanel'
import { MarketPanel } from '@/components/market/updown/MarketPanel'
import { PriceChart } from '@/components/market/updown/PriceChart'
import { TradePanel } from '@/components/market/updown/TradePanel'
import { OpenOrdersPanel } from '@/components/market/updown/OpenOrdersPanel'
import { MintPanel } from '@/components/market/updown/MintPanel'
import { useCbBtcPrice } from '@/hooks/useCbBtcPrice'
import { usePredictBalances } from '@/hooks/usePredictBalances'
import { type CbBtcRecord } from '@/lib/cbbtc'
import { WINDOW_SEC, emptyPriceState, ingestPrice, type PriceState } from '@/lib/priceCurve'
import {
  QUOTE_DECIMALS,
  liveUpdownSlug,
  notLiveSlug,
  type LiveUpdownMarket,
  type NotLiveUpdownMarket,
} from '@/lib/market'
import { HyperliquidWS, hlCoinFor } from '@/lib/hyperliquid'
import {
  ZENTRA_ENVS,
  fetchPredictBook,
  fetchPredictMarketMeta,
  fetchPredictMarketProbe,
  isEnvConfigured,
} from '@/lib/zentra'
import { useChainModeStore } from '@/store/chainMode'
import { usePriceSourceStore } from '@/store/priceSource'
import { cn } from '@/lib/cn'
import { ensureWalletChain, isUserRejected, toErrorMessage } from '@/lib/wallet'
import { useToast } from '@/components/ui/toast-context'
import {
  ZEN_CONTRACT,
  buildFreeMintUsdGData,
  parseUsdcAmount,
} from '@/lib/zentra'

const RH_TESTNET_CHAIN = {
  chainId: 46630,
  chainName: 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: ['https://rpc.testnet.chain.robinhood.com'],
  blockExplorerUrls: ['https://explorer.testnet.chain.robinhood.com'],
} as const

const fmtPrice = (n: number) =>
  `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/**
 * UpdownTemplate 的 fork：市场没有结束时间（不按轮次结算，slug 恒定）。
 * 仅用于 testnet 调试 —— 展示 slug 是否已在链上创建、实时 Up/Down 价格等。
 * notlive 复用同一模板，slug 走 notLiveSlug。
 */
export function LiveUpdownTemplate({
  market,
}: {
  market: LiveUpdownMarket | NotLiveUpdownMarket
}) {
  const mode = useChainModeStore((s) => s.mode)
  const env = ZENTRA_ENVS[mode]
  const configured = isEnvConfigured(env)
  const testnet = mode === 'testnet'
  const isUpdownLive = market.kind === 'live'
  const isBtc = market.symbol.toLowerCase() === 'btc'

  const source = usePriceSourceStore((s) => s.source)
  /** base 源只有 cbBTC（BTC），其他 symbol / notlive 页固定走 Hyperliquid */
  const showSourceSwitch = isUpdownLive && isBtc
  const useBase = showSourceSwitch && source === 'base'

  const hlCoin = hlCoinFor(market.symbol)
  const slug = isUpdownLive ? liveUpdownSlug(market) : notLiveSlug(market)

  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  const [hlConnected, setHlConnected] = useState(false)
  const [balTick, setBalTick] = useState(0)
  const [rhSwitching, setRhSwitching] = useState(false)
  const [rhError, setRhError] = useState<string | null>(null)
  const [rhMintError, setRhMintError] = useState<string | null>(null)

  /** 换源/换 symbol 换掉整个 key，把曲线、Last price 一起清空 */
  const feedKey = `${useBase ? 'base' : 'hl'}:${hlCoin ?? ''}`
  const [chart, setChart] = useState<PriceState>(() => emptyPriceState(feedKey))
  if (chart.key !== feedKey) setChart(emptyPriceState(feedKey))
  const { price, points } = chart

  const { address } = useAccount()
  const wallet = useMagicWallet()
  const { sendTransactionAsync, isPending: mintingUsdG } = useSendTransaction()
  const toast = useToast()

  /** 把一个价格并入曲线（连续，不按分钟重置） */
  const ingest = useCallback(
    (value: number, atSec: number) =>
      setChart((prev) => ingestPrice(prev, feedKey, value, atSec)),
    [feedKey],
  )

  // base 源：推送自带服务端时间戳，迟到几秒就覆盖最后一个点
  const lastBasePrice = useRef<number | null>(null)
  const handleBaseRecord = useCallback(
    (record: CbBtcRecord) => {
      lastBasePrice.current = record.priceUsd
      ingest(record.priceUsd, record.ts)
    },
    [ingest],
  )
  const base = useCbBtcPrice(useBase, handleBaseRecord)
  const connected = useBase ? base.connected : hlConnected
  /** 距上次真实推送多久了（补点后价格仍是这个，只是没更新） */
  const baseAgeSec = useBase && base.record ? Math.max(0, now - base.record.ts) : null
  const baseAgeLabel =
    baseAgeSec === null ? null : baseAgeSec > 90 ? `held ${baseAgeSec}s` : `${baseAgeSec}s ago`

  // 1s 心跳
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1_000)
    return () => clearInterval(t)
  }, [])

  /** WS 行情订阅：trades/candle 事件回调里更新价格与秒级点（持续，无轮次） */

  const switchToRhTestnet = async () => {
    setRhError(null)
    if (!wallet) {
      setRhError('Connect a wallet first.')
      return
    }
    setRhSwitching(true)
    try {
      await ensureWalletChain(wallet, RH_TESTNET_CHAIN)
    } catch (err) {
      if (!isUserRejected(err)) {
        setRhError(toErrorMessage(err))
      }
    } finally {
      setRhSwitching(false)
    }
  }

  const mintUsdGOnRh = async () => {
    setRhMintError(null)
    if (!address || !wallet) {
      setRhMintError('Connect a wallet first.')
      return
    }
    try {
      const amount = parseUsdcAmount('100') ?? 100_000_000n
      const hash = await sendTransactionAsync({
        to: ZEN_CONTRACT,
        value: 0n,
        data: buildFreeMintUsdGData(amount),
      })
      toast.push({ title: 'Mint USDG (zentra) submitted', variant: 'success' })
      void hash
    } catch (err) {
      if (!isUserRejected(err)) {
        setRhMintError(toErrorMessage(err))
      }
    }
  }

  useEffect(() => {
    if (!useBase) return
    lastBasePrice.current = null
    const t = setInterval(() => {
      const held = lastBasePrice.current
      if (held === null) return
      ingest(held, Math.floor(Date.now() / 1000))
    }, 1_000)
    return () => clearInterval(t)
  }, [useBase, ingest])

  // WS 行情订阅：trades/candle 事件回调里更新价格与秒级点（持续，无轮次）
  useEffect(() => {
    if (!hlCoin || useBase) return
    const ws = new HyperliquidWS()
    ws.on('price', (data) => {
      const p = (data as { price: number }).price
      ingest(p, Math.floor(Date.now() / 1000))
    })
    ws.on('candle', (data) => {
      const close = (data as { candle: { close: number } }).candle.close
      setChart((prev) => (prev.key === feedKey ? { ...prev, price: close } : prev))
    })
    ws.on('connected', () => setHlConnected(true))
    ws.on('disconnected', () => setHlConnected(false))
    ws.connect()
    ws.subscribeTrades(hlCoin)
    ws.subscribeCandle(hlCoin, '1m')
    return () => {
      ws.disconnect()
    }
  }, [hlCoin, useBase, feedKey, ingest])

  const { data: meta } = useQuery({
    queryKey: ['predict-meta-live', slug],
    queryFn: () => fetchPredictMarketMeta(slug),
    enabled: configured,
    refetchInterval: 30_000,
  })
  const quote = meta?.quote ?? 'USDC'
  const quoteDecimals = meta?.quoteDecimals ?? QUOTE_DECIMALS[quote]

  // YES/NO 完整盘口（best bid/ask + 深度）
  const { data: book } = useQuery({
    queryKey: ['predict-book-live', slug, quoteDecimals],
    queryFn: () => fetchPredictBook(slug, quoteDecimals),
    enabled: Boolean(hlCoin) && configured,
    refetchInterval: 2_000,
  })

  // 只用真实盘口报价：某一侧没有挂单（无 bestAsk）时为 null，界面显示 —，不做启发式填充
  const yesPrice = book?.yes.bestAsk ?? null
  const noPrice = book?.no.bestAsk ?? null

  // 调试探测：slug 是否已在链上创建
  const probe = useQuery({
    queryKey: ['market-probe', slug],
    queryFn: () => fetchPredictMarketProbe(slug),
    enabled: configured,
    refetchInterval: 10_000,
  })

  const balances = usePredictBalances(
    address?.toLowerCase(),
    slug,
    configured,
    balTick,
    quote,
  )

  return (
    <AppLayout>
      <div className="mb-6">
        <Link to="/" className="text-sm text-accent hover:underline">
          ← Back to markets
        </Link>
        <div className="mt-3 flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'inline-block rounded-full px-2.5 py-0.5 text-xs font-medium',
                  isUpdownLive
                    ? 'bg-red-500/10 text-red-500'
                    : 'bg-gray-500/10 text-gray-500',
                )}
              >
                {isUpdownLive ? 'LIVE' : 'NOT LIVE'}
              </span>
              <span className="text-xs text-text">
                {isUpdownLive ? 'no fixed settlement' : 'control · market not created'}
              </span>
            </div>
            <h1 className="mt-1 text-3xl font-semibold text-text-h">
              {market.asset} Up or Down?
            </h1>
          </div>
          <span className="font-mono text-xs text-text">{slug}</span>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          <section className="rounded-2xl border border-border bg-bg p-5 shadow-card">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs text-text">
                  Last price ·{' '}
                  {useBase ? 'cbBTC/USDC (Base)' : `${market.symbol.toUpperCase()} (Hyperliquid)`}
                </p>
                <p className="font-mono text-2xl font-semibold text-text-h">
                  {price !== null ? fmtPrice(price) : '—'}
                </p>
              </div>
              <div className="flex items-start gap-3">
                <div className="text-right">
                  <p className="text-xs">
                    <span
                      className={cn(
                        'mr-1.5 inline-block size-1.5 rounded-full align-middle',
                        connected ? 'bg-emerald-500' : 'bg-red-500',
                      )}
                    />
                    {connected ? (useBase ? 'Live via Base' : 'Live via Hyperliquid') : 'Disconnected'}
                    {baseAgeLabel && (
                      <span
                        className={cn(
                          'ml-1.5',
                          baseAgeSec !== null && baseAgeSec > 90
                            ? 'text-amber-600 dark:text-amber-400'
                            : 'text-text',
                        )}
                      >
                        {baseAgeLabel}
                      </span>
                    )}
                  </p>
                </div>
                {showSourceSwitch && <PriceSourceSwitch />}
              </div>
            </div>
            <div className="mt-4">
              {hlCoin ? (
                <PriceChart points={points} target={null} />
              ) : (
                <div className="flex h-[220px] items-center justify-center rounded-xl border border-border text-sm text-text">
                  No price feed for {market.symbol.toUpperCase()}.
                </div>
              )}
            </div>
          </section>

          <MarketPanel
            isLive
            currentPrice={price}
            target={null}
            finalPrice={null}
            yesPrice={yesPrice}
            noPrice={noPrice}
          />

          {testnet && (
            <section className="rounded-2xl border border-dashed border-accent-border bg-bg p-5 shadow-card">
              <h2 className="text-base font-semibold text-text-h">Debug orderbook (testnet)</h2>
              <p className="mt-1 text-xs text-text">
                raw <code className="font-mono">/api/predict_orderbook?slug=</code> · refreshed 2s ·
                levels shown as price × shares resting
              </p>
              <div className="mt-3 grid grid-cols-2 gap-3">
                {(['yes', 'no'] as const).map((side) => {
                  const s = book?.[side]
                  return (
                    <div key={side} className="rounded-xl border border-border bg-bg p-3">
                      <p
                        className={cn(
                          'text-sm font-semibold',
                          side === 'yes'
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : 'text-red-600 dark:text-red-400',
                        )}
                      >
                        {side.toUpperCase()}
                      </p>
                      <dl className="mt-2 space-y-1 text-xs">
                        <div className="flex justify-between">
                          <dt className="text-text">bestAsk</dt>
                          <dd className="font-mono text-text-h">
                            {s?.bestAsk?.toFixed(4) ?? '—'}
                          </dd>
                        </div>
                        <div className="flex justify-between">
                          <dt className="text-text">bestBid</dt>
                          <dd className="font-mono text-text-h">
                            {s?.bestBid?.toFixed(4) ?? '—'}
                          </dd>
                        </div>
                        <div className="flex justify-between">
                          <dt className="text-text">asks / bids</dt>
                          <dd className="font-mono text-text-h">
                            {s ? `${s.asks.length} / ${s.bids.length}` : '—'}
                          </dd>
                        </div>
                      </dl>
                      {s && (s.asks.length > 0 || s.bids.length > 0) ? (
                        <div className="mt-2 space-y-0.5 font-mono text-[11px] text-text">
                          {s.asks
                            .slice(0, 3)
                            .map((l, i) => (
                              <div key={`a${i}`} className="flex justify-between">
                                <span>ask {l.price.toFixed(2)}</span>
                                <span>× {l.size.toFixed(2)}</span>
                              </div>
                            ))}
                          {s.bids
                            .slice(0, 3)
                            .map((l, i) => (
                              <div key={`b${i}`} className="flex justify-between">
                                <span>bid {l.price.toFixed(2)}</span>
                                <span>× {l.size.toFixed(2)}</span>
                              </div>
                            ))}
                        </div>
                      ) : (
                        <p className="mt-2 text-[11px] text-text">empty — no resting orders</p>
                      )}
                    </div>
                  )
                })}
              </div>
            </section>
          )}
        </div>

        <aside className="space-y-6">
          {testnet && (
            <section className="rounded-2xl border border-dashed border-accent-border bg-bg p-5 shadow-card">
              <h2 className="text-base font-semibold text-text-h">Debug (testnet)</h2>

              <dl className="mt-3 space-y-2 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <dt className="shrink-0 text-text">Market slug</dt>
                  <dd className="truncate font-mono text-text-h">{slug}</dd>
                </div>

                <div className="flex items-center justify-between gap-3">
                  <dt className="shrink-0 text-text">Created on-chain</dt>
                  <dd
                    className={cn(
                      'font-mono',
                      probe.data?.marketExists
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-amber-600 dark:text-amber-400',
                    )}
                  >
                    {probe.isLoading
                      ? 'checking…'
                      : probe.data?.marketExists
                        ? `yes (${probe.data.foundPrefix})`
                        : 'no / not found'}
                  </dd>
                </div>

                <div className="flex items-center justify-between gap-3">
                  <dt className="shrink-0 text-text">Orderbook exists</dt>
                  <dd className="font-mono text-text-h">
                    {probe.data?.orderbookExists ? 'yes' : 'no'}
                  </dd>
                </div>

                <div className="flex items-center justify-between gap-3">
                  <dt className="shrink-0 text-text">Chart points</dt>
                  <dd className="font-mono text-text-h">
                    {points.length}
                    {points.length > 1 && (
                      <span className="text-text">
                        {' '}
                        (rolling {points[points.length - 1].time - points[0].time}s)
                      </span>
                    )}
                  </dd>
                </div>

                <div className="flex items-center justify-between gap-3">
                  <dt className="shrink-0 text-text">Last price</dt>
                  <dd className="font-mono text-text-h">
                    {price !== null ? fmtPrice(price) : '—'}
                  </dd>
                </div>
              </dl>

              {showSourceSwitch && (
                <div className="mt-4 rounded-xl border border-border bg-bg p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs text-text">Price source</p>
                    <PriceSourceSwitch />
                  </div>
                  <dl className="mt-2 space-y-1 text-[11px]">
                    <div className="flex justify-between gap-2">
                      <dt className="text-text">feed</dt>
                      <dd className="truncate font-mono text-text-h">
                        {useBase
                          ? `cbBTC/${base.hello?.quote ?? 'USDC'} · base ${base.hello?.networkId ?? 8453}`
                          : `${hlCoin ?? '—'} perp · hyperliquid`}
                      </dd>
                    </div>
                    {useBase && (
                      <>
                        <div className="flex justify-between gap-2">
                          <dt className="shrink-0 text-text">socket</dt>
                          <dd className="truncate font-mono text-text-h" title={base.url}>
                            {base.url}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt className="shrink-0 text-text">upstream</dt>
                          <dd className="font-mono text-text-h">
                            {base.degraded
                              ? `poll (${base.degraded.code})`
                              : base.record?.mode || (base.connected ? 'connecting…' : '—')}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt className="shrink-0 text-text">pool / block</dt>
                          <dd className="truncate font-mono text-text-h">
                            {base.hello?.pool
                              ? `${base.hello.pool.slice(0, 8)}…${
                                  base.record?.blockNumber != null
                                    ? ` · ${base.record.blockNumber.toLocaleString()}`
                                    : ''
                                }`
                              : '—'}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt className="shrink-0 text-text">last push</dt>
                          <dd
                            className={cn(
                              'font-mono',
                              baseAgeSec !== null && baseAgeSec > 90
                                ? 'text-amber-600 dark:text-amber-400'
                                : 'text-text-h',
                            )}
                          >
                            {baseAgeSec === null
                              ? 'no data yet'
                              : baseAgeSec > 90
                                ? `held ${baseAgeSec}s`
                                : `${baseAgeSec}s ago`}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt className="shrink-0 text-text">clients</dt>
                          <dd className="font-mono text-text-h">{base.hello?.clients ?? '—'}</dd>
                        </div>
                      </>
                    )}
                  </dl>
                  {useBase && !base.connected && base.error && (
                    <p className="mt-2 text-[11px] text-red-500">
                      {base.error.code}: {base.error.message} — is <code>python ws.py</code>{' '}
                      running?
                    </p>
                  )}
                  {useBase && base.degraded && (
                    <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
                      Codex ws refused ({base.degraded.message}) → polling every{' '}
                      {base.degraded.intervalSec ?? '?'}s
                    </p>
                  )}
                </div>
              )}

              <div className="mt-4 rounded-xl border border-border bg-bg p-3">
                <p className="text-xs text-text">Live Up / Down prices (best ask)</p>
                <p className="mt-2 text-[11px] text-text">
                  yesAsk = {yesPrice !== null ? yesPrice.toFixed(4) : '—'} · noAsk ={' '}
                  {noPrice !== null ? noPrice.toFixed(4) : '—'}
                  {book?.yes != null || book?.no != null
                    ? ' · from predict_orderbook'
                    : ' · no asks on the book'}
                </p>
              </div>

              {testnet && (
                <div className="mt-4 rounded-xl border border-border bg-bg p-3">
                  <p className="text-xs text-text">Network tools</p>
                  <Button
                    size="sm"
                    className="mt-2 w-full"
                    loading={rhSwitching}
                    disabled={rhSwitching}
                    onClick={() => void switchToRhTestnet()}
                  >
                    Switch wallet to Robinhood Chain Testnet (46630)
                  </Button>
                  <p className="mt-1 text-[11px] text-text">
                    Adds RPC/explorer if missing and switches to chain 46630.
                  </p>
                  {rhError && (
                    <p className="mt-2 text-xs text-red-500">{rhError}</p>
                  )}
                  <Button
                    size="sm"
                    className="mt-2 w-full"
                    loading={mintingUsdG}
                    disabled={mintingUsdG}
                    onClick={() => void mintUsdGOnRh()}
                  >
                    Mint 100 Mock USDG via zentra
                  </Button>
                  <p className="mt-1 text-[11px] text-text">
                    Sends token_mint_free to {ZEN_CONTRACT} on current network.
                  </p>
                  {rhMintError && (
                    <p className="mt-2 text-xs text-red-500">{rhMintError}</p>
                  )}
                </div>
              )}

              {probe.data?.details && (
                <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap rounded-xl border border-border bg-bg p-3 font-mono text-[11px] leading-relaxed text-text">
                  {probe.data.details}
                </pre>
              )}
              {probe.error && (
                <p className="mt-2 text-xs text-red-500">
                  Probe failed: {String(probe.error)}
                </p>
              )}
            </section>
          )}

          {testnet && (
            <TradePanel
              slug={slug}
              quote={quote}
              quoteDecimals={quoteDecimals}
              quoteRaw={balances.quoteRaw}
              yesRaw={balances.yesRaw}
              noRaw={balances.noRaw}
              book={book ?? null}
              marketExists={meta ? meta.exists : null}
              enabled={Boolean(hlCoin)}
              onTraded={() => setBalTick((t) => t + 1)}
            />
          )}

          {testnet && (
            <MintPanel
              slug={slug}
              quote={quote}
              quoteDecimals={quoteDecimals}
              quoteRaw={balances.quoteRaw}
              book={book ?? null}
              marketExists={meta ? meta.exists : null}
              enabled={Boolean(hlCoin)}
              onChanged={() => setBalTick((t) => t + 1)}
            />
          )}

          {testnet && (
            <OpenOrdersPanel
              address={address?.toLowerCase()}
              slug={slug}
              refreshKey={balTick}
              onChanged={() => setBalTick((t) => t + 1)}
              quote={quote}
              quoteDecimals={quoteDecimals}
            />
          )}

          <BalancesPanel
            address={address?.toLowerCase()}
            slug={slug}
            enabled={configured}
            refreshKey={balTick}
            quote={quote}
            quoteDecimals={quoteDecimals}
          />
        </aside>
      </div>

      <p className="mt-6 text-center text-xs text-text">
        Continuous up/down market with no settlement. The chart keeps a rolling window of the last{' '}
        {WINDOW_SEC / 60} minutes and is never reset, from{' '}
        {useBase ? 'cbBTC/USDC (Base pool)' : 'Hyperliquid trades'}. Orders go to the zen address (
        {env.withdrawChainName}) via signed JSON calldata.
      </p>
    </AppLayout>
  )
}