import { useState } from 'react'
import {
  useAccount,
  useChains,
  useMagicWallet,
  useSendTransaction,
  waitForReceipt,
} from '@/lib/magic'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/toast-context'
import { ensureWalletChain, isUserRejected, toErrorMessage } from '@/lib/wallet'
import {
  ZEN_CONTRACT,
  ZENTRA_ENVS,
  buildPredictMintData,
  buildZenCallData,
  isEnvConfigured,
} from '@/lib/zentra'
import { formatAmount, formatAmountInput, parseAmount } from '@/lib/amounts'
import { previewMarketOrder } from '@/lib/marketOrder'
import type { PredictBook } from '@/lib/orderBook'
import { QUOTE_DECIMALS, type QuoteToken } from '@/lib/market'
import { useChainModeStore } from '@/store/chainMode'
import { cn } from '@/lib/cn'

const MINT_QUICK = ['1', '5', '10']

type MintFlow = 'idle' | 'mint' | 'sellYes' | 'sellNo' | 'done'

export function MintPanel({
  slug,
  quoteRaw,
  book,
  marketExists,
  enabled,
  onChanged,
  quote = 'USDC',
  quoteDecimals,
}: {
  slug: string
  quoteRaw: string
  book: PredictBook | null
  marketExists: boolean | null
  enabled: boolean
  onChanged: () => void
  quote?: QuoteToken
  quoteDecimals?: number
}) {
  const mode = useChainModeStore((s) => s.mode)
  const env = ZENTRA_ENVS[mode]
  const configured = isEnvConfigured(env)
  const decimals = quoteDecimals ?? QUOTE_DECIMALS[quote]
  const toast = useToast()

  const { address } = useAccount()
  const wallet = useMagicWallet()
  const chains = useChains()
  const { sendTransactionAsync, isPending: submitting } = useSendTransaction()

  const [amount, setAmount] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [flow, setFlow] = useState<MintFlow>('idle')
  const [arbMode, setArbMode] = useState(false)
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>()

  const quoteBalance = BigInt(quoteRaw || '0')
  const amountRaw = parseAmount(amount, decimals)
  const amountTouched = amount.trim() !== ''
  const fmt = (raw: bigint) => formatAmount(raw, decimals, Math.min(decimals, 2))

  const amountError =
    amountRaw === null || amountRaw <= 0n
      ? 'Enter a valid mint amount.'
      : amountRaw > quoteBalance
        ? `Amount exceeds your available ${quote} balance.`
        : null

  const sellYes = previewMarketOrder({
    slug,
    side: 'yes',
    buy: false,
    sellUnit: 'shares',
    amount,
    book: book?.yes ?? null,
    quoteDecimals: decimals,
    quoteLabel: quote,
    quoteBalance,
    holding: amountRaw ?? 0n,
    tokenLabel: 'YES',
    marketExists,
  })
  const sellNo = previewMarketOrder({
    slug,
    side: 'no',
    buy: false,
    sellUnit: 'shares',
    amount,
    book: book?.no ?? null,
    quoteDecimals: decimals,
    quoteLabel: quote,
    quoteBalance,
    holding: amountRaw ?? 0n,
    tokenLabel: 'NO',
    marketExists,
  })

  const hasValidAmount = amountRaw !== null && amountRaw > 0n
  const sellProceeds = (sellYes.quoteRaw ?? 0n) + (sellNo.quoteRaw ?? 0n)
  const edge = hasValidAmount ? sellProceeds - amountRaw : 0n
  const fullDepth =
    hasValidAmount &&
    !sellYes.error &&
    !sellNo.error &&
    !sellYes.partial &&
    !sellNo.partial
  const canArbitrage = fullDepth && edge > 0n
  const sellUnavailable = hasValidAmount && (!sellYes.quoteRaw || !sellNo.quoteRaw)

  const busy =
    submitting ||
    flow === 'mint' ||
    flow === 'sellYes' ||
    flow === 'sellNo'
  const active =
    configured && Boolean(address) && enabled && marketExists !== false

  const confirmed = async (hash: `0x${string}`) => {
    const receipt = await waitForReceipt({
      chainId: env.withdrawChainId,
      hash,
      confirmations: 1,
    })
    if (receipt.status === 'reverted') throw new Error('Transaction reverted')
  }

  const ensureTargetChain = async () => {
    const chain = chains.find((item) => item.id === env.withdrawChainId)
    await ensureWalletChain(wallet, {
      chainId: env.withdrawChainId,
      chainName: chain?.name ?? env.withdrawChainName,
      nativeCurrency: chain?.nativeCurrency ?? {
        name: 'Ether',
        symbol: 'ETH',
        decimals: 18,
      },
      rpcUrls: chain?.rpcUrls.default.http ?? [],
      blockExplorerUrls: chain?.blockExplorers?.default
        ? [chain.blockExplorers.default.url]
        : undefined,
    })
  }

  const sendSell = async (token: 'yes' | 'no', sharesRaw: bigint) => {
    await ensureTargetChain()
    return sendTransactionAsync({
      chainId: env.withdrawChainId,
      account: address,
      to: ZEN_CONTRACT,
      value: 0n,
      data: buildZenCallData('predict_market_order', [
        slug,
        `-${sharesRaw}`,
        token,
        null,
      ]),
    })
  }

  const handleMint = async (alsoSell: boolean) => {
    setFormError(null)
    if (!active) return
    if (amountError) {
      setFormError(amountError)
      return
    }
    if (alsoSell && !canArbitrage) return

    const raw = amountRaw ?? 0n
    let stage: 'mint' | 'sellYes' | 'sellNo' = 'mint'
    try {
      await ensureTargetChain()
      setArbMode(alsoSell)
      setFlow('mint')
      const mintHash = await sendTransactionAsync({
        chainId: env.withdrawChainId,
        account: address,
        to: ZEN_CONTRACT,
        value: 0n,
        data: buildPredictMintData(slug, raw),
      })
      setTxHash(mintHash)
      toast.push({
        title: alsoSell ? 'Mint + sell submitted' : 'Mint submitted',
        variant: 'success',
      })
      await confirmed(mintHash)

      if (alsoSell && raw > 0n) {
        stage = 'sellYes'
        setFlow('sellYes')
        const yesHash = await sendSell('yes', raw)
        setTxHash(yesHash)
        await confirmed(yesHash)

        stage = 'sellNo'
        setFlow('sellNo')
        const noHash = await sendSell('no', raw)
        setTxHash(noHash)
        await confirmed(noHash)
      }

      setFlow('done')
      setAmount('')
      onChanged()
      toast.push({
        title: alsoSell ? 'Mint + sell completed' : 'Mint confirmed',
        variant: 'success',
      })
    } catch (err) {
      setFlow('idle')
      setArbMode(false)
      onChanged()
      if (stage === 'mint') {
        if (!isUserRejected(err)) setFormError(toErrorMessage(err))
      } else {
        setFormError(
          `Mint succeeded, but the ${stage === 'sellYes' ? 'YES' : 'NO'} sale failed. You still hold the minted shares; sell them manually. ${toErrorMessage(err)}`,
        )
      }
    }
  }

  const handleMax = () => {
    setAmount(formatAmountInput(quoteBalance, decimals, Math.min(decimals, 2)))
    setFormError(null)
  }

  const reset = () => {
    setFlow('idle')
    setArbMode(false)
    setTxHash(undefined)
    setFormError(null)
  }

  const stepLabel =
    flow === 'mint'
      ? 'Minting YES + NO…'
      : flow === 'sellYes'
        ? 'Selling YES…'
        : flow === 'sellNo'
          ? 'Selling NO…'
          : null

  return (
    <section className="rounded-2xl border border-border bg-bg p-5 shadow-card">
      <h2 className="text-base font-semibold text-text-h">Mint</h2>
      <p className="mt-1 text-xs leading-relaxed text-text">
        1 {quote} mints 1 YES + 1 NO. Sell both when their bids add up to more
        than 1 {quote}.
      </p>

      <div className="mt-3 flex items-center justify-between">
        <label className="text-xs text-text" htmlFor="mint-amount">
          Amount ({quote})
        </label>
        <span className="text-xs text-text">
          Balance{' '}
          <span className="font-mono text-text-h">{fmt(quoteBalance)}</span>
        </span>
      </div>
      <input
        id="mint-amount"
        inputMode="decimal"
        autoComplete="off"
        placeholder="1.0"
        value={amount}
        disabled={busy || !active}
        onChange={(e) => {
          setAmount(e.target.value)
          setFormError(null)
        }}
        className="mt-1.5 h-11 w-full rounded-xl border border-border bg-bg px-3 font-mono text-sm text-text-h outline-none transition-colors focus:border-accent-border disabled:opacity-60"
      />
      <div className="mt-2 flex gap-2">
        {MINT_QUICK.map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => {
              setAmount(v)
              setFormError(null)
            }}
            disabled={!active || busy}
            className="flex-1 rounded-lg border border-border bg-bg py-1.5 text-sm text-text-h transition-colors hover:border-accent-border disabled:opacity-40"
          >
            {v}
          </button>
        ))}
        <button
          type="button"
          onClick={handleMax}
          disabled={!active || busy}
          className="flex-1 rounded-lg border border-border bg-bg py-1.5 text-sm text-text-h transition-colors hover:border-accent-border disabled:opacity-40"
        >
          Max
        </button>
      </div>

      {amountTouched && !amountError && amountRaw !== null && (
        <div className="mt-3 rounded-xl border border-border bg-bg p-3 text-xs text-text">
          <div className="flex items-center justify-between">
            <span>Mint</span>
            <span className="font-mono text-text-h">
              {fmt(amountRaw)} YES + {fmt(amountRaw)} NO
            </span>
          </div>
          {!sellUnavailable && (
            <div className="mt-1.5 flex items-center justify-between">
              <span>Sell both now</span>
              <span className="font-mono text-text-h">
                {fmt(sellProceeds)} {quote}
              </span>
            </div>
          )}
          {!sellUnavailable && (
            <div
              className={cn(
                'mt-1.5 flex items-center justify-between font-medium',
                edge > 0n
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-text',
              )}
            >
              <span>{edge > 0n ? 'Arbitrage edge' : 'Difference'}</span>
              <span className="font-mono">
                {edge > 0n ? '+' : ''}
                {fmt(edge)} {quote}
              </span>
            </div>
          )}
          {fullDepth && edge > 0n && (
            <p className="mt-2 text-[11px] text-emerald-600 dark:text-emerald-400">
              Current bid depth can fill both sells.
            </p>
          )}
          {!fullDepth && !sellUnavailable && (
            <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
              Current bids cannot fully fill both sides; mint only, or sell
              manually afterward.
            </p>
          )}
          {sellUnavailable && (
            <p className="mt-2 text-[11px] text-text">
              No usable YES/NO bids yet. You can still mint and sell later.
            </p>
          )}
        </div>
      )}

      {amountTouched && amountError && (
        <p className="mt-2 text-center text-[11px] text-red-500">{amountError}</p>
      )}

      {!configured && (
        <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
          {env.withdrawChainName} is not configured yet.
        </div>
      )}
      {!enabled && configured && (
        <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
          Minting is paused while viewing past rounds.
        </div>
      )}
      {marketExists === false && configured && (
        <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
          This market is not live on-chain yet.
        </div>
      )}
      {!address && configured && (
        <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
          Connect a wallet to mint.
        </div>
      )}

      {formError && (
        <div className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-500">
          {formError}
        </div>
      )}

      {stepLabel && (
        <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
          {stepLabel}
          {txHash && (
            <>
              {' '}
              <a
                href={`${env.explorerBase}/tx/${txHash}`}
                target="_blank"
                rel="noreferrer"
                className="font-mono underline"
              >
                {txHash.slice(0, 12)}…
              </a>
            </>
          )}
        </div>
      )}

      {flow === 'done' && (
        <div className="mt-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-600 dark:text-emerald-400">
          {arbMode ? 'Mint + both sells confirmed.' : 'Mint confirmed.'}{' '}
          <button type="button" onClick={reset} className="underline">
            Dismiss
          </button>
        </div>
      )}

      <div className="mt-4 space-y-2">
        <Button
          size="lg"
          className="w-full"
          loading={busy && flow === 'mint' && !arbMode}
          disabled={!active || busy || Boolean(amountError)}
          onClick={() => {
            void handleMint(false)
          }}
        >
          Mint YES + NO
        </Button>
        {canArbitrage && (
          <Button
            size="lg"
            variant="secondary"
            className="w-full"
            loading={arbMode && busy}
            disabled={!active || busy}
            onClick={() => {
              void handleMint(true)
            }}
          >
            Mint + sell both (3 txs)
          </Button>
        )}
      </div>

      <p className="mt-3 break-all text-center font-mono text-[10px] leading-relaxed text-text">
        predict_mint{' '}
        <span className={cn(amountError && amountTouched && 'text-red-500')}>
          {JSON.stringify([slug, amountRaw?.toString() ?? '—'])}
        </span>
      </p>
    </section>
  )
}
