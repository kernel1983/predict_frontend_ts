import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAccount, useChains, useMagicWallet, useSendTransaction } from '@/lib/magic'
import { useToast } from '@/components/ui/toast-context'
import { ensureWalletChain, isAddressLike, isUserRejected, toErrorMessage } from '@/lib/wallet'
import { ZENTRA_ENVS, ZEN_CONTRACT, buildZenCallData, parseUsdcAmount } from '@/lib/zentra'
import { useChainModeStore } from '@/store/chainMode'

export function NewChessGameModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [amount, setAmount] = useState('0')
  const [inviterAddress, setInviterAddress] = useState('')
  const { address } = useAccount()
  const wallet = useMagicWallet()
  const { sendTransactionAsync, isPending } = useSendTransaction()
  const toast = useToast()
  const mode = useChainModeStore((state) => state.mode)
  const env = ZENTRA_ENVS[mode]
  const chains = useChains()
  const [error, setError] = useState<string | null>(null)
  const [createdGameId, setCreatedGameId] = useState<string | null>(null)
  const [waitingForEvent, setWaitingForEvent] = useState(false)

  const createGame = async () => {
    setError(null)
    if (!address) {
      setError('Connect a wallet first.')
      return
    }
    const trimmedAmount = amount.trim()
    const amountRaw = parseUsdcAmount(trimmedAmount)
    if (amountRaw === null) {
      setError('Enter a valid non-negative amount.')
      return
    }
    const trimmedInviter = inviterAddress.trim()
    if (trimmedInviter && !isAddressLike(trimmedInviter)) {
      setError('Inviter address looks invalid.')
      return
    }
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
      const args: unknown[] = ['USDC', amountRaw.toString()]
      if (trimmedInviter) args.push(trimmedInviter)
      const data = buildZenCallData('chess_create_game', args)
      const hash = await sendTransactionAsync({
        chainId: env.withdrawChainId,
        account: address,
        to: ZEN_CONTRACT,
        value: 0n,
        data,
      })
      toast.push({ title: 'Chess game creation submitted', description: hash.slice(0, 12), variant: 'success' })
      const findGameId = (value: unknown, creationEvent = false): string | null => {
        if (Array.isArray(value)) {
          // zentra testnet3 event tuple: [func, eventName, ...args]
          if (value.length >= 3 && typeof value[0] === 'string' && typeof value[1] === 'string') {
            const eventName = value[1]
            const isCreationEvent = creationEvent || /(create|created|creation).*game|game.*(create|created|creation)/.test(eventName.toLowerCase())
            if (isCreationEvent && (typeof value[2] === 'string' || typeof value[2] === 'number')) {
              return String(value[2])
            }
          }
          for (const item of value) {
            const found = findGameId(item, creationEvent)
            if (found) return found
          }
          return null
        }
        if (typeof value === 'string') {
          // Some indexer responses encode an event's data as a JSON string.
          try {
            return findGameId(JSON.parse(value), creationEvent)
          } catch {
            return null
          }
        }
        if (!value || typeof value !== 'object') return null
        const record = value as Record<string, unknown>
        const eventName = [record.event, record.name, record.type, record.kind]
          .filter((candidate): candidate is string => typeof candidate === 'string')
          .join(' ')
          .toLowerCase()
        const isCreationEvent = creationEvent || /(create|created|creation).*game|game.*(create|created|creation)/.test(eventName)
        for (const key of ['game_id', 'gameId', 'chess_game_id', 'game_id_value', 'game']) {
          const candidate = record[key]
          if (typeof candidate === 'string' || typeof candidate === 'number') return String(candidate)
        }
        // The testnet indexer returns the creation event as { ..., data: { id } }.
        if (isCreationEvent) {
          const candidate = record.id
          if (typeof candidate === 'string' || typeof candidate === 'number') return String(candidate)
        }
        for (const key of ['args', 'arguments', 'a']) {
          const args = record[key]
          if (Array.isArray(args) && (typeof args[0] === 'string' || typeof args[0] === 'number')) return String(args[0])
          if (args && typeof args === 'object') {
            const found = findGameId(args, isCreationEvent)
            if (found) return found
          }
        }
        for (const [key, child] of Object.entries(record)) {
          const found = findGameId(child, isCreationEvent || key === 'data' || key === 'result' || key === 'events')
          if (found) return found
        }
        return null
      }
      setWaitingForEvent(true)
      let gameId: string | null = null
      for (let attempt = 0; attempt < 30 && !gameId; attempt += 1) {
        try {
          const txhash = hash.startsWith('0x') ? hash.slice(2) : hash
          const eventsResponse = await fetch(`${env.indexerUrl}/api/events?txhash=${encodeURIComponent(txhash)}`)
          if (eventsResponse.ok) gameId = findGameId(await eventsResponse.json())
        } catch {
          // The event indexer may briefly be unavailable while the tx is mined.
        }
        if (!gameId && attempt < 29) await new Promise((resolve) => window.setTimeout(resolve, 2_000))
      }
      setWaitingForEvent(false)
      if (!gameId) throw new Error('Game created, but the creation event did not include a game id.')
      setCreatedGameId(gameId)
      toast.push({ title: 'Chess game created', description: `Game ${gameId}`, variant: 'success' })
    } catch (reason) {
      console.error('[chess] create game failed', reason)
      if (!isUserRejected(reason)) setError(toErrorMessage(reason))
    }
  }
  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-accent-border bg-bg p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-text-h">New chess game</h3>
            <p className="mt-1 text-sm text-text">Choose how you want to start.</p>
          </div>
          <button type="button" onClick={onClose} className="text-sm text-text hover:text-text-h">✕</button>
        </div>
        <div className="mt-4 grid gap-3">
          <label className="block">
            <span className="block text-xs font-medium text-text">Amount (USDC)</span>
            <input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" placeholder="0" className="mt-1 h-10 w-full rounded-lg border border-border bg-bg px-3 text-sm text-text-h" />
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-text">Inviter address (optional)</span>
            <input value={inviterAddress} onChange={(event) => setInviterAddress(event.target.value)} placeholder="0x… inviter address" className="mt-1 h-10 w-full rounded-lg border border-border bg-bg px-3 font-mono text-xs text-text-h" />
          </label>
        </div>
        {error && <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-500">{error}</p>}
        {createdGameId && <Link to={`/chess/${createdGameId}`} onClick={onClose} className="mt-3 block rounded-lg bg-accent-bg px-3 py-2 text-center text-sm font-semibold text-accent">Go to game {createdGameId} →</Link>}
        <button type="button" disabled={isPending || waitingForEvent} onClick={() => void createGame()} className="mt-4 w-full rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40">{isPending ? 'Waiting for signature…' : waitingForEvent ? 'Waiting for game event…' : 'Create game'}</button>
      </div>
    </div>
  )
}
