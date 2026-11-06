import { useCallback, useContext, useEffect, useMemo, useState, createContext, type ReactNode } from 'react'
import { Magic } from 'magic-sdk'
import { OAuthExtension, type OAuthRedirectResult } from '@magic-ext/oauth2'
import {
  custom,
  createPublicClient,
  createWalletClient,
  http,
  type Chain,
  type EIP1193Provider,
  type Hash,
  type TransactionReceipt,
} from 'viem'
import { waitForTransactionReceipt as viemWaitForTransactionReceipt, estimateFeesPerGas, estimateGas } from 'viem/actions'
import { baseSepolia } from 'viem/chains'
import {
  useAccount as useWagmiAccount,
  useDisconnect as useWagmiDisconnect,
  useSendTransaction as useWagmiSendTransaction,
  useSignMessage as useWagmiSignMessage,
  useSwitchChain as useWagmiSwitchChain,
} from 'wagmi'
import { appChains, findAppChain } from '@/lib/chains'
import { useChainModeStore } from '@/store/chainMode'
import { ZENTRA_ENVS } from '@/lib/zentra'

const publishableKey = import.meta.env.VITE_MAGIC_PUBLISHABLE_KEY as
  | string
  | undefined

/** 是否已配置 Magic（未配置时页面正常渲染，钱包功能禁用） */
export const magicConfigured = Boolean(publishableKey && publishableKey.trim())

const CHAIN_STORAGE_KEY = 'magic_chain_id'

function storedChainId(): number {
  try {
    const raw = window.localStorage.getItem(CHAIN_STORAGE_KEY)
    const parsed = Number.parseInt(raw ?? '', 10)
    if (Number.isInteger(parsed) && parsed > 0) return parsed
  } catch {
    // localStorage 不可用时用默认链
  }
  const mode = useChainModeStore.getState().mode
  return ZENTRA_ENVS[mode].withdrawChainId
}

/** viem wallet client 的最小结构（保持与 wagmi 兼容的形状） */
export interface MinimalWalletClient {
  sendTransaction(params: {
    to: `0x${string}`
    type?: 'legacy' | 'eip1559'
    value?: bigint
    data?: `0x${string}`
    gas?: bigint
    nonce?: number
    maxFeePerGas?: bigint
    maxPriorityFeePerGas?: bigint
  }): Promise<`0x${string}` | undefined>
}

/** 与 wagmi 兼容的最小钱包接口（Magic 邮箱钱包的封装） */
export interface SignerWallet {
  address: string
  getNetwork(): Promise<string | number | undefined>
  isConnected(): Promise<boolean>
  signMessage(message: string): Promise<string | undefined>
  switchNetwork(networkChainId: number | string): Promise<void>
  getWalletClient(chainId?: string): Promise<MinimalWalletClient>
  connector: { name: string; supportsNetworkSwitching(): boolean }
}

interface MagicContextValue {
  magic: OAuthMagic | null
  address: string | null
  chainId: number
  email: string | null
  loginWithMagicLink: (email: string) => Promise<void>
  loginWithGoogle: () => Promise<void>
  logout: () => Promise<void>
  switchNetwork: (chainId: number) => Promise<void>
}

const MagicContext = createContext<MagicContextValue | null>(null)

/** 带 oauth2 扩展的 Magic 实例（Google 重定向登录用） */
type OAuthMagic = Magic & {
  oauth2: {
    loginWithRedirect(configuration: {
      provider: 'google'
      redirectURI: string
    }): Promise<string | null>
    getRedirectResult(configuration?: { lifespan?: number }): Promise<OAuthRedirectResult>
  }
}

function magicForKey(key: string, chainId: number): OAuthMagic {
  const chain = findAppChain(chainId) ?? baseSepolia
  return new Magic(key, {
    network: {
      rpcUrl: chain.rpcUrls.default.http[0],
      chainId: chain.id,
    },
    extensions: [new OAuthExtension()],
  }) as unknown as OAuthMagic
}

function addressOf(metadata: { publicAddress?: string | null } | null | undefined): string | null {
  const value = metadata?.publicAddress
  return typeof value === 'string' && value.toLowerCase().startsWith('0x') ? value : null
}

/** Magic provider 设置（Google 登录 + magic link 登录 + 网络切换 + 地址状态） */
export function MagicProviders({ children }: { children: ReactNode }) {
  if (!magicConfigured) return <>{children}</>
  return <MagicContextProviderImpl>{children}</MagicContextProviderImpl>
}

function MagicContextProviderImpl({ children }: { children: ReactNode }) {
  const [chainId, setChainIdState] = useState<number>(() => storedChainId())
  const [address, setAddress] = useState<string | null>(null)
  const [email, setEmail] = useState<string | null>(null)

  // Magic 一个实例只绑定一条链，chainId 变化时重建实例
  const magic = useMemo(() => {
    if (!magicConfigured) return null
    return magicForKey(publishableKey!.trim(), chainId)
  }, [chainId])

  // 恢复会话 / 同步地址；若 URL 带 OAuth 回调参数则先取回 Google 登录结果
  useEffect(() => {
    if (!magic) return
    let cancelled = false
    void (async () => {
      if (window.location.search && /magic|state|code/i.test(window.location.search)) {
        try {
          const result = await magic.oauth2.getRedirectResult()
          const metadata = result?.magic?.userMetadata
          if (cancelled) return
          if (metadata) {
            setAddress(addressOf(metadata))
            setEmail(metadata.email ?? null)
            return
          }
        } catch {
          // URL 不是 OAuth 回调，走常规会话恢复
        }
      }
      try {
        if (await magic.user.isLoggedIn()) {
          const info = await magic.user.getInfo()
          if (cancelled) return
          setAddress(addressOf(info))
          setEmail(info.email ?? null)
        } else {
          if (cancelled) return
          setAddress(null)
          setEmail(null)
        }
      } catch {
        if (!cancelled) {
          setAddress(null)
          setEmail(null)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [magic])

  const loginWithMagicLink = useCallback(
    async (value: string) => {
      if (!magic) throw new Error('Magic is not configured.')
      const token = await magic.auth.loginWithMagicLink({ email: value })
      if (!token) throw new Error('Magic link sign-in did not complete.')
      const info = await magic.user.getInfo()
      setAddress(addressOf(info))
      setEmail(info.email ?? null)
    },
    [magic],
  )

  const loginWithGoogle = useCallback(
    async () => {
      if (!magic) throw new Error('Magic is not configured.')
      // 重定向到 Google OAuth；回调在 redirectURI 上由 getRedirectResult 完成
      await magic.oauth2.loginWithRedirect({
        provider: 'google',
        redirectURI: `${window.location.origin}/login`,
      })
    },
    [magic],
  )

  const logout = useCallback(
    async () => {
      if (!magic) return
      try {
        await magic.user.logout()
      } finally {
        setAddress(null)
        setEmail(null)
      }
    },
    [magic],
  )

  const setChainId = useCallback(
    async (next: number) => {
      if (!Number.isInteger(next) || next <= 0) {
        throw new Error(`Unknown network: ${next}`)
      }
      try {
        window.localStorage.setItem(CHAIN_STORAGE_KEY, String(next))
      } catch {
        // 存储不可用也继续切换
      }
      setChainIdState(next)
    },
    [],
  )

  return (
    <MagicContext.Provider
      value={{ magic, address, chainId, email, loginWithMagicLink, loginWithGoogle, logout, switchNetwork: setChainId }}
    >
      {children}
    </MagicContext.Provider>
  )
}

/** 无 Provider 时返回 null（hook 调用顺序不变） */
export function useMagicContextSafe(): MagicContextValue | null {
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- 无 Provider 时该 hook 会抛错，try/catch 是刻意的降级手段
    return useContext(MagicContext)
  } catch {
    return null
  }
}

/** 当前 Magic 钱包（email 登录后存在），返回与 wagmi 兼容的最小接口 */
export function useMagicWallet(): SignerWallet | null {
  const ctx = useMagicContextSafe()
  const magic = ctx?.magic ?? null
  const address = ctx?.address ?? null
  const chainId = ctx?.chainId
  const switchNetwork = ctx?.switchNetwork

  return useMemo(() => {
    if (!magic || !address || chainId === undefined || !switchNetwork) return null
    const provider = magic.rpcProvider as unknown as {
      request(args: { method: string; params: unknown[] }): Promise<unknown>
    }
    return {
      address,
      isConnected: async () => Boolean(await magic.user.isLoggedIn()),
      signMessage: async (message: string) => {
        const result = await provider.request({
          method: 'personal_sign',
          params: [message, address],
        })
        return typeof result === 'string' ? result : undefined
      },
      switchNetwork,
      getNetwork: async () => chainId,
      getWalletClient: async () => {
        const chain = findAppChain(chainId) ?? baseSepolia
        return createWalletClient({
          account: address as `0x${string}`,
          chain,
          transport: custom(provider as unknown as EIP1193Provider),
        }) as unknown as MinimalWalletClient
      },
      connector: { name: 'Magic', supportsNetworkSwitching: () => true },
    }
  }, [magic, address, chainId, switchNetwork])
}

/** 登录方式：Magic 邮箱钱包或钱包（wagmi） */
export type LoginType = 'magic' | 'wallet' | null

export function useLoginType(): LoginType {
  const magicWallet = useMagicWallet()
  const wagmi = useWagmiAccount()
  if (magicWallet) return 'magic'
  if (wagmi.isConnected) return 'wallet'
  return null
}

export function useActiveAddress(): `0x${string}` | undefined {
  return useAccount().address
}

export interface WagmiAccount {
  address: `0x${string}` | undefined
  isConnected: boolean
  chainId: number | undefined
  chain: Chain | undefined
  connector: { id: string; name: string } | null
}

export function useAccount(): WagmiAccount {
  const ctx = useMagicContextSafe()
  const magicWallet = useMagicWallet()
  const wagmi = useWagmiAccount()

  if (magicWallet) {
    return {
      address: magicWallet.address as `0x${string}`,
      isConnected: true,
      chainId: ctx?.chainId,
      chain: findAppChain(ctx?.chainId),
      connector: { id: 'magic', name: 'Magic' },
    }
  }

  return {
    address: wagmi.address,
    isConnected: wagmi.isConnected,
    chainId: wagmi.chainId,
    chain: wagmi.chain as Chain | undefined,
    connector: wagmi.connector
      ? { id: wagmi.connector.id, name: wagmi.connector.name }
      : null,
  }
}

export function useChains(): readonly Chain[] {
  return appChains
}

export function useChainId(): number | undefined {
  return useAccount().chainId
}

/** 仅登出 Magic 邮箱会话（wagmi 钱包不受影响） */
export function useMagicLogout() {
  const ctx = useMagicContextSafe()
  return useCallback(async () => {
    await ctx?.logout()
  }, [ctx])
}

export function useDisconnect() {
  const ctx = useMagicContextSafe()
  const wagmiDisconnect = useWagmiDisconnect()

  const disconnectAsync = useCallback(async () => {
    if (ctx?.address) {
      await ctx.logout()
      return
    }
    await wagmiDisconnect.disconnectAsync()
  }, [ctx, wagmiDisconnect])

  return { disconnect: disconnectAsync, disconnectAsync }
}

function notConfiguredError(): Error {
  return new Error(
    'Magic is not configured: set VITE_MAGIC_PUBLISHABLE_KEY in .env',
  )
}

export function useSignMessage() {
  const magicWallet = useMagicWallet()
  const wagmiSign = useWagmiSignMessage()
  const [isPending, setPending] = useState(false)

  const signMessageAsync = useCallback(
    async ({ message }: { message: string }): Promise<`0x${string}`> => {
      if (magicWallet) {
        if (!magicConfigured) throw notConfiguredError()
        setPending(true)
        try {
          const signature = await magicWallet.signMessage(message)
          if (!signature) throw new Error('Signature request was not completed.')
          return signature as `0x${string}`
        } finally {
          setPending(false)
        }
      }
      setPending(true)
      try {
        const signature = await wagmiSign.signMessageAsync({ message })
        return signature as `0x${string}`
      } finally {
        setPending(false)
      }
    },
    [magicWallet, wagmiSign],
  )

  const signMessage = useCallback(
    async (args: { message: string }) => {
      try {
        return await signMessageAsync(args)
      } catch {
        return undefined
      }
    },
    [signMessageAsync],
  )

  return {
    signMessage,
    signMessageAsync,
    isPending: isPending || wagmiSign.isPending,
  }
}

export interface SendTransactionParams {
  chainId?: number
  account?: string
  to: `0x${string}`
  value?: bigint
  data?: `0x${string}`
  gas?: bigint
  nonce?: number
  maxFeePerGas?: bigint
  maxPriorityFeePerGas?: bigint
}

export function useSendTransaction() {
  const magicWallet = useMagicWallet()
  const wagmiSend = useWagmiSendTransaction()
  const [isPending, setPending] = useState(false)

  const sendTransactionAsync = useCallback(
    async (params: SendTransactionParams): Promise<`0x${string}`> => {
      if (magicWallet) {
        if (!magicConfigured) throw notConfiguredError()
        setPending(true)
        try {
          const chainId = params.chainId ?? currentChainId()
          const publicClient = publicClientFor(chainId)
          const fees = await estimateFeesPerGas(publicClient)
          const gas =
            params.gas ??
            (await estimateGas(publicClient, {
              account: magicWallet.address as `0x${string}`,
              to: params.to,
              value: params.value ?? 0n,
              data: params.data,
            }))
          const walletClient = await magicWallet.getWalletClient(String(chainId))
          const hash = await walletClient.sendTransaction({
            to: params.to,
            value: params.value ?? 0n,
            ...(params.data !== undefined ? { data: params.data } : {}),
            gas,
            ...(params.nonce !== undefined ? { nonce: params.nonce } : {}),
            maxFeePerGas: params.maxFeePerGas ?? fees.maxFeePerGas,
            maxPriorityFeePerGas: params.maxPriorityFeePerGas ?? fees.maxPriorityFeePerGas,
          })
          if (!hash) throw new Error('Transaction was not submitted.')
          return hash
        } finally {
          setPending(false)
        }
      }
      setPending(true)
      try {
        const hash = await wagmiSend.sendTransactionAsync({
          to: params.to,
          value: params.value ?? 0n,
          ...(params.data !== undefined ? { data: params.data } : {}),
          ...(params.gas !== undefined ? { gas: params.gas } : {}),
          ...(params.nonce !== undefined ? { nonce: params.nonce } : {}),
          ...(params.maxFeePerGas !== undefined
            ? { maxFeePerGas: params.maxFeePerGas }
            : {}),
          ...(params.maxPriorityFeePerGas !== undefined
            ? { maxPriorityFeePerGas: params.maxPriorityFeePerGas }
            : {}),
          chainId: params.chainId,
          account: params.account as `0x${string}` | undefined,
        })
        if (!hash) throw new Error('Transaction was not submitted.')
        return hash as `0x${string}`
      } finally {
        setPending(false)
      }
    },
    [magicWallet, wagmiSend],
  )

  const sendTransaction = useCallback(
    (params: SendTransactionParams) => sendTransactionAsync(params),
    [sendTransactionAsync],
  )

  return {
    sendTransaction,
    sendTransactionAsync,
    isPending: isPending || wagmiSend.isPending,
  }
}

export function useSwitchChain() {
  const ctx = useMagicContextSafe()
  const wagmiSwitch = useWagmiSwitchChain()
  const switchChainAsync = useCallback(
    async ({ chainId }: { chainId: number }) => {
      if (ctx?.address) {
        if (!magicConfigured) throw notConfiguredError()
        await ctx.switchNetwork(chainId)
        return
      }
      await wagmiSwitch.switchChainAsync({ chainId })
    },
    [ctx, wagmiSwitch],
  )
  const switchChain = useCallback(
    async (args: { chainId: number }) => {
      try {
        await switchChainAsync(args)
      } catch {
        // 静默失败，与 wagmi 的非 async 版本行为一致
      }
    },
    [switchChainAsync],
  )
  return { switchChain, switchChainAsync }
}

function publicClientFor(chainId: number) {
  const chain = findAppChain(chainId) ?? baseSepolia
  return createPublicClient({ chain, transport: http() })
}

function currentChainId(): number {
  const mode = useChainModeStore.getState().mode
  return ZENTRA_ENVS[mode].withdrawChainId
}

export interface WaitForReceiptParams {
  chainId?: number
  hash: Hash
  confirmations?: number
}

export function waitForReceipt(
  params: WaitForReceiptParams,
): Promise<TransactionReceipt> {
  return viemWaitForTransactionReceipt(publicClientFor(params.chainId ?? currentChainId()), {
    hash: params.hash,
    confirmations: params.confirmations ?? 1,
  })
}

export function useWaitForTransactionReceipt(params: {
  hash?: Hash | undefined
  confirmations?: number
  chainId?: number
}) {
  const { hash, confirmations = 1, chainId } = params
  const [data, setData] = useState<TransactionReceipt | undefined>(undefined)
  const [error, setError] = useState<Error | null>(null)
  const [isLoading, setLoading] = useState(false)

  useEffect(() => {
    if (!hash) {
      setData(undefined)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    setData(undefined)
    waitForReceipt({ chainId, hash, confirmations })
      .then((receipt) => {
        if (!cancelled) setData(receipt)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err : new Error(String(err)))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [hash, confirmations, chainId])

  return {
    data,
    error,
    isLoading,
    isSuccess: Boolean(data),
    isError: Boolean(error),
  }
}
