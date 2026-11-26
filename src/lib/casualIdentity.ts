import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const STORAGE_KEY = 'casual-chess-anonymous-key'

let anonymousAccount: ReturnType<typeof privateKeyToAccount> | null = null

export function getAnonymousCasualAccount() {
  if (anonymousAccount) return anonymousAccount
  let key: string | null = null
  try {
    key = localStorage.getItem(STORAGE_KEY)
  } catch {
    key = null
  }
  if (!key) {
    key = generatePrivateKey()
    try {
      localStorage.setItem(STORAGE_KEY, key)
    } catch {
      /* ignore */
    }
  }
  anonymousAccount = privateKeyToAccount(key as `0x${string}`)
  return anonymousAccount
}
