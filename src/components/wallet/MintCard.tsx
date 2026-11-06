import { useState } from 'react'
import {
  useChainId,
  useSendTransaction,
  useSwitchChain,
  useWaitForTransactionReceipt,
} from '@/lib/magic'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/toast-context'
import { isUserRejected, toErrorMessage } from '@/lib/wallet'
import {
  ZEN_CONTRACT,
  ZENTRA_ENVS,
  buildFreeMintData,
  isEnvConfigured,
  parseUsdcAmount,
} from '@/lib/zentra'
import { useChainModeStore } from '@/store/chainMode'

const MINT_AMOUNT = '100'

export function MintCard({
  address,
  onMinted,
}: {
  address: string | undefined
  onMinted: () => void
}) {
  const mode = useChainModeStore((s) => s.mode)
  const env = ZENTRA_ENVS[mode]
  const configured = isEnvConfigured(env)
  const toast = useToast()

  const { sendTransactionAsync, isPending: submitting } = useSendTransaction()
  const { switchChainAsync } = useSwitchChain()
  const currentChainId = useChainId()
  const [formError, setFormError] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>()

  const { data: receipt } = useWaitForTransactionReceipt({
    hash: txHash,
    confirmations: 1,
  })

  const handleMint = async () => {
    setFormError(null)
    if (!address || !configured || !env.mintEnabled) return
    try {
      if (currentChainId !== env.withdrawChainId) {
        await switchChainAsync({ chainId: env.withdrawChainId })
      }
      const hash = await sendTransactionAsync({
        chainId: env.withdrawChainId,
        to: ZEN_CONTRACT,
        value: 0n,
        data: buildFreeMintData(parseUsdcAmount(MINT_AMOUNT) ?? 0n),
      })
      setTxHash(hash)
      toast.push({ title: 'Mint transaction submitted', variant: 'success' })
    } catch (err) {
      if (!isUserRejected(err)) {
        setFormError(toErrorMessage(err))
      }
    }
  }

  const handleReset = () => {
    setTxHash(undefined)
    onMinted()
    window.setTimeout(onMinted, 10_000)
  }

  return (
    <div className="rounded-2xl border border-border bg-bg p-5 shadow-card">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-text-h">Claim Test USDC</h2>
        <span className="rounded-full bg-accent-bg px-2.5 py-0.5 text-xs font-medium text-accent">
          {env.withdrawChainName}
        </span>
      </div>
      <p className="mt-1 text-xs text-text">
        Mint {MINT_AMOUNT} Mock USDC from the indexer for testing. The
        transaction is always sent to {env.withdrawChainName}, regardless of
        your wallet's current network — approve the network switch if prompted.
      </p>

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
          Mint confirmed. {MINT_AMOUNT} Mock USDC should appear in your
          balance shortly.{' '}
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
        disabled={!configured || !address || !env.mintEnabled || !!receipt}
        onClick={() => {
          void handleMint()
        }}
      >
        {receipt
          ? 'Claimed'
          : submitting
            ? 'Confirming…'
            : `Claim ${MINT_AMOUNT} Mock USDC`}
      </Button>

      {!address && configured && (
        <p className="mt-3 text-xs text-text">Connect a wallet to claim.</p>
      )}

      {receipt && (
        <button
          type="button"
          onClick={handleReset}
          className="mt-3 block w-full text-center text-sm text-accent hover:underline"
        >
          Claim again / refresh balance
        </button>
      )}

      <div className="mt-4 border-t border-border pt-3">
        <p className="text-xs text-text">No test ETH for gas?</p>
        <a
          href="https://www.alchemy.com/faucets/base-sepolia"
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-block text-xs text-accent underline"
        >
          Claim Base Sepolia ETH
        </a>
      </div>
    </div>
  )
}