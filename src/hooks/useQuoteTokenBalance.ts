import { useQuery } from '@tanstack/react-query'
import { type Address } from 'viem'
import {
  ZENTRA_ENVS,
  fetchQuoteTokenBalance,
  isEnvConfigured,
} from '@/lib/zentra'
import { type QuoteToken } from '@/lib/market'
import { useChainModeStore } from '@/store/chainMode'

export function useQuoteTokenBalance(address?: Address | null, token: QuoteToken = 'USDC') {
  const mode = useChainModeStore((s) => s.mode)
  const env = ZENTRA_ENVS[mode]
  return useQuery({
    queryKey: ['quote-token-balance', token, mode, address?.toLowerCase() ?? ''],
    queryFn: () =>
      address ? fetchQuoteTokenBalance(address, token) : Promise.resolve(0n),
    enabled: Boolean(address) && isEnvConfigured(env),
    refetchInterval: 15_000,
    staleTime: 5_000,
  })
}
