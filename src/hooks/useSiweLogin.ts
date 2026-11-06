import { useCallback, useState } from 'react'
import { useSignMessage } from '@/lib/magic'
import { useToast } from '@/components/ui/toast-context'
import { supabase, supabaseConfigured } from '@/lib/supabase'

export function useSiweLogin(_address?: string) {
  const [verifying, setVerifying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const clearError = useCallback(() => setError(null), [])
  const { signMessageAsync } = useSignMessage()
  const toast = useToast()

  const login = useCallback(
    async (addressOrMessage: string): Promise<boolean> => {
      let address = addressOrMessage
      // Check if it's a message (starts with domain) vs address
      if (addressOrMessage.includes('wants you to sign in with your Ethereum account:')) {
        // It's a message, extract address
        const match = addressOrMessage.match(/with your Ethereum account:\n(0x[a-fA-F0-9]{40})/)
        if (!match) {
          setError('Invalid message')
          toast.push({ title: 'Invalid message', variant: 'error' })
          return false
        }
        address = match[1]
      } else if (!addressOrMessage.startsWith('0x')) {
        setError('Invalid address')
        toast.push({ title: 'Invalid address', variant: 'error' })
        return false
      }

      if (!address) return false
      if (!supabaseConfigured() || !supabase) {
        setError('Supabase not configured')
        toast.push({ title: 'Supabase not configured', variant: 'error' })
        return false
      }

      setVerifying(true)
      setError(null)

      try {
        // Get message from siwe-verify
        const { data: challengeData, error: challengeError } = await supabase.functions.invoke('siwe-verify', {
          body: { address },
        })
        if (challengeError) throw challengeError
        const message = (challengeData as any)?.message
        if (!message) throw new Error('Failed to get signing message')

        const signature = await signMessageAsync({ message })

        const { data, error } = await supabase.functions.invoke('siwe-verify', {
          body: { address, message, signature },
        })
        if (error) throw error

        const session = (data as any)?.session
        if (!session?.access_token || !session?.refresh_token) {
          throw new Error('No session returned')
        }

        await supabase.auth.setSession({
          access_token: session.access_token,
          refresh_token: session.refresh_token,
        })

        toast.push({ title: 'Signed in', variant: 'success' })
        return true
      } catch (e: any) {
        const msg = e?.message || 'Login failed'
        setError(msg)
        toast.push({ title: msg, variant: 'error' })
        return false
      } finally {
        setVerifying(false)
      }
    },
    [signMessageAsync, toast],
  )

  return { login, verifying, error, clearError }
}
