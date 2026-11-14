import { cn } from '@/lib/cn'
import { isLocalHost, useChainModeStore, type ChainMode } from '@/store/chainMode'
import { useToast } from '@/components/ui/toast-context'

const allModes: { value: ChainMode; label: string }[] = [
  { value: 'local', label: 'Local' },
  { value: 'testnet', label: 'Testnet' },
  { value: 'mainnet', label: 'Mainnet' },
]

export function ChainModeSwitch() {
  const { mode, setMode } = useChainModeStore()
  const toast = useToast()
  const modes = allModes.filter((m) => m.value !== 'local' || isLocalHost())

  return (
    <div
      role="tablist"
      aria-label="Network mode"
      className="flex h-9 items-center gap-0.5 rounded-full border border-border bg-bg p-0.5"
    >
      {modes.map((m) => {
        const active = mode === m.value
        return (
          <button
            key={m.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => {
              if (m.value === 'mainnet') {
                toast.push({ title: 'Mainnet not supported yet', description: 'Please use Local or Testnet.', variant: 'error' })
                return
              }
              setMode(m.value)
            }}
            className={cn(
              'h-full rounded-full px-3 text-sm transition-colors',
              active
                ? 'bg-accent text-white'
                : 'text-text hover:text-text-h',
            )}
          >
            {m.label}
          </button>
        )
      })}
    </div>
  )
}
