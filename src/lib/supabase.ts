import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '')
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY ?? ''

export const supabase =
  SUPABASE_URL && SUPABASE_ANON_KEY
    ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : (null as any)

export function supabaseConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY)
}

/** Row shape of the public `markets` table (see backend/supabase_schema.sql). */
export interface MarketRow {
  id: string
  slug: string
  token: string
  market_type: string
  title: string | null
  description: string | null
  start_price: number | null
  start_at: string | null
  expires_at: string | null
  interval_seconds: number | null
  end_price: number | null
  outcome: string | null
  onchain_status: string | null
  onchain_tx: string | null
  status: string
  created_at: string
}

/** Row shape of the public `chess_games` table (see backend/supabase_schema.sql). */
export interface ChessGameRow {
  id: string
  game_id: string
  white: string
  black: string | null
  quote_tick: string | null
  status: string
  chain: string
  block_number: number | null
  tx_hash: string | null
  note: string | null
  created_at: string
}

/**
 * Read chess games straight from Supabase (`chess_games` is RLS read-only for `anon`).
 * Worker writes `chess_active` (both players joined) or `chess_waiting_for_opponent`.
 */
export type ChessGameStatus = 'chess_active' | 'chess_waiting_for_opponent'

export async function fetchChessGames(status: ChessGameStatus = 'chess_active'): Promise<ChessGameRow[]> {
  if (!supabaseConfigured()) {
    throw new Error('Supabase is not configured: set VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY')
  }

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/chess_games?select=*&status=eq.${status}&order=created_at.desc`,
    {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
    },
  )

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Failed to load chess_games (${res.status})${detail ? `: ${detail}` : ''}`)
  }

  const data: unknown = await res.json()
  if (!Array.isArray(data)) return []
  return data as ChessGameRow[]
}

/** Read open markets straight from Supabase (RLS exposes the table read-only to `anon`). */
export async function fetchMarkets(): Promise<MarketRow[]> {
  if (!supabaseConfigured()) {
    throw new Error('Supabase is not configured: set VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY')
  }

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/markets?select=*&status=eq.open&order=created_at.asc`,
    {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
    },
  )

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Failed to load markets (${res.status})${detail ? `: ${detail}` : ''}`)
  }

  const data: unknown = await res.json()
  if (!Array.isArray(data)) return []
  return data as MarketRow[]
}
