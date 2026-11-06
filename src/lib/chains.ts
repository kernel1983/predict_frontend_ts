import type { Chain } from 'viem'
import {
  arbitrum,
  base,
  baseSepolia,
  mainnet,
  optimism,
  polygon,
  sepolia,
} from 'viem/chains'

/** Robinhood Chain Testnet（zentra 调试用，viem 未内置） */
export const robinhoodTestnet: Chain = {
  id: 46630,
  name: 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.testnet.chain.robinhood.com'] },
  },
  blockExplorers: {
    default: {
      name: 'Explorer',
      url: 'https://explorer.testnet.chain.robinhood.com',
    },
  },
}

export const localChain: Chain = {
  id: 31337,
  name: 'Local Zentra',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['http://127.0.0.1:8545'] },
  },
}

/** 应用支持的全部 EVM 链（wagmi 时代的链表 + 调试链） */
export const appChains: readonly Chain[] = [
  mainnet,
  polygon,
  arbitrum,
  optimism,
  base,
  sepolia,
  baseSepolia,
  robinhoodTestnet,
  localChain,
]

export function findAppChain(chainId: number | undefined): Chain | undefined {
  if (chainId === undefined || Number.isNaN(chainId)) return undefined
  return appChains.find((chain) => chain.id === chainId)
}
