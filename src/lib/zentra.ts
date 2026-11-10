import { toHex, type Address, type Hex } from 'viem'
import {
  useChainModeStore,
  type ChainMode,
} from '@/store/chainMode'
import { formatAmount, parseAmount } from '@/lib/amounts'
import {
  QUOTE_DECIMALS,
  isQuoteToken,
  type QuoteToken,
} from '@/lib/market'
import {
  normalizePredictBook,
  type PredictBook,
  type RawPredictBook,
} from '@/lib/orderBook'

export const USDC_DECIMALS = 6

/**
 * zen 合约地址 = 空地址占位（两个模式相同）。
 * 链上并没有真正的合约，gazer 只是监听发往该地址的 tx 并解析 input 里的 JSON。
 */
export const ZEN_CONTRACT: Address =
  '0x00000000000000000000000000000000007a656e'

export const MIN_DEPOSIT_USDC = 2
export const MIN_WITHDRAW_USDC = 2

export interface ZentraEnv {
  indexerUrl: string
  withdrawChainId: number
  withdrawChainName: string
  explorerBase: string
  /** 是否允许向 indexer 免费领取测试币 */
  mintEnabled: boolean
}

export const ZENTRA_ENVS: Record<ChainMode, ZentraEnv> = {
  local: {
    indexerUrl: 'http://127.0.0.1:8545',
    withdrawChainId: 31337,
    withdrawChainName: 'Local Zentra',
    explorerBase: '',
    mintEnabled: true,
  },
  testnet: {
    indexerUrl: 'https://testnet3.zentra.dev',
    withdrawChainId: 84532,
    withdrawChainName: 'Base Sepolia',
    explorerBase: 'https://sepolia.basescan.org',
    mintEnabled: true,
  },
  mainnet: {
    indexerUrl: '',
    withdrawChainId: 8453,
    withdrawChainName: 'Base',
    explorerBase: 'https://basescan.org',
    mintEnabled: false,
  },
}

/** indexer 未配置视为不可用 */
export function isEnvConfigured(env: ZentraEnv): boolean {
  return env.indexerUrl !== ''
}

/** Testnet state namespaces are prefixed with `base-`; local state is not. */
function normalizeStatePrefix(prefix: string, mode: ChainMode): string {
  return mode === 'local' || prefix.startsWith('base-') ? prefix : `base-${prefix}`
}

/**
 * 查询 indexer 上某前缀的原始状态值；不存在返回 null，网络/解析错误抛错。
 * 不展开数组，因为 predict 的订单状态本身就是数组。
 */
export async function fetchStateValue(prefix: string): Promise<unknown> {
  const mode = useChainModeStore.getState().mode
  const env = ZENTRA_ENVS[mode]
  if (!isEnvConfigured(env)) {
    throw new Error(`${env.withdrawChainName} is not configured yet.`)
  }
  const statePrefix = normalizeStatePrefix(prefix, mode)
  const url = `${env.indexerUrl}/api/get_latest_state?prefix=${encodeURIComponent(statePrefix)}`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Failed to fetch state (${res.status})`)
  }
  const text = await res.text()
  const data = JSON.parse(text, (_key, value) =>
    typeof value === 'number' && !Number.isSafeInteger(value) ? BigInt(value) : value,
  ) as { result?: unknown }
  return data?.result ?? null
}

/**
 * 查询 indexer 上某前缀的标量状态；不存在返回 null，网络/解析错误抛错。
 */
export async function fetchStateMaybe(prefix: string): Promise<string | null> {
  let val = await fetchStateValue(prefix)
  if (Array.isArray(val)) val = val[0] ?? null
  if (val === null || val === undefined || val === '') return null
  return String(val)
}

/**
 * 查询 indexer 上某前缀的状态 value（原始值），未配置/出错抛错。
 * 返回字符串以保留大整数精度；不存在返回 '0'。
 */
export async function fetchRawState(prefix: string): Promise<string> {
  return (await fetchStateMaybe(prefix)) ?? '0'
}

export interface PredictMarketProbe {
  slug: string
  /** best-effort 判断：探测到任何非空状态即视为已在链上创建 */
  marketExists: boolean
  foundPrefix: string | null
  orderbookExists: boolean
  orderbook: PredictOrderbook
  /** 逐前缀探测结果明细（调试用） */
  details: string
  error: string | null
}

/** 调试用：探测 slug 是否已在 indexer/链上创建，返回各查询原始结果 */
export async function fetchPredictMarketProbe(slug: string): Promise<PredictMarketProbe> {
  const env = ZENTRA_ENVS[useChainModeStore.getState().mode]
  const probe: PredictMarketProbe = {
    slug,
    marketExists: false,
    foundPrefix: null,
    orderbookExists: false,
    orderbook: { yes: null, no: null, yesBid: null, noBid: null },
    details: '',
    error: null,
  }
  if (!isEnvConfigured(env)) {
    probe.error = `${env.withdrawChainName} indexer is not configured yet.`
    return probe
  }

  try {
    const book = await fetchPredictOrderbook(slug)
    probe.orderbook = book
    probe.orderbookExists = book.yes !== null || book.no !== null
    probe.details += `predict_orderbook?slug= → ${JSON.stringify(book)}\n`
  } catch (err) {
    probe.details += `predict_orderbook?slug= → error ${toErrorMessageSafe(err)}\n`
  }

  // 市场创建后 indexer 会在 base-predict-{slug}_* 命名空间写入非空状态
  // （quote_token="USDC"，yes/no 的 buy_start/buy_new/sell_start/sell_new=1）
  const prefixes = [
    `base-predict-${slug}_quote_token`,
    `base-predict-${slug}_yes_buy_start`,
    `base-predict-${slug}_no_buy_start`,
    `base-predict-${slug}_yes_sell_start`,
    `base-predict-${slug}_no_sell_start`,
  ]
  for (const prefix of prefixes) {
    try {
      const res = await fetch(
        `${env.indexerUrl}/api/get_latest_state?prefix=${encodeURIComponent(normalizeStatePrefix(prefix, useChainModeStore.getState().mode))}`,
      )
      const text = await res.text()
      const raw = (JSON.parse(text) as { result?: unknown }).result
      const serialized =
        raw === null || raw === undefined
          ? 'null'
          : String(Array.isArray(raw) ? JSON.stringify(raw) : raw)
      const empty =
        raw === null ||
        raw === undefined ||
        serialized === '' ||
        serialized === '0' ||
        serialized === '[]' ||
        (Array.isArray(raw) && (raw as unknown[]).length === 0)
      probe.details += `${prefix} → ${empty ? '∅' : serialized.slice(0, 120)}\n`
      if (!empty && probe.foundPrefix === null) {
        probe.marketExists = true
        probe.foundPrefix = prefix
      }
    } catch (err) {
      probe.details += `${prefix} → error ${toErrorMessageSafe(err)}\n`
    }
  }

  return probe
}

function toErrorMessageSafe(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function parseQuoteToken(raw: string | null): QuoteToken | null {
  if (raw === null) return null
  const value = raw.trim().replace(/^["']|["']$/g, '').toUpperCase()
  if (value === '' || value === '0' || value === 'NULL' || value === '[]') return null
  return isQuoteToken(value) ? value : null
}

/** 老市场没有 quote_token 状态时按 slug 推断 */
export function quoteForSlug(slug: string): QuoteToken {
  return slug.includes('_updownusdg_') ? 'USDG' : 'USDC'
}

export interface PredictMarketMeta {
  slug: string
  quote: QuoteToken
  quoteDecimals: number
  /** quote_token 状态存在即视为已创建 */
  exists: boolean
  quoteRaw: string | null
}

/** 查询市场报价币种与精度；市场未创建时 exists=false，quote 按 slug 推断 */
export async function fetchPredictMarketMeta(slug: string): Promise<PredictMarketMeta> {
  const quoteRaw = await fetchStateMaybe(`base-predict-${slug}_quote_token`)
  const parsed = parseQuoteToken(quoteRaw)
  const quote = parsed ?? quoteForSlug(slug)
  let quoteDecimals = QUOTE_DECIMALS[quote]

  if (parsed !== null) {
    try {
      const decimalsRaw = await fetchStateMaybe(`base-${quote}-decimal`)
      const decimals = Number(decimalsRaw)
      if (Number.isInteger(decimals) && decimals >= 0 && decimals <= 18) {
        quoteDecimals = decimals
      }
    } catch {
      // 精度状态缺失时用币种默认值
    }
  }

  return {
    slug,
    quote,
    quoteDecimals,
    exists: parsed !== null,
    quoteRaw,
  }
}

/** 查询 indexer 上某地址的 USDC 余额（rollup 内部状态） */
export async function fetchUsdcBalance(address: Address): Promise<bigint> {
  return BigInt(await fetchRawState(`base-USDC-balance:${address.toLowerCase()}`))
}

/** 查询 indexer 上某地址的 USDG 余额（rollup 内部状态） */
export async function fetchUsdgBalance(address: Address): Promise<bigint> {
  return BigInt(await fetchRawState(`base-USDG-balance:${address.toLowerCase()}`))
}

export interface PredictOrderbook {
  /** bestAsk：买入一档（吃单卖一）价格，美元 */
  yes: number | null
  no: number | null
  /** bestBid：卖出一档（吃单买一）价格，美元 */
  yesBid: number | null
  noBid: number | null
}

/** indexer 原始盘口一级：price 按 quote 精度缩放（6 位），base 为份额、quote 为金额 */
export interface PredictOrderbookLevel {
  id?: number
  owner?: string
  base: string
  quote: string
  price: string
}

/** indexer 返回的原始订单簿：每侧 bestAsk/bestBid 为美元字符串或 null，asks/bids 为盘口级 */
export interface PredictOrderbookSide {
  bestAsk: string | null
  bestBid: string | null
  asks: PredictOrderbookLevel[]
  bids: PredictOrderbookLevel[]
}

export interface PredictOrderbookRaw {
  slug: string
  yes: PredictOrderbookSide
  no: PredictOrderbookSide
}

/** 订单簿查询参数：chess 用命名空间 chess_predict、价格精度 1e6；updown 用默认 predict / 1e18 */
export interface PredictOrderbookOptions {
  namespace?: string
  priceDecimals?: number
}

/** 查询 indexer 上某个 updown slug 的原始订单簿（调试用） */
export async function fetchPredictOrderbookRaw(
  slug: string,
  opts: PredictOrderbookOptions = {},
): Promise<PredictOrderbookRaw | null> {
  const env = ZENTRA_ENVS[useChainModeStore.getState().mode]
  if (!isEnvConfigured(env)) {
    throw new Error(`${env.withdrawChainName} is not configured yet.`)
  }
  const params = new URLSearchParams({ slug })
  if (opts.namespace) params.set('ns', opts.namespace)
  if (opts.priceDecimals !== undefined) params.set('dec', String(opts.priceDecimals))
  const url = `${env.indexerUrl}/api/predict_orderbook?${params.toString()}`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Failed to fetch orderbook (${res.status})`)
  }
  const data = (await res.json()) as {
    slug?: string
    result?: { yes?: PredictOrderbookSide; no?: PredictOrderbookSide } | null
  }
  if (!data?.result?.yes || !data?.result?.no) return null
  return {
    slug: data.slug ?? slug,
    yes: data.result.yes,
    no: data.result.no,
  }
}

/**
 * 从原始盘口归一化出完整深度。
 * bestAsk/bestBid 由本地按 price 重算，避免公开 indexer 用 1e18 缩放 6 位报价的问题。
 */
export async function fetchPredictBook(
  slug: string,
  quoteDecimals = USDC_DECIMALS,
  opts: PredictOrderbookOptions = {},
): Promise<PredictBook | null> {
  const raw = await fetchPredictOrderbookRaw(slug, opts)
  if (!raw) return null
  return normalizePredictBook(raw as RawPredictBook, quoteDecimals)
}

/** 查询 indexer 上某个 updown slug 的 YES/NO bestAsk（买入价）与 bestBid（卖出价），美元 */
export async function fetchPredictOrderbook(
  slug: string,
  quoteDecimals = USDC_DECIMALS,
  opts: PredictOrderbookOptions = {},
): Promise<PredictOrderbook> {
  const book = await fetchPredictBook(slug, quoteDecimals, opts)
  return {
    yes: book?.yes.bestAsk ?? null,
    no: book?.no.bestAsk ?? null,
    yesBid: book?.yes.bestBid ?? null,
    noBid: book?.no.bestBid ?? null,
  }
}

/** 构造发往 zen 合约的 calldata：把 JSON 文本序列化为 utf-8 hex */
export function buildZenCallData(fn: string, args: unknown[]): Hex {
  return toHex(JSON.stringify({ p: 'zentest3', f: fn, a: args }))
}

export interface PredictOpenOrder {
  token: 'yes' | 'no'
  side: 'buy' | 'sell'
  id: number
  owner: string
  /** 剩余份额（绝对值，6 位小数） */
  baseRaw: bigint
  /** 剩余报价金额（绝对值，quote 精度） */
  quoteRaw: bigint
  priceRaw: bigint
  /** 每份价格（quote 单位） */
  price: number
}

function asBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') return BigInt(Math.trunc(value))
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      return BigInt(value)
    } catch {
      return 0n
    }
  }
  return 0n
}

function asOrderId(value: unknown): number | null {
  const raw = Array.isArray(value) ? value[0] : value
  const id = Number(raw)
  return Number.isInteger(id) && id > 0 ? id : null
}

/** 遍历 indexer 上某市场某侧订单链表，返回指定地址的在场限价单 */
export async function fetchPredictOpenOrders(
  slug: string,
  owner: string,
  quoteDecimals = USDC_DECIMALS,
): Promise<PredictOpenOrder[]> {
  const ownerLc = owner.toLowerCase()
  const scale = 10 ** quoteDecimals
  const out: PredictOpenOrder[] = []

  for (const token of ['yes', 'no'] as const) {
    for (const side of ['buy', 'sell'] as const) {
      const prefix = `base-predict-${slug}_${token}_${side}`
      let oid = asOrderId(await fetchStateValue(`${prefix}_start`))
      const seen = new Set<number>()

      while (oid !== null && !seen.has(oid) && out.length < 500) {
        seen.add(oid)
        const raw = await fetchStateValue(`${prefix}:${oid}`)
        if (!Array.isArray(raw) || raw.length < 6) break

        const addr = String(raw[0] ?? '').toLowerCase()
        const baseRaw = asBigInt(raw[1])
        const quoteRaw = asBigInt(raw[2])
        const priceRaw = asBigInt(raw[3])
        if (addr === ownerLc && baseRaw !== 0n && priceRaw > 0n) {
          out.push({
            token,
            side,
            id: oid,
            owner: addr,
            baseRaw: baseRaw < 0n ? -baseRaw : baseRaw,
            quoteRaw: quoteRaw < 0n ? -quoteRaw : quoteRaw,
            priceRaw,
            price: Number(priceRaw) / scale,
          })
        }
        oid = asOrderId(raw[5])
      }
    }
  }

  return out
}

/** 铸造 YES/NO：[slug, quote_amount]，1 quote 生成 1 YES + 1 NO */
export function buildPredictMintData(slug: string, quoteAmountRaw: bigint): Hex {
  return buildZenCallData('predict_mint', [slug, quoteAmountRaw.toString()])
}

/** 撤销限价单：[slug, yes|no, buy|sell, order_id] */
export function buildLimitOrderCancelData(
  slug: string,
  token: 'yes' | 'no',
  side: 'buy' | 'sell',
  orderId: number,
): Hex {
  return buildZenCallData('predict_limit_order_cancel', [slug, token, side, orderId])
}

/** 提现：桥接 USDC 到 base（burn rollup 余额，operator 在 L1 出金） */
export function buildBridgeOutgoingData(amount: bigint): Hex {
  return buildZenCallData('bridge_outgoing', ['USDC', amount.toString(), 'base'])
}

/** 免费铸造测试币：向 indexer 申请 amount 单位的模拟 USDC/USDG（仅 testnet） */
export function buildFreeMintData(amount: bigint, token = 'USDC'): Hex {
  return buildZenCallData('token_mint_free', [token, amount.toString()])
}

export function buildFreeMintUsdGData(amount: bigint): Hex {
  return buildFreeMintData(amount, 'USDG')
}

/** 将用户输入的十进制字符串解析为 6 位小数的原始整数，非法返回 null */
function parseDecimal6(input: string): bigint | null {
  return parseAmount(input, USDC_DECIMALS)
}

/** 将用户输入的 USDC 金额（字符串）解析为原始整数（6 位小数），非法返回 null */
export function parseUsdcAmount(input: string): bigint | null {
  return parseDecimal6(input)
}

/** 份额（YES/NO）余额同为 6 位小数，解析规则与 USDC 一致 */
export function parseShareAmount(input: string): bigint | null {
  return parseDecimal6(input)
}

/** 格式化原始 USDC 余额为可读文本，fractionDigits 控制小数位数 */
export function formatUsdc(raw: bigint, fractionDigits = USDC_DECIMALS): string {
  return formatAmount(raw, USDC_DECIMALS, fractionDigits)
}
