'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { LoaderCircle } from 'lucide-react'
import { Logo } from '@/components/brand/logo'
import { AuthErrorMessage } from '@/components/auth/auth-error-message'
import { OAuthButtons } from '@/components/auth/oauth-buttons'
import { PasswordInput } from '@/components/auth/password-input'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { authClient } from '@/lib/auth-client'
import { toAuthError, validateSignUpCredentials, type AuthError } from '@relayrtc/auth'

export function SignupForm({ callbackURL, errorCallbackURL, loginHref }: { callbackURL: string; errorCallbackURL: string; loginHref: string }) {
  const router = useRouter()
  const [error, setError] = useState<AuthError | null>(null)
  const [pending, setPending] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    const form = new FormData(event.currentTarget)
    const validation = validateSignUpCredentials({ name: form.get('name'), email: form.get('email'), password: form.get('password') })
    if (!validation.success) {
      setError(validation.error)
      return
    }
    setPending(true)
    const result = await authClient.signUp.email(validation.data)
    if (result.error) {
      setError(toAuthError(result.error))
      setPending(false)
      return
    }
    router.replace(result.data?.token ? callbackURL : `/auth/verify-email?email=${encodeURIComponent(validation.data.email)}&redirect=${encodeURIComponent(callbackURL)}`)
    router.refresh()
  }

  return (
    <div className="w-full max-w-sm">
      <Logo className="mb-10" />
      <h1 className="text-balance text-3xl font-normal tracking-tight">Create your account</h1>
      <p className="mt-2 text-pretty text-muted-foreground">Start building realtime experiences with RelayRTC.</p>
      <div className="mt-8 grid gap-5">
        <OAuthButtons callbackURL={callbackURL} errorCallbackURL={errorCallbackURL} onError={setError} />
        <div className="flex items-center gap-3"><Separator className="flex-1" /><span className="text-xs text-muted-foreground">OR CONTINUE WITH EMAIL</span><Separator className="flex-1" /></div>
        <form onSubmit={submit} className="grid gap-5" noValidate>
          <AuthErrorMessage error={error} />
          <div className="grid gap-2"><Label htmlFor="name">Name</Label><Input id="name" name="name" autoComplete="name" placeholder="Your name" className="h-11 rounded-xl px-3.5" maxLength={120} required /></div>
          <div className="grid gap-2"><Label htmlFor="email">Email</Label><Input id="email" name="email" type="email" autoComplete="email" placeholder="you@company.com" className="h-11 rounded-xl px-3.5" required /></div>
          <div className="grid gap-2"><Label htmlFor="password">Password</Label><PasswordInput id="password" name="password" autoComplete="new-password" minLength={8} maxLength={128} required /><p className="text-xs text-muted-foreground">Use 8 to 128 characters.</p></div>
          <Button type="submit" size="lg" disabled={pending} className="h-11 rounded-full text-sm">{pending ? <LoaderCircle className="animate-spin" /> : null}{pending ? 'Please wait…' : 'Create account'}</Button>
        </form>
      </div>
      <p className="mt-6 text-center text-sm text-muted-foreground">Already have an account? <Link href={loginHref} className="font-medium text-foreground underline-offset-4 hover:underline">Sign in</Link></p>
    </div>
  )
}
