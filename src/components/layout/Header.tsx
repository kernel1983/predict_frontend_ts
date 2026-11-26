import { Link } from 'react-router-dom'
import { AccountDropdown } from '@/components/wallet/AccountDropdown'
import { ChainModeSwitch } from '@/components/wallet/ChainModeSwitch'

export function Header() {
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-bg/80 backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between px-6">
        <Link
          to="/"
          className="flex items-center gap-2 text-lg font-semibold tracking-tight text-text-h"
        >
          <span className="flex size-7 items-center justify-center rounded-lg bg-accent text-sm font-bold text-white">
            C
          </span>
          chess
        </Link>
        <div className="flex items-center gap-3">
          <ChainModeSwitch />
          <AccountDropdown />
        </div>
      </div>
    </header>
  )
}