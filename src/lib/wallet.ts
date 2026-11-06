import { numberToHex, type EIP1193Provider } from 'viem'

export interface WalletChainParams {
  chainId: number
  chainName: string
  nativeCurrency: { name: string; symbol: string; decimals: number }
  rpcUrls: readonly string[]
  blockExplorerUrls?: readonly string[]
}

/** Dynamic 钱包的结构化子集（切换网络用） */
export interface ChainSwitcherWallet {
  switchNetwork(networkChainId: number | string): Promise<void>
  getNetwork(): Promise<string | number | undefined>
  connector: { supportsNetworkSwitching(): boolean }
}

interface ErrorLike {
  code?: unknown
  message?: unknown
  shortMessage?: unknown
  details?: unknown
  data?: { originalError?: { code?: unknown; message?: unknown } | null }
}

function rpcErrorCode(error: unknown): number | undefined {
  const err = error as ErrorLike | null
  for (const candidate of [err?.code, err?.data?.originalError?.code]) {
    if (typeof candidate === 'number') return candidate
  }
  return undefined
}

function pickProviderErrorMessage(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const err = error as ErrorLike
  const candidates = [
    err.message,
    err.shortMessage,
    err.details,
    err.data?.originalError?.message,
  ]
  const first = candidates.find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  )
  return first ?? null
}

function isRabbyProvider(provider: unknown): boolean {
  return Boolean((provider as { isRabby?: boolean } | null)?.isRabby)
}

async function readWalletChainId(provider: EIP1193Provider): Promise<number> {
  const chainId = await provider.request({ method: 'eth_chainId' })
  return Number.parseInt(String(chainId), 16)
}

function readWalletNetworkId(
  network: string | number | undefined,
): number | undefined {
  if (typeof network === 'number') return network
  if (network == null) return undefined
  const text = String(network).trim()
  if (text.toLowerCase().startsWith('0x')) {
    return Number.parseInt(text, 16)
  }
  const parsed = Number.parseInt(text, 10)
  return Number.isNaN(parsed) ? undefined : parsed
}

async function ensureWalletChainViaProvider(
  provider: EIP1193Provider,
  params: WalletChainParams,
): Promise<void> {
  // Some wallets expose an account in the app before the provider has
  // authorized it for eth_sendTransaction (especially on localhost chains).
  await provider.request({ method: 'eth_requestAccounts' })
  if ((await readWalletChainId(provider)) === params.chainId) return

  const switchChain = () =>
    provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: numberToHex(params.chainId) }],
    })

  try {
    await switchChain()
  } catch (error) {
    const message = pickProviderErrorMessage(error)?.toLowerCase() ?? ''
    const chainNotFound =
      rpcErrorCode(error) === 4902 ||
      message.includes('unrecognized chain id') ||
      message.includes('unknown chain') ||
      message.includes('chain not found')
    if (!chainNotFound) throw error
    try {
      await provider.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: numberToHex(params.chainId),
            chainName: params.chainName,
            nativeCurrency: params.nativeCurrency,
            rpcUrls: [...params.rpcUrls],
            blockExplorerUrls: params.blockExplorerUrls
              ? [...params.blockExplorerUrls]
              : undefined,
          },
        ],
      })
    } catch (addError) {
      const detail = pickProviderErrorMessage(addError) ?? 'wallet_addEthereumChain failed.'
      const hint = isRabbyProvider(provider)
        ? ` Rabby may not support this network (chainId ${params.chainId}). Switch to another wallet (e.g. MetaMask) or add the network manually in Rabby's settings.`
        : ` Ask the wallet to add ${params.chainName} manually.`
      throw new Error(`${detail}${hint}`)
    }
    await switchChain()
  }

  for (let attempt = 0; attempt < 20; attempt++) {
    if ((await readWalletChainId(provider)) === params.chainId) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Wallet did not switch to ${params.chainName}.`)
}

/**
 * Switch the connected wallet to `params.chainId`. Accepts either a raw
 * EIP-1193 provider or a Dynamic wallet (switchNetwork/getNetwork). Waits
 * until the wallet actually reports the target chain.
 */
export async function ensureWalletChain(
  providerOrWallet: EIP1193Provider | ChainSwitcherWallet | null | undefined,
  params: WalletChainParams,
): Promise<void> {
  if (providerOrWallet && 'request' in providerOrWallet) {
    return ensureWalletChainViaProvider(providerOrWallet, params)
  }

  const wallet = providerOrWallet as ChainSwitcherWallet | null | undefined
  if (!wallet) throw new Error('Connect a wallet first.')
  if (readWalletNetworkId(await wallet.getNetwork()) === params.chainId) return

  if (!wallet.connector.supportsNetworkSwitching()) {
    throw new Error(
      `Wallet does not support switching to ${params.chainName}.`,
    )
  }
  await wallet.switchNetwork(params.chainId)

  for (let attempt = 0; attempt < 20; attempt++) {
    if (readWalletNetworkId(await wallet.getNetwork()) === params.chainId) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Wallet did not switch to ${params.chainName}.`)
}

export function shortAddress(address: string, size = 4): string {
  if (address.length <= 2 + size * 2) return address
  return `${address.slice(0, 2 + size)}…${address.slice(-size)}`
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

export function isAddressLike(value: unknown): value is string {
  return typeof value === 'string' && ADDRESS_RE.test(value)
}

export function clearAuthStorage(): void {
  if (typeof window === 'undefined') return
  const removals: string[] = []
  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i)
    if (!key) continue
    if (key === 'wagmi.store' || key.startsWith('dynamic_') || key.startsWith('sb-')) {
      removals.push(key)
    }
  }
  for (const key of removals) window.localStorage.removeItem(key)
}

export function lastWagmiConnectorUid(): string | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem('wagmi.store')
    if (!raw) return null
    const parsed = JSON.parse(raw) as {
      state?: { connections?: { value?: Record<string, unknown> } }
    }
    const connections = parsed.state?.connections?.value
    if (!connections || typeof connections !== 'object') return null
    const uid = Object.keys(connections)[0]
    return uid ?? null
  } catch {
    return null
  }
}

export function accountColor(address: string): string {
  const hex = address.slice(2, 10)
  const n = Number.parseInt(hex, 16) || 0
  return `hsl(${n % 360} 65% 45%)`
}

export function isUserRejected(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name ?? ''
  const completion = pickProviderErrorMessage(error) ?? ''
  const message = completion.toLowerCase()
  return (
    name.includes('UserRejectedRequestError') ||
    message.includes('rejected') ||
    message.includes('declined') ||
    message.includes('user deny') ||
    rpcErrorCode(error) === 4001
  )
}

export function isWalletNotRegistered(error: unknown): boolean {
  const message = (error as { message?: string } | null)?.message ?? ''
  const lower = message.toLowerCase()
  return (
    lower.includes('not registered') ||
    lower.includes('unregistered') ||
    lower.includes('未注册')
  )
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message && error.message.trim()
      ? error.message
      : 'Something went wrong. Please try again.'
  }
  if (typeof error === 'string' && error.trim()) return error
  return (
    pickProviderErrorMessage(error) ?? 'Something went wrong. Please try again.'
  )
}

export async function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  try {
    document.execCommand('copy')
  } finally {
    document.body.removeChild(ta)
  }
}
