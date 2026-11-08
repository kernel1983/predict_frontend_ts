import { create } from 'zustand'

export type ChainMode = 'local' | 'testnet' | 'mainnet'

interface ChainModeState {
  mode: ChainMode
  setMode: (mode: ChainMode) => void
}

const STORAGE_KEY = 'predict:chain-mode'

/** 仅 localhost / 127.0.0.1 允许 Local 模式 */
export function isLocalHost(): boolean {
  try {
    const host = window.location.hostname
    return host === 'localhost' || host === '127.0.0.1'
  } catch {
    return false
  }
}

function loadMode(): ChainMode {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    if (value === 'local' && !isLocalHost()) return 'testnet'
    if (value === 'local' || value === 'testnet' || value === 'mainnet') return value
  } catch {
    // ignore storage errors
  }
  return 'testnet'
}

export const useChainModeStore = create<ChainModeState>((set) => ({
  mode: loadMode(),
  setMode: (mode) => {
    if (mode === 'local' && !isLocalHost()) mode = 'testnet'
    try {
      localStorage.setItem(STORAGE_KEY, mode)
    } catch {
      // ignore storage errors
    }
    set({ mode })
  },
}))
