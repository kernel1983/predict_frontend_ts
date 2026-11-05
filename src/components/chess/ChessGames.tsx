import { Link } from 'react-router-dom'
import { Spinner } from '@/components/ui/Spinner'
import { useChessGames } from '@/hooks/useChessGames'
import { supabaseConfigured, type ChessGameRow, type ChessGameStatus } from '@/lib/supabase'

function shortAddress(address: string | null): string {
  if (!address) return 'Join'
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

function GameRow({ game }: { game: ChessGameRow }) {
  return (
    <Link
      to={`/chess/${game.game_id}`}
      className="flex items-center gap-4 rounded-xl border border-border bg-bg px-4 py-3 shadow-card transition-colors hover:border-accent-border"
    >
      <span className="text-2xl leading-none" aria-hidden="true">♞</span>
      <div className="min-w-0 flex-1">
        <p className="font-mono text-sm font-medium text-text-h">Game {game.game_id}</p>
        <p className="mt-0.5 truncate text-xs text-text">
          White {shortAddress(game.white)} · Black {shortAddress(game.black)}
        </p>
      </div>
      <span className="rounded-full border border-accent-border px-2 py-0.5 text-xs font-medium text-accent">
        {game.black ? 'In progress' : 'Waiting for opponent'}
      </span>
    </Link>
  )
}

const COPY: Record<ChessGameStatus, { empty: string }> = {
  chess_active: { empty: 'No active games' },
  chess_waiting_for_opponent: {
    empty: 'No games waiting for an opponent. Click “+ New chess game” to start one.',
  },
}

function ChessGamesList({ status }: { status: ChessGameStatus }) {
  const { data: games, isPending, error } = useChessGames(status)

  if (!supabaseConfigured()) return null

  return (
    <div>
      {isPending && (
        <div className="flex justify-center rounded-xl border border-border bg-bg px-4 py-6 text-accent shadow-card">
          <Spinner className="size-5" />
        </div>
      )}

      {error && (
        <p className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-500">
          Failed to load games: {error instanceof Error ? error.message : String(error)}
        </p>
      )}

      {games && games.length === 0 && (
        <p className="rounded-xl border border-border bg-bg px-4 py-6 text-sm text-text shadow-card">
          {COPY[status].empty}
        </p>
      )}

      {games && games.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {games.map((game) => (
            <GameRow key={game.id} game={game} />
          ))}
        </div>
      )}
    </div>
  )
}

export function OngoingChessGames() {
  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-text-h">Active games</h2>
        <span className="text-xs text-text">Chess games update in real time</span>
      </div>
      <ChessGamesList status="chess_active" />
    </section>
  )
}

/** Games that exist but have not started yet (no black player joined). */
export function WaitingChessGames() {
  return <ChessGamesList status="chess_waiting_for_opponent" />
}
