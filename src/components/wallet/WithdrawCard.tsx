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
import { useQuoteTokenBalance } from '@/hooks/useQuoteTokenBalance'
import { isUserRejected, toErrorMessage } from '@/lib/wallet'
import {
  ZEN_CONTRACT,
  ZENTRA_ENVS,
  buildBridgeOutgoingData,
  formatUsdc,
  isEnvConfigured,
  parseUsdcAmount,
} from '@/lib/zentra'
import { type QuoteToken } from '@/lib/market'
import { useChainModeStore } from '@/store/chainMode'

export function WithdrawCard({ address }: { address: Address | undefined }) {
  const mode = useChainModeStore((s) => s.mode)
  const env = ZENTRA_ENVS[mode]
  const configured = isEnvConfigured(env)
  const tokenOptions = env.withdrawTokens
  const [token, setToken] = useState<QuoteToken>(tokenOptions[0]?.token ?? 'USDC')
  const tokenOption =
    tokenOptions.find((t) => t.token === token) ?? tokenOptions[0]
  const chains = tokenOption?.chains ?? []
  const [chainId, setChainId] = useState(chains[0]?.id ?? '')
  const chain = chains.find((c) => c.id === chainId) ?? chains[0]
  const destToken = tokenOption?.token ?? 'USDC'
  const toast = useToast()
  const {
    data: balance,
    isLoading,
    error: balanceError,
    refetch,
  } = useQuoteTokenBalance(address, destToken)
  const { sendTransactionAsync, isPending: submitting } = useSendTransaction()
  const { switchChainAsync } = useSwitchChain()
  const currentChainId = useChainId()
  const [amountInput, setAmountInput] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>()

  const { data: receipt } = useWaitForTransactionReceipt({
    hash: txHash,
    confirmations: 1,
    chainId: env.withdrawChainId,
  })

  const selectToken = (value: QuoteToken) => {
    if (value === destToken) return
    setToken(value)
    setTxHash(undefined)
    setFormError(null)
    setAmountInput('')
    const next = tokenOptions.find((t) => t.token === value)
    const nextChain = next?.chains.find((c) => c.id === chainId) ?? next?.chains[0]
    if (nextChain && nextChain.id !== chainId) {
      setChainId(nextChain.id)
    }
  }

  const selectChain = (id: string) => {
    if (id === chain?.id) return
    setChainId(id)
    setTxHash(undefined)
    setFormError(null)
    setAmountInput('')
  }

  const handleSubmit = async () => {
    setFormError(null)
    if (!address || !configured || !chain) return
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
        data: buildBridgeOutgoingData(raw, destToken, chain.chainKey),
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
        <h2 className="text-base font-semibold text-text-h">
          Withdraw {destToken}
        </h2>
        <span className="rounded-full bg-accent-bg px-2.5 py-0.5 text-xs font-medium text-accent">
          {chain?.chainName}
        </span>
      </div>
      <p className="mt-1 text-xs text-text">
        Bridge {destToken} from the indexer back to {chain?.chainName}. The
        transaction is always sent to Zentra on {env.withdrawChainName},
        regardless of your wallet's current network — approve the network
        switch if prompted. Funds arrive on {chain?.chainName} after the
        operator processes the withdrawal.
      </p>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs text-text" htmlFor="withdraw-token">
            Currency
          </label>
          <select
            id="withdraw-token"
            value={destToken}
            disabled={submitting}
            onChange={(e) => selectToken(e.target.value as QuoteToken)}
            className="mt-1.5 h-11 w-full rounded-xl border border-border bg-bg px-3 text-sm text-text-h outline-none transition-colors focus:border-accent-border disabled:opacity-60"
          >
            {tokenOptions.map((t) => (
              <option key={t.token} value={t.token}>
                {t.token}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-text" htmlFor="withdraw-chain">
            Withdraw to
          </label>
          <select
            id="withdraw-chain"
            value={chain?.id ?? ''}
            disabled={submitting || !chain}
            onChange={(e) => selectChain(e.target.value)}
            className="mt-1.5 h-11 w-full rounded-xl border border-border bg-bg px-3 text-sm text-text-h outline-none transition-colors focus:border-accent-border disabled:opacity-60"
          >
            {chains.map((c) => (
              <option key={c.id} value={c.id}>
                {c.chainName}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-border bg-bg p-3">
        <div className="flex items-center justify-between">
          <p className="text-xs text-text">Available balance</p>
          <p className="font-mono text-sm text-text-h">
            {isLoading
              ? '…'
              : balanceError
                ? '—'
                : `${formatUsdc(balance ?? 0n, 2)} ${destToken}`}
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
          {env.withdrawChainName} is not configured yet. The production indexer
          details are pending.
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
        disabled={!configured || !address || !!receipt || !chain}
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
