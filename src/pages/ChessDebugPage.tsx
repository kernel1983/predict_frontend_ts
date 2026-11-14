import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { AppLayout } from '@/components/layout/AppLayout'
import { NewChessGameModal } from '@/components/chess/NewChessGameModal'
import { cn } from '@/lib/cn'
import { useToast } from '@/components/ui/toast-context'
import { useChainModeStore } from '@/store/chainMode'
import { useAccount, useChains, useMagicWallet, useSendTransaction } from '@/lib/magic'
import { ensureWalletChain, isUserRejected, toErrorMessage } from '@/lib/wallet'
import { useQuery } from '@tanstack/react-query'
import { USDC_DECIMALS, ZENTRA_ENVS, ZEN_CONTRACT, buildZenCallData, fetchPredictOrderbook, fetchRawState, formatUsdc, parseUsdcAmount } from '@/lib/zentra'
import { DepositModal } from '@/components/wallet/DepositModal'
import { Button } from '@/components/ui/Button'
import { useUsdcBalance } from '@/hooks/useUsdcBalance'
import { useSession } from '@/hooks/useSession'
import {
  computeDepositAddress,
  depositFactoriesByMode,
  type DepositFactoryConfig,
} from '@/lib/deposit'
import { formatAmount } from '@/lib/amounts'
import { previewLimitOrder } from '@/lib/limitOrder'

type Outcome = 'white' | 'draw' | 'black'

interface ChessState {
  chess_board: string[][]
  chess_turn: 'w' | 'b'
  chess_move_count?: number
  chess_status: string
  chess_result: string | null
  chess_winner?: string | null
  chess_white?: string
  chess_black?: string | null
  chess_stake?: string | number
  /** 最近一手落子的 unix 秒时间戳；未走过子时为 null */
  chess_last_move_time?: number | null
  /** FEN 风格易位权：'K'/'Q'/'k'/'q'，缺失视为全部可用 */
  chess_castling?: string[] | null
}

interface ChessHistoryEntry {
  block_number: number
  value: ChessState
}

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

function onBoard(r: number, c: number) {
  return r >= 0 && r < 8 && c >= 0 && c < 8
}

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
      const nr = r + dr
      const nc = c + dc
      if (!onBoard(nr, nc)) continue
      const tp = board[nr][nc]
      if (tp === '.' || sideOf(tp) === opp) moves.push([nr, nc])
    }
    return moves
  }

  if (p === 'K' || p === 'k') {
    for (const [dr, dc] of KING_DIRS) {
      const nr = r + dr
      const nc = c + dc
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
      let nr = r + dr
      let nc = c + dc
      while (onBoard(nr, nc)) {
        const tp = board[nr][nc]
        if (tp === '.') {
          moves.push([nr, nc])
          nr += dr
          nc += dc
          continue
        }
        if (sideOf(tp) === opp) moves.push([nr, nc])
        break
      }
    }
    return moves
  }

  if (p === 'P') {
    if (onBoard(r - 1, c) && board[r - 1][c] === '.') {
      moves.push([r - 1, c])
      if (r === 6 && onBoard(r - 2, c) && board[r - 2][c] === '.') moves.push([r - 2, c])
    }
    for (const dc of [-1, 1]) {
      const nr = r - 1
      const nc = c + dc
      if (!onBoard(nr, nc)) continue
      const tp = board[nr][nc]
      if (tp !== '.' && sideOf(tp) === 'b') moves.push([nr, nc])
    }
    return moves
  }

  if (p === 'p') {
    if (onBoard(r + 1, c) && board[r + 1][c] === '.') {
      moves.push([r + 1, c])
      if (r === 1 && onBoard(r + 2, c) && board[r + 2][c] === '.') moves.push([r + 2, c])
    }
    for (const dc of [-1, 1]) {
      const nr = r + 1
      const nc = c + dc
      if (!onBoard(nr, nc)) continue
      const tp = board[nr][nc]
      if (tp !== '.' && sideOf(tp) === 'w') moves.push([nr, nc])
    }
    return moves
  }

  return moves
}

function cloneBoard(board: string[][]) {
  return board.map((row) => [...row])
}

function findKing(board: string[][], side: Side) {
  const target = side === 'w' ? 'K' : 'k'
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (board[r][c] === target) return [r, c] as [number, number]
    }
  }
  return null
}

function squareAttacked(board: string[][], r: number, c: number, bySide: Side) {
  for (let sr = 0; sr < 8; sr++) {
    for (let sc = 0; sc < 8; sc++) {
      const p = board[sr][sc]
      if (!p || p === '.') continue
      if (sideOf(p) !== bySide) continue
      const pm = pseudoMoves(board, sr, sc)
      if (pm.some(([mr, mc]) => mr === r && mc === c)) return true
    }
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
  const p = nb[fr][fc]
  nb[tr][tc] = p
  nb[fr][fc] = '.'
  return nb
}

const KING_HOME_COL = 4
const KING_DEST_COL_KING_SIDE = 6
const KING_DEST_COL_QUEEN_SIDE = 2

/**
 * 王车易位可行性：以链上 `chess_castling` 权限（'K'/'Q'/'k'/'q'）为准，
 * 叠加棋盘检查（王/车仍在初始格、路径畅通、王未在将军中且经过格不被攻击），
 * 与链上引擎 _chess_castling_moves 的判定保持一致。权限字段缺失时按全有处理。
 */
function castlingTargets(
  board: string[][],
  side: Side,
  rights: string[] | null | undefined,
): [number, number][] {
  const kingRow = side === 'w' ? 7 : 0
  const king = side === 'w' ? 'K' : 'k'
  const rook = side === 'w' ? 'R' : 'r'
  const oppSide: Side = side === 'w' ? 'b' : 'w'
  const ksFlag = side === 'w' ? 'K' : 'k'
  const qsFlag = side === 'w' ? 'Q' : 'q'
  const activeRights = rights ?? ['K', 'Q', 'k', 'q']
  if (board[kingRow][KING_HOME_COL] !== king) return []
  if (isInCheck(board, side)) return []
  const row = board[kingRow]
  const kingSide =
    activeRights.includes(ksFlag) &&
    row[7] === rook &&
    row[5] === '.' &&
    row[6] === '.' &&
    !squareAttacked(board, kingRow, 5, oppSide) &&
    !squareAttacked(board, kingRow, 6, oppSide)
  const queenSide =
    activeRights.includes(qsFlag) &&
    row[0] === rook &&
    row[1] === '.' &&
    row[2] === '.' &&
    row[3] === '.' &&
    !squareAttacked(board, kingRow, 2, oppSide) &&
    !squareAttacked(board, kingRow, 3, oppSide)
  const targets: [number, number][] = []
  if (kingSide) targets.push([kingRow, KING_DEST_COL_KING_SIDE])
  if (queenSide) targets.push([kingRow, KING_DEST_COL_QUEEN_SIDE])
  return targets
}

function legalTargets(
  board: string[][],
  r: number,
  c: number,
  rights: string[] | null | undefined,
): [number, number][] {
  const p = board[r][c]
  const side = sideOf(p)
  if (!side) return []
  const targets = pseudoMoves(board, r, c)
  const kingRow = side === 'w' ? 7 : 0
  const king = side === 'w' ? 'K' : 'k'
  if (p === king && r === kingRow && c === KING_HOME_COL) {
    targets.push(...castlingTargets(board, side, rights))
  }
  return targets.filter(([tr, tc]) => {
    const nb = applyMove(board, r, c, tr, tc)
    return !isInCheck(nb, side)
  })
}

interface SquareRef {
  r: number
  c: number
}

/** 上一步对局信息（diff 前后棋盘），用于回放动画 */
interface LastMoveInfo {
  moveCount: number
  from: SquareRef
  to: SquareRef
  piece: string
}

/** diff 连续棋盘局面找最近一步：普通走子/过路兵/吃子（目的地前有空子或被吃子）取 (from → to)，易位只取王的部分 */
function diffLastMove(prevBoard: string[][], nextBoard: string[][], moveCount: number): LastMoveInfo | null {  const fromCands: { square: SquareRef; piece: string }[] = []
  const toCands: { square: SquareRef; piece: string }[] = []
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (prevBoard[r][c] === nextBoard[r][c]) continue
      if (nextBoard[r][c] === '.') fromCands.push({ square: { r, c }, piece: prevBoard[r][c] })
      else toCands.push({ square: { r, c }, piece: nextBoard[r][c] })
    }
  }
  if (fromCands.length === 0 || toCands.length === 0) return null
  const to = toCands[0]
  let from: { square: SquareRef; piece: string } | undefined
  if (fromCands.length === 2 && toCands.length === 2) {
    // 王车易位：双方各让出一格、各进入一格，取王的部分
    from =
      fromCands.find((item) => item.piece === 'K' || item.piece === 'k') ??
      fromCands[0]
    const matchingTo = toCands.find((item) => Math.abs(item.square.c - from!.square.c) === 2)
    if (matchingTo) return { moveCount, from: from.square, to: matchingTo.square, piece: from.piece }
    return null
  }
  // 普通走子/吃子/过路兵：from 取与落子同色的一方（吃子时 from 候选包含被吃子）
  const toPiece = to.piece
  from =
    fromCands.find((item) => item.piece !== '.' && sideOf(item.piece) === sideOf(toPiece)) ??
    fromCands[0]
  return { moveCount, from: from.square, to: to.square, piece: from.piece }
}

export default function ChessDebugPage() {
  const { gameId = '1' } = useParams()
  const { mode } = useChainModeStore()
  const env = ZENTRA_ENVS[mode]
  const chains = useChains()
  const { address } = useAccount()
  const toast = useToast()
  const wallet = useMagicWallet()
  const { sendTransactionAsync, isPending: submitting } = useSendTransaction()
  const lastMoveCountRef = useRef<number | null>(null)
  const lastTurnRef = useRef<'w' | 'b' | null>(null)
  const notifiedRef = useRef<string | null>(null)
  const [selection, setSelection] = useState<Outcome>('white')
  const [basicAmount, setBasicAmount] = useState('2')
  const [advancedMode, setAdvancedMode] = useState(false)
  const [advancedAction, setAdvancedAction] = useState<'buy' | 'sell' | 'mint'>('buy')
  const [advancedToken, setAdvancedToken] = useState<'yes' | 'no'>('yes')
  const [advancedPrice, setAdvancedPrice] = useState('0.50')
  const [advancedAmount, setAdvancedAmount] = useState('10')
  const [submitted, setSubmitted] = useState(false)
  const [history, setHistory] = useState<ChessHistoryEntry[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<{ r: number; c: number } | null>(null)
  const [promotionMove, setPromotionMove] = useState<{ move: string; r: number; c: number } | null>(null)
  const [generatedCall, setGeneratedCall] = useState<string | null>(null)
  const [pendingMove, setPendingMove] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>()
  const [moveError, setMoveError] = useState<string | null>(null)
  const [sendingMove, setSendingMove] = useState(false)
  const [showNewGame, setShowNewGame] = useState(false)
  const [depositOpen, setDepositOpen] = useState(false)
  const { data: balance, isLoading: balanceLoading, error: balanceError } = useUsdcBalance(address)
  const { user } = useSession()
  const factories: DepositFactoryConfig[] = depositFactoriesByMode[mode]
  const predicted = address
    ? factories.map((config) => ({
        config,
        address: computeDepositAddress(config.factory, address, config.initCode),
      }))
    : []

  const loadChessHistory = useCallback(async () => {
    const prefix = `${mode === 'local' ? 'chess' : 'base-chess'}-chess_state:${gameId}`
    const url = `${env.indexerUrl}/api/query_recent_state?prefix=${encodeURIComponent(prefix)}`
    //try {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`Node returned ${response.status}`)
      const payload: unknown = await response.json()
      const stateEntries: ChessHistoryEntry[] = []
      const visit = (raw: unknown, blockNumber = 0): void => {
        if (typeof raw === 'string') {
          visit(JSON.parse(raw), blockNumber)
          return
        }
        if (Array.isArray(raw)) {
          raw.forEach((item) => visit(item, blockNumber))
          return
        }
        if (!raw || typeof raw !== 'object') return
        const record = raw as Record<string, unknown>
        const currentBlock = Number(record.block_number ?? record.blockNumber ?? blockNumber)
        const candidate = record.value && typeof record.value === 'object' ? record.value : record
        if (candidate && typeof candidate === 'object' && Array.isArray((candidate as Record<string, unknown>).chess_board)) {
          stateEntries.push({
            block_number: currentBlock,
            value: candidate as ChessState,
          })
          return
        }
        Object.values(record).forEach((child) => visit(child, currentBlock))
      }
      visit(payload)
      // Creating and joining write state too, but they are not chess moves.
      // Retain the latest state for each completed-move count.
      const entries = Array.from(
        new Map(stateEntries.map((entry) => [entry.value.chess_move_count ?? 0, entry])).values(),
      )
      //if (entries.length === 0) {
      //  throw new Error(`Game "${gameId}" was not found on ${env.withdrawChainName}`)
      //}
      setHistory(entries)
      setHistoryIndex((index) => index < 0 || index === history.length - 1 ? entries.length - 1 : Math.min(index, entries.length - 1))
      setError(null)

      const latest = entries[entries.length - 1]?.value
      const newMoveCount = latest?.chess_move_count ?? 0
      const newTurn = latest?.chess_turn ?? null
      lastMoveCountRef.current = newMoveCount
      lastTurnRef.current = newTurn
    //} catch (reason) {
    //  console.error('[chess] failed to load history', { mode, gameId, prefix, url, reason })
    //  setHistory([])
    //  setHistoryIndex(-1)
    //  setError(reason instanceof Error ? reason.message : 'Could not load chess state')
    //}
  }, [env, gameId, history.length, mode])

  useEffect(() => {
    void loadChessHistory()
    const refresh = window.setInterval(() => void loadChessHistory(), 5_000)
    return () => window.clearInterval(refresh)
  }, [loadChessHistory])

  const activeEntry = history[historyIndex]
  const state = activeEntry?.value
  const turnLabel = !state
    ? 'Game not created yet'
    : state.chess_status === 'chess_waiting_for_opponent'
      ? 'Waiting for opponent to join'
      : state.chess_turn === 'w'
        ? 'White to move'
        : 'Black to move'
  const latestState = history[history.length - 1]?.value
  const gameOver = latestState?.chess_result != null
  const resultLabel =
    latestState?.chess_result === 'chess_white_wins'
      ? latestState?.chess_status === 'chess_timeout'
        ? 'White wins (timeout)'
        : 'White wins (checkmate)'
      : latestState?.chess_result === 'chess_black_wins'
        ? latestState?.chess_status === 'chess_timeout'
          ? 'Black wins (timeout)'
          : 'Black wins (checkmate)'
        : latestState?.chess_result === 'chess_draw'
          ? latestState?.chess_status === 'chess_stalemate'
            ? 'Draw (stalemate)'
            : latestState?.chess_status === 'chess_insufficient_material'
              ? 'Draw (insufficient material)'
              : latestState?.chess_status === 'chess_fifty_move_rule'
                ? 'Draw (50-move rule)'
                : latestState?.chess_status === 'chess_agreed_draw'
                  ? 'Draw (agreed)'
                  : latestState?.chess_status === 'chess_timeout'
                    ? 'Draw (timeout)'
                    : 'Draw'
          : null
  const myColor: 'w' | 'b' | null =
    !address || !state
      ? null
      : address.toLowerCase() === state.chess_white?.toLowerCase()
        ? 'w'
        : address.toLowerCase() === state.chess_black?.toLowerCase()
          ? 'b'
          : null
  const isMyTurn = !gameOver && state?.chess_status === 'chess_active' && myColor !== null && state?.chess_turn === myColor
  const latestStatus = latestState?.chess_status
  const waitingForOpponent = latestStatus === 'chess_waiting_for_opponent'
  const tradingLocked = !state || waitingForOpponent || gameOver
  const tradingLockReason = !state
    ? 'Trading is locked — this game has not been created yet.'
    : waitingForOpponent
      ? 'Buying and selling are locked until the opponent joins.'
      : gameOver
        ? 'Trading is closed — the game has finished.'
        : null

  const stakeRaw = state?.chess_stake
  const stakeBig =
    stakeRaw === undefined || stakeRaw === null
      ? null
      : typeof stakeRaw === 'string'
        ? /^\d+$/.test(stakeRaw) ? BigInt(stakeRaw) : null
        : Number.isFinite(stakeRaw) && stakeRaw >= 0
          ? BigInt(Math.round(stakeRaw))
          : null
  const stakeLabel = stakeBig === null ? null : formatUsdc(stakeBig, 2)

  const shareBalances = useQuery({
    queryKey: ['chess-share-balances', mode, gameId, address?.toLowerCase() ?? '', history.length],
    queryFn: async () => {
      const addr = (address as string).toLowerCase()
      const [yesRaw, noRaw] = await Promise.all([
        fetchRawState(`chess_predict-${gameId}_yes_balance:${addr}`),
        fetchRawState(`chess_predict-${gameId}_no_balance:${addr}`),
      ])
      return { yesRaw, noRaw }
    },
    enabled: Boolean(address),
    refetchInterval: 5_000,
  })
  const quoteBalanceQuery = useQuery({
    queryKey: ['chess-quote-balance', mode, address?.toLowerCase() ?? '', history.length],
    queryFn: async () => {
      const addr = (address as string).toLowerCase()
      const [baseRaw, plainRaw] = await Promise.all([
        fetchRawState(`base-USDC-balance:${addr}`),
        fetchRawState(`USDC-balance:${addr}`),
      ])
      const base = BigInt(baseRaw || '0')
      const plain = BigInt(plainRaw || '0')
      return (base > plain ? base : plain).toString()
    },
    enabled: Boolean(address),
    refetchInterval: 5_000,
  })
  const quoteBalance = BigInt(quoteBalanceQuery.data ?? '0')
  const orderbookQuery = useQuery({
    queryKey: ['chess-orderbook', mode, gameId, state?.chess_move_count ?? 0],
    queryFn: () => fetchPredictOrderbook(gameId, USDC_DECIMALS, { namespace: 'chess_predict', priceDecimals: 6 }),
    enabled: Boolean(state),
    refetchInterval: 5_000,
  })
  const whiteWinPrice = orderbookQuery.data?.yes ?? null
  const blackWinPrice = orderbookQuery.data?.no ?? null
  const fmtPrice = (price: number | null) =>
    price === null
      ? '—'
      : `$${price.toFixed(2)}`
  const yesRaw = shareBalances.data?.yesRaw ?? '0'
  const noRaw = shareBalances.data?.noRaw ?? '0'
  const fmtShares = (raw: string) => formatAmount(BigInt(raw || '0'), 6, 2)

  // 奖池 = 双方 stake escrow（pot_chess_stake）
  const potQuery = useQuery({
    queryKey: ['chess-pot', mode, gameId, state?.chess_move_count ?? 0],
    queryFn: async () => {
      const maxOf = (values: string[]) => values.map((v) => BigInt(v || '0')).reduce((a, b) => (b > a ? b : a))
      const [stakeBase, stakePlain] = await Promise.all([
        fetchRawState(`base-USDC-balance:pot_chess_stake:${gameId}`),
        fetchRawState(`USDC-balance:pot_chess_stake:${gameId}`),
      ])
      return maxOf([stakeBase, stakePlain]).toString()
    },
    enabled: Boolean(state),
    refetchInterval: 5_000,
  })
  const potLabel =
    potQuery.data === undefined
      ? '…'
      : `${formatUsdc(BigInt(potQuery.data || '0'), 2)} USDC`

  // 距上次落子时长：用链上 chess_last_move_time（unix 秒），每秒刷新；未走过子时隐藏
  const lastMoveAtMs =
    typeof latestState?.chess_last_move_time === 'number' && latestState.chess_last_move_time > 0
      ? latestState.chess_last_move_time * 1000
      : undefined
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1_000)
    return () => window.clearInterval(id)
  }, [])
  const secondsSinceLastMove =
    lastMoveAtMs !== undefined && lastMoveAtMs <= nowMs
      ? Math.floor((nowMs - lastMoveAtMs) / 1000)
      : null

  const countdownSeconds =
    secondsSinceLastMove === null ? null : Math.max(0, 900 - secondsSinceLastMove)
  const sinceLastMove =
    countdownSeconds === null
      ? null
      : countdownSeconds < 60
        ? `${countdownSeconds}s`
        : `${Math.floor(countdownSeconds / 60)}m ${countdownSeconds % 60}s`

  const limitPreview = previewLimitOrder({
    slug: gameId,
    side: advancedToken,
    buy: advancedAction === 'buy',
    price: advancedPrice,
    amount: advancedAmount,
    quoteDecimals: 6,
    quoteLabel: 'USDC',
    quoteBalance,
    holding: advancedToken === 'yes' ? BigInt(yesRaw || '0') : BigInt(noRaw || '0'),
    tokenLabel: advancedToken === 'yes' ? 'White wins' : 'Black wins',
    marketExists: true,
  })

  const sendMove = useCallback(async (move: string) => {
    setMoveError(null)
    if (!address) {
      setMoveError('Connect a wallet first.')
      return
    }
    setSendingMove(true)
    try {
      const walletOrProvider = wallet ?? (typeof window !== 'undefined' ? (window as { ethereum?: unknown }).ethereum : null)
      const targetChain = chains.find((item) => item.id === env.withdrawChainId)
      await ensureWalletChain(walletOrProvider as never, {
        chainId: env.withdrawChainId,
        chainName: targetChain?.name ?? env.withdrawChainName,
        nativeCurrency: targetChain?.nativeCurrency ?? {
          name: 'Ether',
          symbol: 'ETH',
          decimals: 18,
        },
        rpcUrls: targetChain?.rpcUrls.default.http ?? [],
        blockExplorerUrls: targetChain?.blockExplorers?.default
          ? [targetChain.blockExplorers.default.url]
          : undefined,
      })
      const data = buildZenCallData('chess_make_move', [gameId, move])
      const hash = await sendTransactionAsync({
        chainId: env.withdrawChainId,
        account: address as `0x${string}`,
        to: ZEN_CONTRACT,
        value: 0n,
        data,
      })
      setTxHash(hash)
      toast.push({ title: 'Move submitted', description: move, variant: 'success' })
      await loadChessHistory()
    } catch (err) {
      if (!isUserRejected(err)) setMoveError(toErrorMessage(err))
    } finally {
      setSendingMove(false)
    }
  }, [address, chains, env, gameId, loadChessHistory, sendTransactionAsync, toast, wallet])

  const joinGame = useCallback(async () => {
    setMoveError(null)
    if (!address) {
      setMoveError('Connect a wallet first.')
      return
    }
    if (!state?.chess_white || myColor === 'w') return
    setSendingMove(true)
    try {
      const walletOrProvider = wallet ?? (typeof window !== 'undefined' ? (window as { ethereum?: unknown }).ethereum : null)
      const targetChain = chains.find((item) => item.id === env.withdrawChainId)
      await ensureWalletChain(walletOrProvider as never, {
        chainId: env.withdrawChainId,
        chainName: targetChain?.name ?? env.withdrawChainName,
        nativeCurrency: targetChain?.nativeCurrency ?? { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: targetChain?.rpcUrls.default.http ?? [],
        blockExplorerUrls: targetChain?.blockExplorers?.default
          ? [targetChain.blockExplorers.default.url]
          : undefined,
      })
      const hash = await sendTransactionAsync({
        chainId: env.withdrawChainId,
        account: address as `0x${string}`,
        to: ZEN_CONTRACT,
        value: 0n,
        data: buildZenCallData('chess_join_game', [gameId]),
      })
      setTxHash(hash)
      // Verify the join actually succeeded on-chain (may fail e.g. insufficient balance).
      const joinTxHash = hash.startsWith('0x') ? hash.slice(2) : hash
      let joined = false
      for (let attempt = 0; attempt < 15 && !joined; attempt += 1) {
        try {
          const eventsResponse = await fetch(`${env.indexerUrl}/api/events?txhash=${encodeURIComponent(joinTxHash)}`)
          if (eventsResponse.ok) {
            const payload = await eventsResponse.json()
            if (Array.isArray(payload?.events) && payload.events.length > 0) joined = true
          }
        } catch {
          // indexer may briefly be unavailable while the tx is mined
        }
        if (!joined && attempt < 14) await new Promise((resolve) => window.setTimeout(resolve, 2_000))
      }
      if (!joined) throw new Error('Join failed (transaction did not produce a game-joined event; check your balance/stake).')
      toast.push({ title: 'Joined game', variant: 'success' })
      await loadChessHistory()
    } catch (err) {
      if (!isUserRejected(err)) setMoveError(toErrorMessage(err))
    } finally {
      setSendingMove(false)
    }
  }, [address, chains, env, gameId, loadChessHistory, myColor, sendTransactionAsync, state?.chess_white, toast, wallet])

  const claimTimeout = useCallback(async () => {
    setMoveError(null)
    if (!address) {
      setMoveError('Connect a wallet first.')
      return
    }
    setSendingMove(true)
    try {
      const walletOrProvider = wallet ?? (typeof window !== 'undefined' ? (window as { ethereum?: unknown }).ethereum : null)
      const targetChain = chains.find((item) => item.id === env.withdrawChainId)
      await ensureWalletChain(walletOrProvider as never, {
        chainId: env.withdrawChainId,
        chainName: targetChain?.name ?? env.withdrawChainName,
        nativeCurrency: targetChain?.nativeCurrency ?? { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: targetChain?.rpcUrls.default.http ?? [],
        blockExplorerUrls: targetChain?.blockExplorers?.default
          ? [targetChain.blockExplorers.default.url]
          : undefined,
      })
      const hash = await sendTransactionAsync({
        chainId: env.withdrawChainId,
        account: address as `0x${string}`,
        to: ZEN_CONTRACT,
        value: 0n,
        data: buildZenCallData('chess_claim_timeout', [gameId]),
      })
      setTxHash(hash)
      toast.push({ title: 'Claimed timeout', variant: 'success' })
      await loadChessHistory()
    } catch (err) {
      if (!isUserRejected(err)) setMoveError(toErrorMessage(err))
    } finally {
      setSendingMove(false)
    }
  }, [address, chains, env, gameId, loadChessHistory, sendTransactionAsync, toast, wallet])

  const mintTokens = useCallback(async () => {
    setMoveError(null)
    if (!address) {
      setMoveError('Connect a wallet first.')
      return
    }
    const raw = parseUsdcAmount(advancedAmount.trim())
    if (raw === null || raw <= 0n) {
      setMoveError('Enter a valid mint amount.')
      return
    }
    setSendingMove(true)
    try {
      const walletOrProvider = wallet ?? (typeof window !== 'undefined' ? (window as { ethereum?: unknown }).ethereum : null)
      const targetChain = chains.find((item) => item.id === env.withdrawChainId)
      await ensureWalletChain(walletOrProvider as never, {
        chainId: env.withdrawChainId,
        chainName: targetChain?.name ?? env.withdrawChainName,
        nativeCurrency: targetChain?.nativeCurrency ?? { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: targetChain?.rpcUrls.default.http ?? [],
        blockExplorerUrls: targetChain?.blockExplorers?.default
          ? [targetChain.blockExplorers.default.url]
          : undefined,
      })
      const hash = await sendTransactionAsync({
        chainId: env.withdrawChainId,
        account: address as `0x${string}`,
        to: ZEN_CONTRACT,
        value: 0n,
        data: buildZenCallData('chess_predict_mint', [gameId, raw.toString()]),
      })
      setTxHash(hash)
      toast.push({ title: 'Mint submitted', description: `${advancedAmount} USDC → YES + NO`, variant: 'success' })
      setSubmitted(true)
    } catch (err) {
      if (!isUserRejected(err)) setMoveError(toErrorMessage(err))
    } finally {
      setSendingMove(false)
    }
  }, [address, advancedAmount, chains, env, gameId, sendTransactionAsync, toast, wallet])

  const placeLimitOrder = useCallback(async () => {
    setMoveError(null)
    if (!address) {
      setMoveError('Connect a wallet first.')
      return
    }
    if (!limitPreview.args) {
      setMoveError(limitPreview.error ?? 'Enter a valid amount.')
      return
    }
    setSendingMove(true)
    try {
      const walletOrProvider = wallet ?? (typeof window !== 'undefined' ? (window as { ethereum?: unknown }).ethereum : null)
      const targetChain = chains.find((item) => item.id === env.withdrawChainId)
      await ensureWalletChain(walletOrProvider as never, {
        chainId: env.withdrawChainId,
        chainName: targetChain?.name ?? env.withdrawChainName,
        nativeCurrency: targetChain?.nativeCurrency ?? { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: targetChain?.rpcUrls.default.http ?? [],
        blockExplorerUrls: targetChain?.blockExplorers?.default
          ? [targetChain.blockExplorers.default.url]
          : undefined,
      })
      const hash = await sendTransactionAsync({
        chainId: env.withdrawChainId,
        account: address as `0x${string}`,
        to: ZEN_CONTRACT,
        value: 0n,
        data: buildZenCallData('chess_predict_limit_order', limitPreview.args),
      })
      setTxHash(hash)
      toast.push({
        title: `${advancedAction === 'buy' ? 'Buy' : 'Sell'} limit order submitted`,
        description: `${limitPreview.estShares} ${advancedToken.toUpperCase()} @ ${limitPreview.avgPrice} USDC`,
        variant: 'success',
      })
    } catch (err) {
      if (!isUserRejected(err)) setMoveError(toErrorMessage(err))
    } finally {
      setSendingMove(false)
    }
  }, [address, advancedAction, advancedToken, chains, env, limitPreview, sendTransactionAsync, toast, wallet])

  const placeMarketOrder = useCallback(async () => {
    setMoveError(null)
    if (!address) {
      setMoveError('Connect a wallet first.')
      return
    }
    if (tradingLocked) {
      setMoveError(tradingLockReason ?? 'Trading is locked.')
      return
    }
    const raw = parseUsdcAmount(basicAmount)
    if (raw === null || raw <= 0n) {
      setMoveError('Enter a valid USDC amount.')
      return
    }
    if (raw > quoteBalance) {
      setMoveError('Amount exceeds your available USDC balance.')
      return
    }
    const side = selection === 'black' ? 'no' : 'yes'
    setSendingMove(true)
    try {
      const walletOrProvider = wallet ?? (typeof window !== 'undefined' ? (window as { ethereum?: unknown }).ethereum : null)
      const targetChain = chains.find((item) => item.id === env.withdrawChainId)
      await ensureWalletChain(walletOrProvider as never, {
        chainId: env.withdrawChainId,
        chainName: targetChain?.name ?? env.withdrawChainName,
        nativeCurrency: targetChain?.nativeCurrency ?? { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: targetChain?.rpcUrls.default.http ?? [],
        blockExplorerUrls: targetChain?.blockExplorers?.default
          ? [targetChain.blockExplorers.default.url]
          : undefined,
      })
      const hash = await sendTransactionAsync({
        chainId: env.withdrawChainId,
        account: address as `0x${string}`,
        to: ZEN_CONTRACT,
        value: 0n,
        data: buildZenCallData('chess_predict_market_order', [gameId, null, side, `-${raw}`]),
      })
      setTxHash(hash)
      toast.push({
        title: 'Market buy submitted',
        description: `${basicAmount} USDC · ${side === 'yes' ? 'White wins' : 'Black wins'}`,
        variant: 'success',
      })
      setSubmitted(true)
    } catch (err) {
      if (!isUserRejected(err)) setMoveError(toErrorMessage(err))
    } finally {
      setSendingMove(false)
    }
  }, [address, basicAmount, chains, env, gameId, quoteBalance, selection, sendTransactionAsync, toast, tradingLockReason, tradingLocked, wallet])

  // 一键全仓卖出（market order）：依次 market sell YES / NO 的全部份额
  const sellAll = useCallback(async () => {
    setMoveError(null)
    if (!address) {
      setMoveError('Connect a wallet first.')
      return
    }
    if (tradingLocked) {
      setMoveError(tradingLockReason ?? 'Trading is locked.')
      return
    }
    const holdings = (['yes', 'no'] as const)
      .map((side) => ({ side, raw: side === 'yes' ? yesRaw : noRaw }))
      .filter((item) => BigInt(item.raw || '0') > 0n)
    if (holdings.length === 0) {
      setMoveError('No outcome shares to sell.')
      return
    }
    setSendingMove(true)
    try {
      const walletOrProvider = wallet ?? (typeof window !== 'undefined' ? (window as { ethereum?: unknown }).ethereum : null)
      const targetChain = chains.find((item) => item.id === env.withdrawChainId)
      await ensureWalletChain(walletOrProvider as never, {
        chainId: env.withdrawChainId,
        chainName: targetChain?.name ?? env.withdrawChainName,
        nativeCurrency: targetChain?.nativeCurrency ?? { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: targetChain?.rpcUrls.default.http ?? [],
        blockExplorerUrls: targetChain?.blockExplorers?.default
          ? [targetChain.blockExplorers.default.url]
          : undefined,
      })
      let lastHash: `0x${string}` | undefined
      for (const item of holdings) {
        lastHash = await sendTransactionAsync({
          chainId: env.withdrawChainId,
          account: address as `0x${string}`,
          to: ZEN_CONTRACT,
          value: 0n,
          data: buildZenCallData('chess_predict_market_order', [gameId, `-${BigInt(item.raw).toString()}`, item.side, null]),
        }) as `0x${string}`
      }
      setTxHash(lastHash)
      toast.push({
        title: 'Sell all submitted',
        description: holdings.map((item) => `${fmtShares(item.raw)} ${item.side.toUpperCase()}`).join(' + '),
        variant: 'success',
      })
      setSubmitted(true)
      await loadChessHistory()
    } catch (err) {
      if (!isUserRejected(err)) setMoveError(toErrorMessage(err))
    } finally {
      setSendingMove(false)
    }
  }, [address, chains, env, fmtShares, gameId, loadChessHistory, noRaw, sendTransactionAsync, toast, tradingLockReason, tradingLocked, wallet, yesRaw])

  const submitMove = useCallback((move: string) => {    setGeneratedCall(JSON.stringify({ p: 'zentest3', f: 'chess_make_move', a: [gameId, move] }))
    setPendingMove(move)
    setPromotionMove(null)
    void sendMove(move)
  }, [gameId, sendMove])

  const selectedTargets = useMemo(() => {
    if (!selected || !state?.chess_board) return new Set<string>()
    return new Set(legalTargets(state.chess_board, selected.r, selected.c, state.chess_castling).map(([r, c]) => `${r},${c}`))
  }, [selected, state?.chess_board, state?.chess_castling])

  /** 最近一步（来自 history diff），move 0（创建/加入）不算。
   *  以 (最新 block, moveCount) 为缓存键，轮询返回相同内容时不重建，避免动画被无谓重置 */
  const historyLastKey =
    history.length > 0
      ? `${history[history.length - 1]?.block_number}:${history[history.length - 1]?.value.chess_move_count ?? 0}`
      : 'none'
  const lastMoveInfo = useMemo<LastMoveInfo | null>(() => {
    if (history.length === 0) return null
    const latest = history[history.length - 1]
    const moveCount = latest?.value.chess_move_count ?? 0
    if (moveCount === 0 || !latest?.value.chess_board) return null
    const prevEntry = history
      .slice(0, -1)
      .reverse()
      .find((entry) => (entry.value.chess_move_count ?? 0) === moveCount - 1)
    if (!prevEntry?.value.chess_board) return null
    return diffLastMove(prevEntry.value.chess_board, latest.value.chess_board, moveCount)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 以 key 为缓存键，轮询同内容不重建
  }, [historyLastKey])

  const [ghostMove, setGhostMove] = useState<LastMoveInfo | null>(null)

  // “Your turn to move” 时循环回放对手的最后一步（持续循环直到走子/换页）；刷新页面后重新播放；
  // Spectator 时无论哪方走的最后一步都循环回放；浏览历史/我方走子时不播
  useEffect(() => {
    const latestMoveCount = latestState?.chess_move_count ?? 0
    const spectating = myColor === null && latestState?.chess_status === 'chess_active'
    const shouldPlay =
      (isMyTurn || spectating) &&
      !!lastMoveInfo &&
      lastMoveInfo.moveCount === latestMoveCount &&
      historyIndex === history.length - 1 &&
      (myColor === null || sideOf(lastMoveInfo.piece) !== myColor)
    if (!shouldPlay) {
      setGhostMove(null)
      return
    }
    setGhostMove(lastMoveInfo)
  }, [isMyTurn, lastMoveInfo, latestState?.chess_move_count, historyIndex, history.length, myColor, ghostMove])

  useEffect(() => {
    setSelected(null)
  }, [state?.chess_move_count, state?.chess_turn, historyIndex])

  useEffect(() => {
    if (
      historyIndex !== history.length - 1 ||
      gameOver ||
      !state ||
      state.chess_status !== 'chess_active' ||
      myColor === null ||
      state.chess_turn !== myColor
    ) return
    const moveCount = state.chess_move_count ?? 0
    const key = `${moveCount}:${myColor}`
    if (notifiedRef.current === key) return
    const label = myColor === 'w' ? 'White' : 'Black'
    toast.push({
      title: `Your turn (${label})`,
      description: `Game ${gameId} · move ${moveCount}`,
      variant: 'success',
    })
    notifiedRef.current = key
  }, [myColor, state, gameId, toast, gameOver, historyIndex, history.length])

  const boardFlipped = myColor === 'b'

  return (
    <AppLayout>
      <Link to="/" className="text-sm text-accent hover:underline">← Back to markets</Link>
      <div className="mt-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="rounded-full border border-accent-border bg-accent-bg px-2.5 py-1 text-xs font-medium text-accent">DEBUG · {mode.toUpperCase()}</span>
            <span className="text-xs text-text">Demo market · no settlement</span>
          </div>
          <h1 className="mt-3 text-2xl font-semibold text-text-h">Chess match prediction</h1>
          <p className="mt-1 text-sm text-text">On-chain state for {gameId} · choose the result you expect.</p>
        </div>
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
      </div>
      <div className="mt-4 flex justify-end">
        <button type="button" onClick={() => setShowNewGame(true)} className="rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white shadow-card transition-opacity hover:opacity-90">
          + New chess game
        </button>
      </div>
      <NewChessGameModal open={showNewGame} onClose={() => setShowNewGame(false)} />
      <DepositModal
        open={depositOpen}
        onClose={() => setDepositOpen(false)}
        predicted={predicted}
        deposits={user?.deposits ?? {}}
        walletConnected={Boolean(address)}
        mainnet={mode === 'mainnet'}
      />
      <div className={cn(
        'mt-5 flex flex-wrap items-center justify-between gap-4 rounded-2xl border px-5 py-4 shadow-card',
        isMyTurn ? 'border-accent bg-accent-bg' : 'border-border bg-bg',
      )}>
        <div className="flex flex-wrap items-center gap-6">
            {state && (
            <div className="flex items-center gap-3">
              <span className="group relative flex h-11 w-11 items-center justify-center rounded-full bg-white text-xl shadow-sm ring-1 ring-inset ring-black/10">
                <span className={state.chess_turn === 'w' ? 'text-slate-800' : 'text-black'}>
                  {state.chess_turn === 'w' ? '♔' : '♚'}
                </span>
                <span className="pointer-events-none absolute left-1/2 top-full z-20 mt-2 hidden w-[32rem] -translate-x-[10%] rounded-lg border border-border bg-bg px-3 py-2 text-left text-xs text-text-h shadow-card group-hover:block">
                  <span className="block font-mono">White: {state.chess_white ?? '—'}{state.chess_white && address && state.chess_white.toLowerCase() === address.toLowerCase() ? ' (You)' : ''}</span>
                  <span className="block font-mono">Black: {state.chess_black ?? '—'}{state.chess_black && address && state.chess_black.toLowerCase() === address.toLowerCase() ? ' (You)' : ''}</span>
                </span>
              </span>
              <div>
                <p className="text-xs font-medium uppercase tracking-wider text-text">
                  {isMyTurn ? 'To move now' : 'Next move'}
                </p>
                <p className="text-lg font-bold text-text-h">
                  {state.chess_status === 'chess_waiting_for_opponent'
                    ? 'Waiting for opponent'
                    : state.chess_turn === 'w' ? 'White to move' : 'Black to move'}
                </p>
              </div>
            </div>
          )}
          {!state && (
            <div className="flex items-center gap-2 px-3 py-2">
              <span className="h-2.5 w-2.5 rounded-full bg-amber-500" />
              <span className="text-sm font-semibold text-text">Game not created yet</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {sinceLastMove && !gameOver && secondsSinceLastMove !== null && (
            <button
              type="button"
              onClick={() => {
                if (secondsSinceLastMove < 900) {
                  toast.push({ title: 'Not yet', description: 'Need 900s since last move to end game.', variant: 'error' })
                  return
                }
                void claimTimeout()
              }}
              disabled={sendingMove}
              className={cn(
                'flex items-center gap-2 rounded-xl border px-3 py-1.5 text-sm shadow-sm disabled:cursor-not-allowed disabled:opacity-40',
                secondsSinceLastMove >= 900 ? 'border-accent bg-accent-bg' : 'border-border bg-bg',
              )}
            >
              <span className={cn('text-xs', secondsSinceLastMove >= 900 ? 'text-accent' : 'text-text')}>
                {secondsSinceLastMove >= 900 ? 'End game' : 'Last move'}
              </span>
              <span className="font-mono font-semibold text-text-h">{sinceLastMove}</span>
            </button>
          )}
          <span className="flex items-center gap-2 rounded-xl border border-slate-900 bg-slate-900 px-3 py-1.5 text-sm shadow-sm">
            <span className="text-xs text-white">Prize pool</span>
            <span className="font-mono font-semibold text-white">{potLabel}</span>
          </span>
        </div>
      </div>
      {gameOver && resultLabel && (
        <div className="mt-4 rounded-xl border border-accent-border bg-accent-bg px-4 py-3 text-center">
          <p className="text-base font-semibold text-accent">Game over — {resultLabel}</p>
          {latestState?.chess_winner && (
            <p className="mt-1 font-mono text-xs text-text">
              Winner: {latestState.chess_winner}
            </p>
          )}
        </div>
      )}
      {!gameOver && state?.chess_status === 'chess_waiting_for_opponent' && (
        <div className="mt-4 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-center">
          <div className="flex items-center justify-between gap-3">
            <p className="text-base font-semibold text-amber-700 dark:text-amber-400">
              Waiting for opponent to join
            </p>
            {myColor !== 'w' && (
              <button
                type="button"
                onClick={() => void joinGame()}
                disabled={submitting || sendingMove || !address}
                className="shrink-0 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                {!address
                  ? 'Connect wallet to join'
                  : submitting || sendingMove
                    ? 'Joining…'
                    : myColor === 'b'
                      ? 'Join game (Black)'
                      : 'Join game'}
              </button>
            )}
          </div>
          <div className="mt-2 flex items-center justify-between gap-3 text-xs text-text">
            <span className="truncate text-left font-mono">
              White: {state?.chess_white ?? '—'}
            </span>
            <span className="shrink-0 text-right font-medium">
              {state?.chess_black
                ? 'Black: pending join'
                : 'Black: Waiting'}
            </span>
          </div>
          <p className="mt-2 text-left text-xs font-medium text-amber-700 dark:text-amber-400">
            {stakeLabel
              ? `Joining requires staking ${stakeLabel} USDC — it will be escrowed and matched against the creator's stake.`
              : 'Joining is free — this game has no stake.'}
          </p>
        </div>
      )}
      <div className="mt-7 grid items-start gap-7 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section aria-label="Chessboard" className="relative mx-auto w-full max-w-[620px]">
          <div className="relative overflow-hidden rounded-2xl border-8 border-[#3d2d25] bg-[#3d2d25] shadow-card"><div className="grid grid-cols-8">
            {(boardFlipped ? [1, 2, 3, 4, 5, 6, 7, 8] : ranks).flatMap((rank, dr) => (boardFlipped ? ['h', 'g', 'f', 'e', 'd', 'c', 'b', 'a'] : files).map((file, dc) => {
              const r = boardFlipped ? 7 - dr : dr
              const c = boardFlipped ? 7 - dc : dc
              const square = `${file}${rank}`
              const dark = (r + c) % 2 === 1
              const piece = state?.chess_board?.[r]?.[c]
              const glyph = piece ? pieceGlyphs[piece] : undefined
              const isSelected = selected?.r === r && selected?.c === c
              const isTarget = selectedTargets.has(`${r},${c}`)
              const isCapture = isTarget && !!piece && piece !== '.'
              const isCastleTarget =
                isTarget &&
                !isCapture &&
                (selected?.r === 7 || selected?.r === 0) &&
                selected?.c === 4 &&
                (c === 2 || c === 6)
              const canSelect = !!piece && piece !== '.' && isMyTurn && historyIndex === history.length - 1 && sideOf(piece) === state?.chess_turn
              return <div
                key={square}
                data-square={square}
                data-selected={isSelected ? 'true' : undefined}
                data-target={isTarget ? 'true' : undefined}
                onClick={() => {
                  if (!state || !isMyTurn || historyIndex !== history.length - 1) return
                  if (isSelected) {
                    setSelected(null)
                    return
                  }
                  if (selected && selectedTargets.has(`${r},${c}`)) {
                    const fromSquare = `${files[selected.c]}${ranks[selected.r]}`
                    const toSquare = `${files[c]}${ranks[r]}`
                    const movingPiece = state.chess_board?.[selected.r]?.[selected.c] ?? ''
                    let move = `${fromSquare}${toSquare}`
                    const isPromotion =
                      (movingPiece === 'P' && r === 0) ||
                      (movingPiece === 'p' && r === 7)
                    setSelected(null)
                    if (isPromotion) {
                      setPromotionMove({ move, r, c })
                    } else {
                      submitMove(move)
                    }
                    return
                  }
                  if (selected) {
                    const sp = state.chess_board?.[selected.r]?.[selected.c]
                    if (piece && piece !== '.' && sideOf(piece) === sideOf(sp ?? '')) {
                      setSelected({ r, c })
                      return
                    }
                    setSelected(null)
                    return
                  }
                  if (canSelect) setSelected({ r, c })
                }}
                className={cn(
                  'relative flex aspect-square items-center justify-center select-none',
                  dark ? 'bg-[#b58863]' : 'bg-[#f0d9b5]',
                  (canSelect || (selected && isTarget)) && 'cursor-pointer',
                  isSelected && 'ring-4 ring-inset ring-accent/70',
                )}
              >
                {isTarget && !isCapture && <span className="absolute z-0 h-[28%] w-[28%] rounded-full bg-black/25" />}
                {isCastleTarget && <span className="absolute inset-[10%] z-0 rounded-full border-4 border-dashed border-black/45" />}
                {isTarget && isCapture && <span className="absolute inset-[6%] z-0 rounded-full border-4 border-black/35" />}
                {glyph && <span aria-label={`${piece} on ${square}`} className={cn('relative z-10 text-[clamp(1.7rem,6vw,4.2rem)] leading-none drop-shadow-[0_1px_1px_rgba(0,0,0,0.35)]', piece && piece === piece.toUpperCase() ? 'text-[#fffdf6]' : 'text-[#1c1917]')}>{glyph}</span>}
                {dc === 0 && <span className="absolute left-1 top-0.5 text-[10px] font-bold text-[#6b4934]">{rank}</span>}
                {dr === 7 && <span className="absolute bottom-0 right-1 text-[10px] font-bold text-[#6b4934]">{file}</span>}
              </div>
             }))}
          </div>
            {ghostMove && (
            <span
              aria-hidden
              className="chess-ghost-piece flex items-center justify-center"
              style={{
                ['--fr' as string]: String(boardFlipped ? 7 - ghostMove.from.r : ghostMove.from.r),
                ['--fc' as string]: String(boardFlipped ? 7 - ghostMove.from.c : ghostMove.from.c),
                ['--tr' as string]: String(boardFlipped ? 7 - ghostMove.to.r : ghostMove.to.r),
                ['--tc' as string]: String(boardFlipped ? 7 - ghostMove.to.c : ghostMove.to.c),
              }}
            >
              <span className={cn(
                'text-[clamp(1.7rem,6vw,4.2rem)] leading-none drop-shadow-[0_1px_1px_rgba(0,0,0,0.35)]',
                ghostMove.piece === ghostMove.piece.toUpperCase() ? 'text-[#fffdf6]' : 'text-[#1c1917]',
              )}>{pieceGlyphs[ghostMove.piece]}</span>
            </span>
          )}
          </div>
          {promotionMove && (
            <div
              className="absolute z-20 w-56 -translate-x-1/2 rounded-xl border border-accent-border bg-bg/95 p-3 text-center shadow-2xl backdrop-blur"
              style={{
                left: `${((boardFlipped ? 7 - promotionMove.c : promotionMove.c) + 0.5) * 12.5}%`,
                top: (boardFlipped ? 7 - promotionMove.r : promotionMove.r) === 0 ? '2%' : '72%',
              }}
            >
              <p className="text-sm font-semibold text-text-h">Choose promotion</p>
              <div className="mt-2 grid grid-cols-4 gap-2">
                {(['q', 'r', 'b', 'n'] as const).map((piece) => (
                  <button
                    key={piece}
                    type="button"
                    onClick={() => submitMove(`${promotionMove.move}${piece}`)}
                    className="rounded-lg border border-border bg-bg px-2 py-2 text-2xl text-text-h hover:border-accent-border"
                    aria-label={{ q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' }[piece]}
                  >
                    {pieceGlyphs[state?.chess_turn === 'w' ? piece.toUpperCase() : piece]}
                  </button>
                ))}
              </div>
              <button type="button" onClick={() => setPromotionMove(null)} className="mt-2 text-xs text-text underline">Cancel</button>
            </div>
          )}
          {error ? <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500"><span>{env.withdrawChainName} unavailable: {error}</span><button type="button" onClick={() => void loadChessHistory()} className="shrink-0 font-medium underline">Retry</button></div> : <>
            <p className="mt-3 text-center text-xs text-text">
              {!state
                ? 'No on-chain state for this game yet.'
                : gameOver && resultLabel
                  ? `${resultLabel} · Moves played: ${state?.chess_move_count ?? 0} · block ${activeEntry?.block_number ?? '—'}`
                  : `${turnLabel} · Moves played: ${state?.chess_move_count ?? 0} · ${state?.chess_result ?? 'Game in progress'} · block ${activeEntry?.block_number ?? '—'}`}
            </p>
            <div className="mt-3 flex items-center justify-center gap-2">
              <button type="button" disabled={historyIndex <= 0} onClick={() => setHistoryIndex((index) => index - 1)} className="rounded-lg border border-border px-3 py-1.5 text-xs text-text transition-colors enabled:hover:border-accent-border disabled:cursor-not-allowed disabled:opacity-40">← Previous</button>
              <span className="min-w-32 text-center text-xs text-text">{history.length === 0 ? 'No moves' : `Move history ${state?.chess_move_count ?? 0} / ${history.at(-1)?.value.chess_move_count ?? 0}`}</span>
              <button type="button" disabled={historyIndex >= history.length - 1} onClick={() => setHistoryIndex((index) => index + 1)} className="rounded-lg border border-border px-3 py-1.5 text-xs text-text transition-colors enabled:hover:border-accent-border disabled:cursor-not-allowed disabled:opacity-40">Next →</button>
              <button type="button" onClick={() => setHistoryIndex(history.length - 1)} className="rounded-lg px-2 py-1.5 text-xs text-accent hover:bg-accent-bg">Latest</button>
            </div>
          </>}
        </section>
        <aside className="rounded-2xl border border-border bg-bg p-5 shadow-card">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-text-h">Predict the result</h2>
              <p className="mt-1 text-sm text-text">{advancedMode ? 'Trade with more control.' : 'Select one possible game outcome.'}</p>
            </div>
            <button type="button" onClick={() => setAdvancedMode((value) => !value)} className={cn('shrink-0 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors', advancedMode ? 'border-accent bg-accent-bg text-accent' : 'border-border text-text-h hover:border-accent-border')}>
              {advancedMode ? 'Basic mode' : 'Advanced mode'}
            </button>
          </div>
          {advancedMode ? (
            <div className="mt-4 rounded-xl border border-accent-border bg-accent-bg/50 p-3">
              <div className="grid grid-cols-3 gap-1 rounded-lg border border-border bg-bg p-1">
                {([['buy', 'Buy'], ['sell', 'Sell'], ['mint', 'Mint']] as const).map(([value, label]) => (
                  <button key={value} type="button" onClick={() => setAdvancedAction(value)} className={cn('rounded-md px-2 py-2 text-xs font-semibold', advancedAction === value ? 'bg-accent text-white' : 'text-text hover:text-text-h')}>
                    {label}
                  </button>
                ))}
              </div>
              {advancedAction !== 'mint' ? (
                <>
                  <p className="mt-3 text-xs text-text">{advancedAction === 'buy' ? 'Buy outcome tokens with a resting Limit Order.' : 'Sell outcome tokens with a resting Limit Order.'}</p>
                  <label className="mt-3 block text-xs text-text">Price<input value={advancedPrice} onChange={(event) => setAdvancedPrice(event.target.value)} inputMode="decimal" className="mt-1 h-10 w-full rounded-lg border border-border bg-bg px-2 font-mono text-sm text-text-h" /></label>
                  <label className="mt-2 block text-xs text-text">Shares<input value={advancedAmount} onChange={(event) => setAdvancedAmount(event.target.value)} inputMode="decimal" className="mt-1 h-10 w-full rounded-lg border border-border bg-bg px-2 font-mono text-sm text-text-h" /></label>
                  <div className="mt-3">
                    <p className="text-xs text-text">Outcome</p>
                    <div className="mt-1 grid grid-cols-2 gap-2">
                      {(['yes', 'no'] as const).map((token) => (
                        <button key={token} type="button" onClick={() => setAdvancedToken(token)} className={cn('rounded-lg border px-3 py-2 text-left transition-colors', advancedToken === token ? 'border-accent bg-accent-bg' : 'border-border bg-bg hover:border-accent-border')}>
                          <p className="font-mono text-sm font-semibold text-text-h">{token === 'yes' ? fmtShares(yesRaw) : fmtShares(noRaw)}</p>
                          <p className="mt-0.5 text-xs font-semibold tracking-wider text-text">{token === 'yes' ? 'White wins' : 'Black wins'}</p>
                        </button>
                      ))}
                    </div>
                  </div>
                  <button type="button" onClick={() => void placeLimitOrder()} disabled={tradingLocked || sendingMove || submitting || !address || !limitPreview.args} title={tradingLockReason ?? undefined} className="mt-3 w-full rounded-lg bg-accent px-3 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40">
                    {!address
                      ? 'Connect wallet to trade'
                      : sendingMove || submitting
                        ? 'Submitting…'
                        : `Place ${advancedAction === 'buy' ? 'Buy' : 'Sell'} Limit Order`}
                  </button>
                  {tradingLockReason && <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">{tradingLockReason}</p>}
                  {!tradingLockReason && limitPreview.error && <p className="mt-2 text-xs text-red-500">{limitPreview.error}</p>}
                  {!tradingLockReason && !limitPreview.error && limitPreview.args && (
                    <p className="mt-2 text-xs text-text">Est. {limitPreview.estShares} shares for {limitPreview.estQuote} USDC at {limitPreview.avgPrice} USDC.</p>
                  )}
                  {moveError && <p className="mt-2 text-xs text-red-500">{moveError}</p>}
                </>
              ) : (
                <>
                  <p className="mt-3 text-xs text-text">Mint a complete YES + NO pair into your wallet.</p>
                  <label className="mt-3 block text-xs text-text">Mint amount<input value={advancedAmount} onChange={(event) => setAdvancedAmount(event.target.value)} inputMode="decimal" className="mt-1 h-10 w-full rounded-lg border border-border bg-bg px-2 font-mono text-sm text-text-h" /></label>
                  <button type="button" onClick={() => void mintTokens()} disabled={sendingMove || submitting || !address} className="mt-3 w-full rounded-lg bg-accent px-3 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40">
                    {!address ? 'Connect wallet to mint' : sendingMove || submitting ? 'Minting…' : 'Mint tokens'}
                  </button>
                  {moveError && <p className="mt-2 text-xs text-red-500">{moveError}</p>}
                </>
              )}
              <p className="mt-3 text-[11px] text-text">Advanced trading requires a connected wallet and a live prediction market.</p>
            </div>
          ) : (
            <>
          {gameOver && resultLabel && (
            <p className="mt-3 rounded-lg bg-accent-bg px-3 py-2 text-sm font-medium text-accent">
              Game over — {resultLabel}
            </p>
          )}
      {!state && (
        <div className="mt-4 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-center">
          <p className="text-base font-semibold text-amber-700 dark:text-amber-400">
            Game {gameId} does not exist yet
          </p>
          <p className="mt-1 text-xs text-text">
            There is no on-chain state for this id on {env.withdrawChainName}.
            Use “New chess game” to create it — you will become the White side.
          </p>
        </div>
      )}
      {state && !gameOver && state?.chess_status === 'chess_waiting_for_opponent' && (
            <p className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm font-medium text-amber-700 dark:text-amber-400">
              Waiting for opponent to join — buying and selling are locked until then.
            </p>
          )}
          <div className="mt-4 space-y-2">{(['white', 'black'] as const).map((side) => {
            const selected = selection === side
            const isWhite = side === 'white'
            const price = isWhite ? whiteWinPrice : blackWinPrice
            const dark = isWhite && !selected
            return <button key={side} type="button" onClick={() => { setSelection(side); setSubmitted(false) }} className={cn(
              'flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors',
              selected
                ? 'border-accent bg-gray-100 ring-3 ring-accent/60'
                : 'border-border hover:border-accent-border',
              dark ? 'bg-slate-900 text-white' : null,
            )}>
              <span className={cn(
                'flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xl shadow-sm ring-1 ring-inset ring-black/10',
                isWhite ? 'bg-white text-slate-800' : 'bg-white text-black',
              )}>
                {isWhite ? '♔' : '♚'}
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn('block font-semibold', selected ? 'text-text-h' : dark ? 'text-white' : 'text-text-h')}>{isWhite ? 'White wins' : 'Black wins'}</span>
                <span className={cn('text-xs', selected ? 'text-text' : dark ? 'text-white/70' : 'text-text')}>{isWhite ? 'Hold YES shares' : 'Hold NO shares'}</span>
              </span>
              <span className="shrink-0 text-right">
                <span className={cn('block font-mono text-sm font-semibold', selected ? 'text-text-h' : dark ? 'text-white' : 'text-text-h')}>{fmtPrice(price)}</span>
                <span className={cn('text-[10px]', selected ? 'text-text' : dark ? 'text-white/60' : 'text-text')}>buy at</span>
              </span>
            </button>
          })}</div>
          <p className="mt-3 flex items-center gap-2 text-xs text-text">
            Your holdings ·
            <span className="inline-flex items-center gap-1.5 rounded-xl border border-slate-900 bg-slate-900 px-2 py-0.5 font-mono text-white">
              <span className="flex h-4 w-4 items-center justify-center rounded-full bg-white text-[10px] text-slate-800">♔</span>
              {fmtShares(yesRaw)}
            </span>
            ·
            <span className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-bg px-2 py-0.5 font-mono text-text-h">
              <span className="flex h-4 w-4 items-center justify-center rounded-full bg-white text-[10px] text-black ring-1 ring-inset ring-black/10">♚</span>
              {fmtShares(noRaw)}
            </span>
          </p>
          <div className="mt-4">
            <p className="text-xs font-medium text-text">Market order amount</p>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {['2', '5', '10'].map((amount) => (
                <button key={amount} type="button" onClick={() => setBasicAmount(amount)} className={cn('rounded-lg border py-2 text-sm font-semibold', basicAmount === amount ? 'border-accent bg-accent-bg text-accent' : 'border-border text-text-h hover:border-accent-border')}>{amount} U</button>
              ))}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <input value={basicAmount} onChange={(event) => setBasicAmount(event.target.value)} inputMode="decimal" placeholder="Custom amount" className="h-10 min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 font-mono text-sm text-text-h" />
              <span className="text-sm text-text">U</span>
            </div>
          </div>
          <button type="button" onClick={() => void placeMarketOrder()} disabled={tradingLocked || sendingMove || submitting || !address} title={tradingLockReason ?? undefined} className="mt-5 w-full rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40">{!address ? 'Connect wallet to buy' : sendingMove || submitting ? 'Submitting…' : `Buy ${selection === 'white' ? 'White wins' : 'Black wins'} · ${basicAmount || '0'} U`}</button>
          {tradingLockReason && <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">{tradingLockReason}</p>}
          {moveError && <p className="mt-2 text-xs text-red-500">{moveError}</p>}
          {submitted && <p role="status" className="mt-3 rounded-lg bg-accent-bg px-3 py-2 text-sm text-accent">Market order submitted: {selection === 'white' ? 'White wins' : 'Black wins'} · {basicAmount || '0'} U</p>}
          <button type="button" onClick={() => void sellAll()} disabled={tradingLocked || sendingMove || submitting || !address || (BigInt(yesRaw || '0') <= 0n && BigInt(noRaw || '0') <= 0n)} title={tradingLockReason ?? undefined} className="mt-3 w-full rounded-lg border border-border px-3 py-2 text-xs font-semibold text-text hover:border-accent-border hover:text-text-h disabled:cursor-not-allowed disabled:opacity-40">
            {!address
              ? 'Connect wallet to sell'
              : sendingMove || submitting
                ? 'Submitting…'
                : `Sell all (market order) · ${fmtShares(yesRaw)} YES + ${fmtShares(noRaw)} NO`}
          </button>
            </>
          )}
          {generatedCall && (
            <div className="mt-5 border-t border-border pt-4">
              <p className="text-xs font-medium text-text">Debug move call</p>
              <pre className="mt-2 overflow-x-auto rounded-lg border border-border bg-bg p-2 text-xs text-text-h">{generatedCall}</pre>
              {pendingMove && (
                <button
                  type="button"
                  disabled={sendingMove || submitting}
                  onClick={() => void sendMove(pendingMove)}
                  className="mt-2 w-full rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
                >
                  {sendingMove || submitting ? 'Sending…' : 'Send via wallet'}
                </button>
              )}
              {moveError && <p className="mt-2 text-xs text-red-500">{moveError}</p>}
              {txHash && <p className="mt-2 break-all font-mono text-xs text-text">tx: {txHash}</p>}
              <button type="button" onClick={() => void loadChessHistory()} className="mt-2 w-full rounded-lg border border-border px-3 py-2 text-xs font-semibold text-text hover:border-accent-border">
                Refresh
              </button>
            </div>
          )}
        </aside>
      </div>
    </AppLayout>
  )
}
