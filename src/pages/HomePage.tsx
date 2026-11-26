import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAccount } from '@/lib/magic'
import { AppLayout } from '@/components/layout/AppLayout'
import { NewChessGameModal } from '@/components/chess/NewChessGameModal'
import { OngoingChessGames, WaitingChessGames } from '@/components/chess/ChessGames'
import {
  PredictionCard,
  type PredictionMarket,
  type PredictionTone,
} from '@/components/prediction/PredictionCard'
import { DepositModal } from '@/components/wallet/DepositModal'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { useSession } from '@/hooks/useSession'
import { useUsdcBalance } from '@/hooks/useUsdcBalance'
import { useMarkets } from '@/hooks/useMarkets'
import { useAssetCtxs } from '@/hooks/useAssetCtxs'
import {
  computeDepositAddress,
  depositFactoriesByMode,
  type DepositFactoryConfig,
} from '@/lib/deposit'
import { formatUsdc } from '@/lib/zentra'
import { hlCoinFor, type HlAssetCtx } from '@/lib/hyperliquid'
import {
  UPDOWN_INTERVAL_SECONDS,
  endOfMonthLabel,
  isLive,
  isNotLive,
  isSteady,
  isUpdown,
  parseMarketId,
  type Market,
} from '@/lib/market'
import { supabaseConfigured, type MarketRow } from '@/lib/supabase'
import { useChainModeStore } from '@/store/chainMode'
import { gameHttpUrl } from '@/lib/gameUrls'

const TONES: Record<string, PredictionTone> = {
  btc: 'orange',
  eth: 'blue',
  sol: 'purple',
  hype: 'purple',
}

const TONE_FALLBACK: PredictionTone = 'green'

interface MarketCard {
  id: string
  market: PredictionMarket
}

function formatPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatChange(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}

function formatCountdown(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return hours > 0
    ? `${pad(hours)}:${pad(minutes)}:${pad(rest)}`
    : `${pad(minutes)}:${pad(rest)}`
}

/** Countdown / settlement label for a market, preferring the row's `expires_at`. */
function endsInLabel(row: MarketRow, market: Market, nowSec: number): string {
  if (row.expires_at) {
    const expiresAt = Math.floor(new Date(row.expires_at).getTime() / 1000)
    if (Number.isFinite(expiresAt)) return formatCountdown(expiresAt - nowSec)
  }

  if (isUpdown(market)) {
    const interval = UPDOWN_INTERVAL_SECONDS[market.interval]
    if (market.timestamp != null) {
      return formatCountdown(market.timestamp + interval - nowSec)
    }
    return formatCountdown(interval - (nowSec % interval))
  }

  if (isSteady(market)) return endOfMonthLabel(market.year, market.month)
  if (isLive(market)) return 'Live'
  if (isNotLive(market)) return '—'
  return '—'
}

function buildCard(
  row: MarketRow,
  quotes: Record<string, HlAssetCtx> | undefined,
  nowSec: number,
): MarketCard | null {
  const market = parseMarketId(row.slug)
  if (!market) return null

  const coin = hlCoinFor(market.symbol)
  const quote = coin ? quotes?.[coin] : undefined
  const startPrice = row.start_price != null ? Number(row.start_price) : null
  const price = quote?.price ?? (Number.isFinite(startPrice) ? startPrice : null)

  return {
    id: row.id,
    market: {
      market,
      price: formatPrice(price),
      change: formatChange(quote?.changePct),
      upChance: 50,
      endsIn: endsInLabel(row, market, nowSec),
      tone: TONES[market.symbol.toLowerCase()] ?? TONE_FALLBACK,
    },
  }
}

export default function HomePage() {
  const { user } = useSession()
  const { address } = useAccount()
  const { mode } = useChainModeStore()
  const [depositOpen, setDepositOpen] = useState(false)
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  const [showNewChessGame, setShowNewChessGame] = useState(false)
  const [casualGames, setCasualGames] = useState<{ id: string; status: string; players: { white: boolean; black: boolean }; moves: number }[]>([])
  const { data: balance, isLoading: balanceLoading, error: balanceError } = useUsdcBalance(address)
  const { data: rows, isPending: marketsLoading, error: marketsError } = useMarkets()
  const { data: quotes } = useAssetCtxs()
  const factories: DepositFactoryConfig[] = depositFactoriesByMode[mode]

  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1_000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const res = await fetch(`${gameHttpUrl(mode)}/games`)
        if (!res.ok) return
        const data = await res.json()
        if (!cancelled && Array.isArray(data.games)) setCasualGames(data.games)
      } catch {
        /* server may be down */
      }
    }
    void load()
    const id = setInterval(load, 5000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  const cards = useMemo(
    () =>
      (rows ?? [])
        .map((row) => buildCard(row, quotes, now))
        .filter((card): card is MarketCard => card !== null),
    [rows, quotes, now],
  )

  const predicted = address
    ? factories.map((config) => ({
        config,
        address: computeDepositAddress(config.factory, address, config.initCode),
      }))
    : []

  return (
    <AppLayout>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-text-h">Markets</h1>
          <p className="mt-1 text-sm text-text">Predict where crypto prices will move next.</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex h-10 items-stretch overflow-hidden rounded-xl border border-border bg-bg shadow-card">
            <Link
              to="/portfolio"
              aria-label="View portfolio"
              className="flex min-w-32 flex-col justify-center px-3"
            >
              <span className="text-[10px] leading-3 text-text">Available</span>
              <span className="font-mono text-xs font-semibold leading-4 text-text-h">
                {balanceLoading ? '…' : balanceError ? '—' : `${formatUsdc(balance ?? 0n, 2)} USDC`}
              </span>
            </Link>
            <Button size="md" onClick={() => setDepositOpen(true)}>Deposit</Button>
          </div>
          <button type="button" onClick={() => setShowNewChessGame(true)} className="rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90">
            + New chess game
          </button>
        </div>
      </div>

      <section className="mt-6">
        <div className="rounded-2xl border border-border bg-bg p-5 shadow-card">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-text-h">Casual Games</h2>
              <p className="mt-1 text-sm text-text">Play instantly on the server, no wallet or login required.</p>
            </div>

          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {casualGames.length === 0 && <p className="text-sm text-text">No casual games yet.</p>}
            {casualGames.map((g) => (
              <Link key={g.id} to={`/casual-chess/${g.id}`} className="flex items-center gap-4 rounded-xl border border-border bg-bg px-4 py-3 shadow-card transition-colors hover:border-accent-border">
                <span className="text-2xl leading-none" aria-hidden="true">♞</span>
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-sm font-medium text-text-h">Game {g.id.slice(0, 8)}</p>
                  <p className="mt-0.5 text-xs text-text">Moves {g.moves} · {g.players.white ? 'W' : '·'} {g.players.black ? 'B' : '·'}</p>
                </div>
                <span className="rounded-full border border-accent-border px-2 py-0.5 text-xs font-medium text-accent">{g.status}</span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      <section className="mt-6">
        <div className="rounded-2xl border border-accent-border bg-accent-bg p-5">
          <div className="flex items-center gap-4">
            <span className="text-4xl leading-none" aria-hidden="true">♞</span>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold text-text-h">Onchain Games</h2>
                <span className="rounded-full border border-accent-border px-2 py-0.5 text-xs font-medium text-accent">GAME</span>
              </div>
              <p className="mt-1 text-sm text-text">Predict white win, draw, or black win.</p>
            </div>
          </div>
          <div className="mt-4">
            <WaitingChessGames />
          </div>
        </div>
        <NewChessGameModal open={showNewChessGame} onClose={() => setShowNewChessGame(false)} />
      </section>

      {!supabaseConfigured() && (
        <p className="mt-4 rounded-xl border border-border bg-bg px-4 py-3 text-sm text-text">
          Supabase is not configured. Set <code>VITE_SUPABASE_URL</code> and{' '}
          <code>VITE_SUPABASE_ANON_KEY</code> in <code>.env</code>, then refresh the page.
        </p>
      )}

      {supabaseConfigured() && marketsLoading && (
        <div className="mt-10 flex justify-center text-accent">
          <Spinner className="size-6" />
        </div>
      )}

      {marketsError && (
        <p className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-500">
          Failed to load markets: {marketsError instanceof Error ? marketsError.message : String(marketsError)}
        </p>
      )}

      {supabaseConfigured() && !marketsLoading && !marketsError && cards.length === 0 && (
        <p className="mt-4 rounded-xl border border-border bg-bg px-4 py-3 text-sm text-text">
          No open markets.
        </p>
      )}

      <OngoingChessGames />


      {mode === 'testnet' && (
        <section className="mt-8">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-text-h">Debug (testnet)</h2>
            <span className="text-xs text-text">live vs notlive control</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <PredictionCard
              market={{
                market: { kind: 'live', symbol: 'btc', asset: 'Bitcoin', quote: 'USDG' },
                price: '$104,286.42',
                change: '+0.38%',
                upChance: 50,
                endsIn: 'Live',
                tone: 'orange',
              }}
              to="/market/btc_updownusdg_live"
            />
            <PredictionCard
              market={{
                market: { kind: 'notlive', symbol: 'btc', asset: 'Bitcoin', quote: 'USDG' },
                price: '$104,286.42',
                change: '+0.38%',
                upChance: 50,
                endsIn: '—',
                tone: 'purple',
              }}
              to="/market/btc_updownusdg_notlive"
            />
          </div>
        </section>
      )}

      <DepositModal
        open={depositOpen}
        onClose={() => setDepositOpen(false)}
        predicted={predicted}
        deposits={user?.deposits ?? {}}
        walletConnected={Boolean(address)}
        mainnet={mode === 'mainnet'}
      />
    </AppLayout>
  )
}
