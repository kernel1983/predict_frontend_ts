import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { AppLayout } from '@/components/layout/AppLayout'
import { cn } from '@/lib/cn'

import { useAccount, useSignMessage } from '@/lib/magic'
import { useChainModeStore } from '@/store/chainMode'
import { gameHttpUrl, gameWsUrl } from '@/lib/gameUrls'

const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
const ranks = [8, 7, 6, 5, 4, 3, 2, 1]
const pieceGlyphs: Record<string, string> = {
  K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙',
  k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟',
}
type Side = 'w' | 'b'

function sideOf(piece: string): Side | null {
  if (!piece || piece === '.') return null
  if (piece === piece.toUpperCase()) return 'w'
  return 'b'
}
function onBoard(r: number, c: number) { return r >= 0 && r < 8 && c >= 0 && c < 8 }

// Reuse move-generation helpers (same as zip101 state machine, client-side for highlighting)
const KNIGHT_DIRS = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]]
const KING_DIRS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]]
const DIAG_DIRS = [[-1, -1], [-1, 1], [1, -1], [1, 1]]
const STRAIGHT_DIRS = [[-1, 0], [0, -1], [0, 1], [1, 0]]

function pseudoMoves(board: string[][], r: number, c: number): [number, number][] {
  const p = board[r][c]
  if (!p || p === '.') return []
  const side = sideOf(p)
  if (!side) return []
  const opp: Side = side === 'w' ? 'b' : 'w'
  const moves: [number, number][] = []
  if (p === 'N' || p === 'n') {
    for (const [dr, dc] of KNIGHT_DIRS) {
      const nr = r + dr, nc = c + dc
      if (!onBoard(nr, nc)) continue
      const tp = board[nr][nc]
      if (tp === '.' || sideOf(tp) === opp) moves.push([nr, nc])
    }
    return moves
  }
  if (p === 'K' || p === 'k') {
    for (const [dr, dc] of KING_DIRS) {
      const nr = r + dr, nc = c + dc
      if (!onBoard(nr, nc)) continue
      const tp = board[nr][nc]
      if (tp === '.' || sideOf(tp) === opp) moves.push([nr, nc])
    }
    return moves
  }
  let dirs: number[][] = []
  if (p === 'B' || p === 'b') dirs = DIAG_DIRS
  else if (p === 'R' || p === 'r') dirs = STRAIGHT_DIRS
  else if (p === 'Q' || p === 'q') dirs = [...DIAG_DIRS, ...STRAIGHT_DIRS]
  if (dirs.length && p !== 'P' && p !== 'p') {
    for (const [dr, dc] of dirs) {
      let nr = r + dr, nc = c + dc
      while (onBoard(nr, nc)) {
        const tp = board[nr][nc]
        if (tp === '.') { moves.push([nr, nc]); nr += dr; nc += dc; continue }
        if (sideOf(tp) === opp) moves.push([nr, nc])
        break
      }
    }
    return moves
  }
  if (p === 'P') {
    if (onBoard(r - 1, c) && board[r - 1][c] === '.') { moves.push([r - 1, c]); if (r === 6 && onBoard(r - 2, c) && board[r - 2][c] === '.') moves.push([r - 2, c]) }
    for (const dc of [-1, 1]) { const nr = r - 1, nc = c + dc; if (!onBoard(nr, nc)) continue; const tp = board[nr][nc]; if (tp !== '.' && sideOf(tp) === 'b') moves.push([nr, nc]) }
    return moves
  }
  if (p === 'p') {
    if (onBoard(r + 1, c) && board[r + 1][c] === '.') { moves.push([r + 1, c]); if (r === 1 && onBoard(r + 2, c) && board[r + 2][c] === '.') moves.push([r + 2, c]) }
    for (const dc of [-1, 1]) { const nr = r + 1, nc = c + dc; if (!onBoard(nr, nc)) continue; const tp = board[nr][nc]; if (tp !== '.' && sideOf(tp) === 'w') moves.push([nr, nc]) }
    return moves
  }
  return moves
}
function cloneBoard(board: string[][]) { return board.map((row) => [...row]) }
function findKing(board: string[][], side: Side) {
  const target = side === 'w' ? 'K' : 'k'
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (board[r][c] === target) return [r, c] as [number, number]
  return null
}
function squareAttacked(board: string[][], r: number, c: number, bySide: Side) {
  for (let sr = 0; sr < 8; sr++) for (let sc = 0; sc < 8; sc++) {
    const p = board[sr][sc]
    if (!p || p === '.') continue
    if (sideOf(p) !== bySide) continue
    if (pseudoMoves(board, sr, sc).some(([mr, mc]) => mr === r && mc === c)) return true
  }
  return false
}
function isInCheck(board: string[][], side: Side) {
  const king = findKing(board, side)
  if (!king) return true
  const opp: Side = side === 'w' ? 'b' : 'w'
  return squareAttacked(board, king[0], king[1], opp)
}
function applyMove(board: string[][], fr: number, fc: number, tr: number, tc: number) {
  const nb = cloneBoard(board)
  nb[tr][tc] = nb[fr][fc]
  nb[fr][fc] = '.'
  return nb
}
function legalTargets(board: string[][], r: number, c: number): [number, number][] {
  const p = board[r][c]
  const side = sideOf(p)
  if (!side) return []
  const targets = pseudoMoves(board, r, c)
  return targets.filter(([tr, tc]) => !isInCheck(applyMove(board, r, c, tr, tc), side))
}

interface ServerState {
  gameId: string
  board: string[][]
  turn: 'w' | 'b'
  moveCount: number
  status: 'waiting' | 'active' | 'finished'
  result: string | null
  players: { white: boolean; black: boolean }
  white: string | null
  black: string | null
  spectators: number
}


import { getAnonymousCasualAccount } from '@/lib/casualIdentity'

export default function CasualChessPage() {
  const { gameId: routeGameId } = useParams()
  const mode = useChainModeStore((s) => s.mode)
  const GAME_HTTP_URL = gameHttpUrl(mode)
  const GAME_WS_URL = gameWsUrl(mode)
  const navigate = useNavigate()
  const randomAccount = getAnonymousCasualAccount()
  const { address: walletAddress } = useAccount()
  const { signMessageAsync } = useSignMessage()
  const playerAddress = walletAddress ?? randomAccount.address
  const signMessage = useCallback(async (message: string) => {
    if (walletAddress) {
      const sig = await signMessageAsync({ message })
      if (!sig) throw new Error('signature failed')
      return sig
    }
    return await randomAccount.signMessage({ message })
  }, [walletAddress, signMessageAsync])

  const wsRef = useRef<WebSocket | null>(null)
  const [connected, setConnected] = useState(false)
  const [game, setGame] = useState<ServerState | null>(null)
  const [gameIdInput, setGameIdInput] = useState(routeGameId ?? '')
  const [selected, setSelected] = useState<{ r: number; c: number } | null>(null)
  const [promotionMove, setPromotionMove] = useState<{ move: string } | null>(null)
  const [moveError, setMoveError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)


  const fetchState = useCallback(async (gid: string) => {
    try {
      const res = await fetch(`${GAME_HTTP_URL}/games/${gid}`)
      if (!res.ok) return
      const data = await res.json()
      setGame(data as ServerState)
    } catch {
      /* ignore */
    }
  }, [])

  // WebSocket for real-time updates
  useEffect(() => {
    const gid = routeGameId ?? gameIdInput
    if (!gid) return
    const ws = new WebSocket(`${GAME_WS_URL}?gameId=${encodeURIComponent(gid)}`)
    ws.onopen = () => setConnected(true)
    ws.onclose = () => { setConnected(false); wsRef.current = null }
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        if (msg.type === 'state') setGame(msg as ServerState)
      } catch { /* ignore */ }
    }
    wsRef.current = ws
    void fetchState(gid)
    return () => { ws.close(); wsRef.current = null }
  }, [routeGameId, gameIdInput, fetchState])


  const signAndPost = useCallback(async (path: string, message: string, extra: Record<string, unknown> = {}) => {
    const signature = await signMessage(message)
    const res = await fetch(`${GAME_HTTP_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, signature, ...extra }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
    return data
  }, [signMessage])

  const createGame = useCallback(async () => {
    setMoveError(null)
    const ts = Math.floor(Date.now() / 1000)
    const message = `casual-chess:create:${ts}`
    try {
      const data = await signAndPost('/games', message)
      if (data.gameId) navigate(`/casual-chess/${data.gameId}`)
    } catch (e) {
      setMoveError(e instanceof Error ? e.message : 'create failed')
    }
  }, [navigate, signAndPost])

  const joinGame = useCallback(async () => {
    const gid = gameIdInput.trim()
    if (!gid) { setMoveError('Enter game id'); return }
    setMoveError(null)
    const ts = Math.floor(Date.now() / 1000)
    const message = `casual-chess:join:${gid}:${ts}`
    try {
      await signAndPost(`/games/${gid}/join`, message)
      navigate(`/casual-chess/${gid}`)
    } catch (e) {
      setMoveError(e instanceof Error ? e.message : 'join failed')
    }
  }, [gameIdInput, navigate, signAndPost])

  const submitMove = useCallback(async (move: string) => {
    if (!game) return
    setMoveError(null)
    setSending(true)
    const ts = Math.floor(Date.now() / 1000)
    const normalized = move.toLowerCase().replace(/\s+/g, '')
    const message = `casual-chess:move:${game.gameId}:${normalized}:${ts}`
    try {
      await signAndPost(`/games/${game.gameId}/move`, message, { move: normalized })
      await fetchState(game.gameId)
    } catch (e) {
      setMoveError(e instanceof Error ? e.message : 'move failed')
    } finally {
      setSending(false)
      setSelected(null)
      setPromotionMove(null)
    }
  }, [game, signAndPost, fetchState])

  const resign = useCallback(async () => {
    if (!game) return
    const ts = Math.floor(Date.now() / 1000)
    const message = `casual-chess:resign:${game.gameId}:${ts}`
    try {
      await signAndPost(`/games/${game.gameId}/resign`, message)
      await fetchState(game.gameId)
    } catch (e) {
      setMoveError(e instanceof Error ? e.message : 'resign failed')
    }
  }, [game, signAndPost, fetchState])

  const board = game?.board ?? null
  const side: Side | null = !game ? null
    : game.white?.toLowerCase() === playerAddress.toLowerCase() ? 'w'
    : game.black?.toLowerCase() === playerAddress.toLowerCase() ? 'b'
    : null
  const isMyTurn = !!game && side !== null && game.status === 'active' && game.turn === side
  const gameOver = game?.status === 'finished'

  const onSquareClick = useCallback((r: number, c: number) => {
    if (!board || !game || !isMyTurn) return
    if (selected && selected.r === r && selected.c === c) { setSelected(null); return }
    if (selected) {
      const targets = legalTargets(board, selected.r, selected.c)
      if (targets.some(([tr, tc]) => tr === r && tc === c)) {
        const fromSquare = `${files[selected.c]}${ranks[selected.r]}`
        const toSquare = `${files[c]}${ranks[r]}`
        const movingPiece = board[selected.r][selected.c]
        let move = `${fromSquare}${toSquare}`
        const isPromotion = (movingPiece === 'P' && r === 0) || (movingPiece === 'p' && r === 7)
        setSelected(null)
        if (isPromotion) setPromotionMove({ move })
        else void submitMove(move)
        return
      }
      const p = board[r][c]
      if (p && p !== '.' && sideOf(p) === side) { setSelected({ r, c }); return }
      setSelected(null)
      return
    }
    const p = board[r][c]
    if (p && p !== '.' && sideOf(p) === side) setSelected({ r, c })
  }, [board, game, isMyTurn, selected, side, submitMove])

  const selectedTargets = useMemo(() => {
    if (!selected || !board) return new Set<string>()
    return new Set(legalTargets(board, selected.r, selected.c).map(([r, c]) => `${r},${c}`))
  }, [selected, board])

  const boardFlipped = side === 'b'

  return (
    <AppLayout>
      <Link to="/" className="text-sm text-accent hover:underline">← Back</Link>
      <h1 className="mt-3 text-2xl font-semibold text-text-h">Casual chess (no login)</h1>
      <p className="mt-1 text-sm text-text">You: {playerAddress.slice(0, 8)}… · Connected: {connected ? 'yes' : 'no'}</p>

      {!routeGameId && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button onClick={() => void createGame()} className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white">New game</button>
          <input value={gameIdInput} onChange={(e) => setGameIdInput(e.target.value)} placeholder="game id" className="h-10 min-w-64 rounded-lg border border-border bg-bg px-3 text-sm text-text-h" />
          <button onClick={() => void joinGame()} className="rounded-lg border border-border px-3 py-2 text-sm font-semibold text-text-h">Join</button>
        </div>
      )}
      {moveError && <p className="mt-2 text-sm text-red-500">{moveError}</p>}

      {game && game.status === 'waiting' && side === null && (
        <div className="mt-3">
          <button onClick={() => void joinGame()} className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white">Join game (Black)</button>
        </div>
      )}
      {game && (
        <div className="mt-3 text-sm text-text">
          Game: {game.gameId} · Status: {game.status} · Turn: {game.turn} · You: {side ?? 'spectator'} · Result: {game.result ?? '—'}
          {gameOver && <span className="ml-2 font-semibold text-accent">Game over</span>}
        </div>
      )}

      {game && side && side !== null && (
        <div className="mt-2">
          <button onClick={() => void resign()} disabled={gameOver} className="rounded-lg border border-red-500/40 px-3 py-2 text-sm font-semibold text-red-500 disabled:opacity-40">Resign</button>
        </div>
      )}

      <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
        <section className="relative mx-auto w-full max-w-[620px]">
          <div className="relative overflow-hidden rounded-2xl border-8 border-[#3d2d25] bg-[#3d2d25] shadow-card">
            <div className="grid grid-cols-8">
              {(boardFlipped ? [1, 2, 3, 4, 5, 6, 7, 8] : ranks).flatMap((rank, dr) => (boardFlipped ? ['h', 'g', 'f', 'e', 'd', 'c', 'b', 'a'] : files).map((file, dc) => {
                const r = boardFlipped ? 7 - dr : dr
                const c = boardFlipped ? 7 - dc : dc
                const square = `${file}${rank}`
                const dark = (r + c) % 2 === 1
                const piece = board?.[r]?.[c]
                const glyph = piece && piece !== '.' ? pieceGlyphs[piece] : undefined
                const isSelected = selected?.r === r && selected?.c === c
                const isTarget = selectedTargets.has(`${r},${c}`)
                const isCapture = isTarget && !!piece && piece !== '.'
                const canSelect = !!piece && piece !== '.' && isMyTurn && sideOf(piece) === game?.turn
                return (
                  <div
                    key={square}
                    onClick={() => onSquareClick(r, c)}
                    className={cn('relative flex aspect-square items-center justify-center select-none', dark ? 'bg-[#b58863]' : 'bg-[#f0d9b5]', (canSelect || (selected && isTarget)) && 'cursor-pointer', isSelected && 'ring-4 ring-inset ring-accent/70')}
                  >
                    {isTarget && !isCapture && <span className="absolute z-0 h-[28%] w-[28%] rounded-full bg-black/25" />}
                    {isTarget && isCapture && <span className="absolute inset-[6%] z-0 rounded-full border-4 border-black/35" />}
                    {glyph && <span className="relative z-10 text-[clamp(1.7rem,6vw,4.2rem)] leading-none drop-shadow-[0_1px_1px_rgba(0,0,0,0.35)]">{glyph}</span>}
                    {dc === 0 && <span className="absolute left-1 top-0.5 text-[10px] font-bold text-[#6b4934]">{rank}</span>}
                    {dr === 7 && <span className="absolute bottom-0 right-1 text-[10px] font-bold text-[#6b4934]">{file}</span>}
                  </div>
                )
              }))}
            </div>
            {promotionMove && (
              <div className="absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2 rounded-xl border border-accent-border bg-bg/95 p-3 text-center shadow-2xl">
                <p className="text-sm font-semibold text-text-h">Choose promotion</p>
                <div className="mt-2 grid grid-cols-4 gap-2">
                  {(['q', 'r', 'b', 'n'] as const).map((piece) => (
                    <button key={piece} onClick={() => void submitMove(`${promotionMove.move}${piece}`)} className="rounded-lg border border-border bg-bg px-2 py-2 text-2xl text-text-h hover:border-accent-border">
                      {pieceGlyphs[game?.turn === 'w' ? piece.toUpperCase() : piece]}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </section>
        <aside className="rounded-2xl border border-border bg-bg p-5 shadow-card">
          <h2 className="text-lg font-semibold text-text-h">Game</h2>
          <p className="mt-2 text-sm text-text">Moves: {game?.moveCount ?? 0}</p>
          <p className="mt-1 text-xs text-text">White: {game?.white?.slice(0, 10) ?? '—'}</p>
          <p className="mt-1 text-xs text-text">Black: {game?.black?.slice(0, 10) ?? '—'}</p>
          {sending && <p className="mt-2 text-xs text-text">Sending…</p>}
        </aside>
      </div>
    </AppLayout>
  )
}