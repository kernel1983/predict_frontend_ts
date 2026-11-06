import { useState } from 'react'
import {
  useChainId,
  useSendTransaction,
  useSwitchChain,
  useWaitForTransactionReceipt,
} from '@/lib/magic'
import { type Address } from 'viem'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/toast-context'
import { useUsdcBalance } from '@/hooks/useUsdcBalance'
import { isUserRejected, toErrorMessage } from '@/lib/wallet'
import {
  ZEN_CONTRACT,
  ZENTRA_ENVS,
  buildBridgeOutgoingData,
  formatUsdc,
  isEnvConfigured,
  parseUsdcAmount,
} from '@/lib/zentra'
import { useChainModeStore } from '@/store/chainMode'

export function WithdrawCard({ address }: { address: Address | undefined }) {
  const mode = useChainModeStore((s) => s.mode)
  const env = ZENTRA_ENVS[mode]
  const configured = isEnvConfigured(env)
  const toast = useToast()
  const {
    data: balance,
    isLoading,
    error: balanceError,
    refetch,
  } = useUsdcBalance(address)
  const { sendTransactionAsync, isPending: submitting } = useSendTransaction()
  const { switchChainAsync } = useSwitchChain()
  const currentChainId = useChainId()
  const [amountInput, setAmountInput] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>()

  const { data: receipt } = useWaitForTransactionReceipt({
    hash: txHash,
    confirmations: 1,
  })

  const handleSubmit = async () => {
    setFormError(null)
    if (!address || !configured) return
    const raw = parseUsdcAmount(amountInput)
    const bal = balance ?? 0n
    if (raw === null || raw <= 0n) {
      setFormError('Enter a valid amount.')
      return
    }
    if (raw > bal) {
      setFormError('Amount exceeds your available balance.')
      return
    }
    try {
      if (currentChainId !== env.withdrawChainId) {
        await switchChainAsync({ chainId: env.withdrawChainId })
      }
      const hash = await sendTransactionAsync({
        chainId: env.withdrawChainId,
        to: ZEN_CONTRACT,
        value: 0n,
        data: buildBridgeOutgoingData(raw),
      })
      setTxHash(hash)
      setAmountInput('')
      toast.push({ title: 'Withdrawal submitted', variant: 'success' })
    } catch (err) {
      if (!isUserRejected(err)) {
        setFormError(toErrorMessage(err))
      }
    }
  }

  const handleMax = () => {
    if (balance) {
      setAmountInput(formatUsdc(balance).replace(/,/g, ''))
    }
  }

  const handleReset = () => {
    setTxHash(undefined)
    void refetch()
    window.setTimeout(() => void refetch(), 10_000)
  }

  return (
    <div className="rounded-2xl border border-border bg-bg p-5 shadow-card">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-text-h">Withdraw USDC</h2>
        <span className="rounded-full bg-accent-bg px-2.5 py-0.5 text-xs font-medium text-accent">
          {env.withdrawChainName}
        </span>
      </div>
      <p className="mt-1 text-xs text-text">
        Bridge USDC from the indexer back to {env.withdrawChainName}. The
        transaction is always sent to {env.withdrawChainName}, regardless of
        your wallet's current network — approve the network switch if prompted.
      </p>

      <div className="mt-4 rounded-xl border border-border bg-bg p-3">
        <div className="flex items-center justify-between">
          <p className="text-xs text-text">Available balance</p>
          <p className="font-mono text-sm text-text-h">
            {isLoading ? '…' : balanceError ? '—' : `${formatUsdc(balance ?? 0n, 2)} USDC`}
          </p>
        </div>
        {balanceError && (
          <p className="mt-1 text-xs text-red-500">
            Failed to load balance: {toErrorMessage(balanceError)}
          </p>
        )}
      </div>

      <div className="mt-3">
        <label className="block text-xs text-text" htmlFor="withdraw-amount">
          Amount
        </label>
        <div className="mt-1.5 flex items-center gap-2">
          <input
            id="withdraw-amount"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.000000"
            value={amountInput}
            disabled={submitting || !!receipt || !configured}
            onChange={(e) => {
              setAmountInput(e.target.value)
              setFormError(null)
            }}
            className="h-11 flex-1 rounded-xl border border-border bg-bg px-3 font-mono text-sm text-text-h outline-none transition-colors focus:border-accent-border disabled:opacity-60"
          />
          <Button variant="secondary" size="md" onClick={handleMax} disabled={!balance}>
            Max
          </Button>
        </div>
      </div>

      {!configured && (
        <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
          {env.withdrawChainName} is not configured yet. The production
          indexer details are pending.
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
          Withdrawal confirmed.{' '}
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
        className="mt-4 w-full"
        loading={submitting}
        disabled={!configured || !address || !!receipt}
        onClick={() => {
          void handleSubmit()
        }}
      >
        {receipt ? 'Withdrawn' : submitting ? 'Confirming…' : 'Withdraw'}
      </Button>

      {receipt && (
        <button
          type="button"
          onClick={handleReset}
          className="mt-3 block w-full text-center text-sm text-accent hover:underline"
        >
          Withdraw again / refresh balance
        </button>
      )}
    </div>
  )
}