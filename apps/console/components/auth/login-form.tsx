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
import { toAuthError, validateSignInCredentials, type AuthError } from '@relayrtc/auth'

export function LoginForm({ callbackURL, errorCallbackURL, initialError, signUpHref }: {
  callbackURL: string
  errorCallbackURL: string
  initialError: AuthError | null
  signUpHref: string
}) {
  const router = useRouter()
  const [error, setError] = useState<AuthError | null>(initialError)
  const [pending, setPending] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    const form = new FormData(event.currentTarget)
    const validation = validateSignInCredentials({ email: form.get('email'), password: form.get('password') })
    if (!validation.success) {
      setError(validation.error)
      return
    }
    setPending(true)
    const result = await authClient.signIn.email(validation.data)
    if (result.error) {
      if (result.error.code === 'EMAIL_NOT_VERIFIED') {
        router.replace(`/auth/verify-email?email=${encodeURIComponent(validation.data.email)}&redirect=${encodeURIComponent(callbackURL)}`)
        return
      }
      setError(toAuthError(result.error))
      setPending(false)
      return
    }
    if (result.data && 'twoFactorRedirect' in result.data && result.data.twoFactorRedirect) {
      router.replace(`/auth/two-factor?redirect=${encodeURIComponent(callbackURL)}`)
      return
    }
    router.replace(callbackURL)
    router.refresh()
  }

  return (
    <div className="w-full max-w-sm">
      <Logo className="mb-10" />
      <h1 className="text-balance text-3xl font-normal tracking-tight">Welcome back</h1>
      <p className="mt-2 text-pretty text-muted-foreground">Sign in to manage your RelayRTC organizations, projects and infrastructure.</p>
      <div className="mt-8 grid gap-5">
        <OAuthButtons callbackURL={callbackURL} errorCallbackURL={errorCallbackURL} onError={setError} />
        <div className="flex items-center gap-3"><Separator className="flex-1" /><span className="text-xs text-muted-foreground">OR CONTINUE WITH EMAIL</span><Separator className="flex-1" /></div>
        <form onSubmit={submit} className="grid gap-5" noValidate>
          <AuthErrorMessage error={error} />
          <div className="grid gap-2"><Label htmlFor="email">Email</Label><Input id="email" name="email" type="email" autoComplete="email" placeholder="you@company.com" className="h-11 rounded-xl px-3.5" required /></div>
          <div className="grid gap-2"><Label htmlFor="password">Password</Label><PasswordInput id="password" name="password" autoComplete="current-password" minLength={8} maxLength={128} required /></div>
          <Link href="/auth/forgot-password" className="text-right text-sm text-muted-foreground underline underline-offset-4">Forgot password?</Link>
          <Button type="submit" size="lg" disabled={pending} className="h-11 rounded-full text-sm">{pending ? <LoaderCircle className="animate-spin" /> : null}{pending ? 'Please wait…' : 'Sign in'}</Button>
        </form>
      </div>
      <p className="mt-6 text-center text-sm text-muted-foreground">New to RelayRTC? <Link href={signUpHref} className="font-medium text-foreground underline-offset-4 hover:underline">Create an account</Link></p>
    </div>
  )
}
