import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAccount } from '@/lib/magic'
import { useQuery } from '@tanstack/react-query'
import { AppLayout } from '@/components/layout/AppLayout'
import { MarketPanel } from '@/components/market/updown/MarketPanel'
import { BalancesPanel } from '@/components/market/updown/BalancesPanel'
import { PriceChart, type PricePoint } from '@/components/market/updown/PriceChart'
import { RoundBar } from '@/components/market/updown/RoundBar'
import { TradePanel } from '@/components/market/updown/TradePanel'
import { OpenOrdersPanel } from '@/components/market/updown/OpenOrdersPanel'
import { MintPanel } from '@/components/market/updown/MintPanel'
import { useHyperliquidPrice } from '@/hooks/useHyperliquidPrice'
import { usePredictBalances } from '@/hooks/usePredictBalances'
import {
  QUOTE_DECIMALS,
  UPDOWN_INTERVAL_LABEL,
  UPDOWN_INTERVAL_SECONDS,
  marketId,
  updownSlug,
  updownWindowStart,
  type UpdownMarket,
} from '@/lib/market'
import { formatRange } from '@/lib/marketTime'
import { describeRound } from '@/lib/round'
import { fetchCandleSnapshot, hlCoinFor } from '@/lib/hyperliquid'
import {
  fetchPredictBook,
  fetchPredictMarketMeta,
  isEnvConfigured,
  ZENTRA_ENVS,
} from '@/lib/zentra'
import { useChainModeStore } from '@/store/chainMode'
import { cn } from '@/lib/cn'

const fmtPrice = (n: number) =>
  `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export function UpdownTemplate({ market }: { market: UpdownMarket }) {
  const navigate = useNavigate()
  const intervalSeconds = UPDOWN_INTERVAL_SECONDS[market.interval]
  const currentStart = updownWindowStart({ ...market, timestamp: undefined })
  const startTs = market.timestamp ?? currentStart
  const endTs = startTs + intervalSeconds
  const isCurrent = startTs === currentStart
  const hlCoin = hlCoinFor(market.symbol)
  const slug = updownSlug({ ...market, timestamp: startTs })
  const mode = useChainModeStore((s) => s.mode)
  const env = ZENTRA_ENVS[mode]
  const configured = isEnvConfigured(env)

  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  const [points, setPoints] = useState<PricePoint[]>([])
  const [target, setTarget] = useState<number | null>(null)
  const [finalPrice, setFinalPrice] = useState<number | null>(null)
  const [balTick, setBalTick] = useState(0)
  const wasLiveRef = useRef(false)

  const { price: livePrice } = useHyperliquidPrice(isCurrent ? hlCoin : null, isCurrent)

  const { address } = useAccount()

  // 1s 心跳：驱动倒计时/进度
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1_000)
    return () => clearInterval(t)
  }, [])

  // 实时轮自动跟随：轮次切换时把 URL 钉到最新一轮
  useEffect(() => {
    if (wasLiveRef.current && market.timestamp !== undefined && market.timestamp !== currentStart) {
      wasLiveRef.current = false
      navigate(`/market/${marketId({ ...market, timestamp: undefined })}`, { replace: true })
    } else {
      wasLiveRef.current = market.timestamp === undefined || market.timestamp === currentStart
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market.timestamp, currentStart])

  // 拉取本轮 1m 蜡烛：已过时间按秒回填；当前轮取 open 为目标价
  useEffect(() => {
    setPoints([])
    setTarget(null)
    setFinalPrice(null)
    if (!hlCoin) return
    let cancelled = false
    const startMs = startTs * 1000
    const endMs = isCurrent ? Date.now() : endTs * 1000
    fetchCandleSnapshot(hlCoin, startMs, endMs)
      .then((candles) => {
        if (cancelled || candles.length === 0) return
        const backfilled: PricePoint[] = []
        const nowSec = Math.floor(Date.now() / 1000)
        candles.forEach((c, idx) => {
          const candleTs = Math.floor(c.t / 1000)
          const isLast = idx === candles.length - 1
          const fillEnd = Math.min(candleTs + 60, isCurrent ? nowSec : candleTs + 60)
          for (let s = candleTs; s < fillEnd; s++) {
            backfilled.push({ time: s, value: c.o })
          }
          if (isLast && backfilled.length > 0) {
            backfilled[backfilled.length - 1] = { time: fillEnd - 1, value: c.c }
          }
        })
        backfilled.sort((a, b) => a.time - b.time)
        setPoints(backfilled)
        setTarget(candles[0].o)
        if (!isCurrent) setFinalPrice(candles[candles.length - 1].c)
      })
      .catch((err) => console.error('Failed to load round candles:', err))
    return () => {
      cancelled = true
    }
  }, [hlCoin, startTs, isCurrent, endTs])

  // 实时价写入当前秒
  useEffect(() => {
    if (livePrice === null || !isCurrent) return
    const nowSec = Math.floor(Date.now() / 1000)
    setPoints((prev) => {
      if (prev.length === 0) return [{ time: nowSec, value: livePrice }]
      const last = prev[prev.length - 1]
      if (last.time === nowSec) {
        return [...prev.slice(0, -1), { time: nowSec, value: livePrice }]
      }
      return [...prev, { time: nowSec, value: livePrice }]
    })
  }, [livePrice, isCurrent])

  // 市场报价币种 / 是否已创建
  const { data: meta } = useQuery({
    queryKey: ['predict-meta', slug],
    queryFn: () => fetchPredictMarketMeta(slug),
    enabled: isCurrent && configured,
    refetchInterval: 30_000,
  })
  const quote = meta?.quote ?? market.quote
  const quoteDecimals = meta?.quoteDecimals ?? QUOTE_DECIMALS[quote]

  // YES/NO 完整盘口（best bid/ask + 深度）
  const { data: book } = useQuery({
    queryKey: ['predict-book', slug, quoteDecimals],
    queryFn: () => fetchPredictBook(slug, quoteDecimals),
    enabled: Boolean(hlCoin) && isCurrent && configured,
    refetchInterval: 2_000,
  })

  // 只用真实盘口报价：某一侧没有挂单（无 bestAsk）时为 null，界面显示 —
  const yesPrice = book?.yes.bestAsk ?? null
  const noPrice = book?.no.bestAsk ?? null

  const balances = usePredictBalances(
    address?.toLowerCase(),
    slug,
    isCurrent && configured,
    balTick,
    quote,
  )
  const lastPrice = isCurrent ? livePrice : finalPrice

  const nav = (timestamp: number) => {
    wasLiveRef.current = false
    navigate(`/market/${marketId({ ...market, timestamp })}`)
  }

  const round = describeRound(startTs, market.interval, now, !isCurrent && finalPrice !== null)

  return (
    <AppLayout>
      <div className="mb-6">
        <Link to="/" className="text-sm text-accent hover:underline">
          ← Back to markets
        </Link>
        <div className="mt-3 flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <p className="text-sm text-text">
              {UPDOWN_INTERVAL_LABEL[market.interval]} price prediction · settles{' '}
              {formatRange(startTs, endTs)}
            </p>
            <h1 className="mt-0.5 text-3xl font-semibold text-text-h">
              {market.asset} Up or Down?
            </h1>
          </div>
          <span className="font-mono text-xs text-text">{slug}</span>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          <RoundBar
            slug={slug}
            state={round.state}
            remaining={round.remaining}
            progress={round.progress}
            isCurrent={round.isCurrent}
            onPrev={() => nav(startTs - intervalSeconds)}
            onNext={() => nav(startTs + intervalSeconds)}
            onCurrent={() => navigate(`/market/${marketId({ ...market, timestamp: undefined })}`)}
          />

          <section className="rounded-2xl border border-border bg-bg p-5 shadow-card">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-text">Last price · {market.symbol.toUpperCase()}</p>
                <p className="font-mono text-2xl font-semibold text-text-h">
                  {lastPrice !== null ? fmtPrice(lastPrice) : '—'}
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs text-text">
                  Target {target !== null ? fmtPrice(target) : '—'}
                </p>
                <p className="mt-1 text-xs">
                  <span
                    className={cn('mr-1.5 inline-block size-1.5 rounded-full align-middle', isCurrent ? 'bg-emerald-500' : 'bg-slate-400')}
                  />
                  {isCurrent ? 'Live via Hyperliquid' : 'Historical'}
                </p>
              </div>
            </div>
            <div className="mt-4">
              {hlCoin ? (
                <PriceChart points={points} target={target} />
              ) : (
                <div className="flex h-[220px] items-center justify-center rounded-xl border border-border text-sm text-text">
                  No price feed for {market.symbol.toUpperCase()}.
                </div>
              )}
            </div>
          </section>

          <MarketPanel
            isLive={isCurrent}
            currentPrice={lastPrice}
            target={target}
            finalPrice={finalPrice}
            yesPrice={yesPrice}
            noPrice={noPrice}
          />
        </div>

        <aside className="space-y-6">
          <TradePanel
            slug={slug}
            quote={quote}
            quoteDecimals={quoteDecimals}
            quoteRaw={balances.quoteRaw}
            yesRaw={balances.yesRaw}
            noRaw={balances.noRaw}
            book={book ?? null}
            marketExists={meta ? meta.exists : null}
            enabled={isCurrent && Boolean(hlCoin)}
            onTraded={() => setBalTick((t) => t + 1)}
          />
          <MintPanel
            slug={slug}
            quote={quote}
            quoteDecimals={quoteDecimals}
            quoteRaw={balances.quoteRaw}
            book={book ?? null}
            marketExists={meta ? meta.exists : null}
            enabled={isCurrent && Boolean(hlCoin)}
            onChanged={() => setBalTick((t) => t + 1)}
          />
          <OpenOrdersPanel
            address={address?.toLowerCase()}
            slug={slug}
            refreshKey={balTick}
            onChanged={() => setBalTick((t) => t + 1)}
            quote={quote}
            quoteDecimals={quoteDecimals}
          />
          <BalancesPanel
            address={address?.toLowerCase()}
            slug={slug}
            enabled={isCurrent && configured}
            refreshKey={balTick}
            quote={quote}
            quoteDecimals={quoteDecimals}
          />
        </aside>
      </div>

      <p className="mt-6 text-center text-xs text-text">
        Price settlement is determined by the round open target vs the final 1-minute Hyperliquid
        close. Trading goes to the zen address ({env.withdrawChainName}) via signed JSON calldata.
      </p>
    </AppLayout>
  )
}