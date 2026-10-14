'use client'

import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { Logo } from '@/components/brand/logo'
import { PasswordInput } from '@/components/auth/password-input'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { accountRequest } from '@/lib/account-api'
import { readAuthQuery } from '@/lib/auth-query'

export function AccountRecoveryForm({ mode }: { mode: 'forgot' | 'reset' | 'mfa' }) {
  const router = useRouter()
  const query = useSearchParams()
  const [error, setError] = useState(mode === 'reset' && (!query.get('token') || query.get('error')) ? 'This recovery link is invalid or expired. Request a new one.' : '')
  const [notice, setNotice] = useState('')
  const [pending, setPending] = useState(false)
  const [backup, setBackup] = useState(false)
  const [otpReset, setOtpReset] = useState(false)
  const [sent, setSent] = useState(false)
  const [email, setEmail] = useState(query.get('email') ?? '')
  const token = query.get('token')
  const title = mode === 'forgot' ? 'Recover your account' : mode === 'reset' ? 'Reset your password' : 'Verify your sign-in'
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    setPending(true); setError(''); setNotice('')
    try {
      if (mode === 'forgot') {
        if (otpReset && sent) {
          if (data.get('password') !== data.get('confirmation')) throw new Error('The new passwords do not match.')
          await accountRequest('/api/auth/email-otp/reset-password', { email, otp: data.get('code'), password: data.get('password') })
          router.replace('/auth/login?password=reset'); router.refresh()
        } else {
          await accountRequest(otpReset ? '/api/auth/email-otp/request-password-reset' : '/api/auth/request-password-reset',
            otpReset ? { email } : { email, redirectTo: `${window.location.origin}/auth/reset-password` })
          setSent(true); setNotice('If an account exists for this address, recovery instructions will arrive shortly. Check your spam folder too.')
        }
      } else if (mode === 'reset') {
        if (!token) throw new Error('This recovery link is missing or invalid. Request a new one.')
        if (data.get('password') !== data.get('confirmation')) throw new Error('The new passwords do not match.')
        await accountRequest('/api/auth/reset-password', { token, newPassword: data.get('password') })
        router.replace('/auth/login?password=reset'); router.refresh()
      } else {
        await accountRequest(backup ? '/api/auth/two-factor/verify-backup-code' : '/api/auth/two-factor/verify-totp', { code: data.get('code'), trustDevice: false })
        const destination = readAuthQuery({ redirect: query.get('redirect') ?? '/auth/continue' }).redirect
        router.replace(destination); router.refresh()
      }
    } catch (error) { setError(error instanceof Error ? error.message : 'Unable to complete this request.') }
    finally { setPending(false) }
  }
  return <div className="w-full max-w-sm">
    <Logo className="mb-10" /><h1 className="text-3xl font-normal tracking-tight">{title}</h1>
    <p className="mt-2 text-sm text-muted-foreground">{mode === 'mfa' ? 'Enter your authenticator code or a saved recovery code.' : mode === 'reset' ? 'Choose a unique password. Your existing sessions will be revoked.' : 'Securely recover or verify your RelayRTC account.'}</p>
    <form onSubmit={submit} className="mt-8 grid gap-5">
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {notice ? <p role="status" className="text-sm text-muted-foreground">{notice}</p> : null}
      {mode === 'forgot' ? <div className="grid gap-2"><Label htmlFor="recovery-email">Email</Label><Input id="recovery-email" name="email" type="email" autoComplete="email" value={email} onChange={(event) => { setEmail(event.target.value); setSent(false) }} required /></div> : null}
      {mode === 'mfa' || (mode === 'forgot' && otpReset && sent) ? <div className="grid gap-2"><Label htmlFor="recovery-code">{backup ? 'Recovery code' : 'Verification code'}</Label><Input id="recovery-code" name="code" autoComplete="one-time-code" inputMode={backup ? 'text' : 'numeric'} maxLength={backup ? 32 : 6} minLength={backup ? 1 : 6} pattern={backup ? undefined : '[0-9]{6}'} required /></div> : null}
      {mode === 'reset' || (mode === 'forgot' && otpReset && sent) ? <><div className="grid gap-2"><Label htmlFor="recovery-password">New password</Label><PasswordInput id="recovery-password" name="password" autoComplete="new-password" minLength={8} maxLength={128} required /></div><div className="grid gap-2"><Label htmlFor="recovery-confirmation">Confirm password</Label><PasswordInput id="recovery-confirmation" name="confirmation" autoComplete="new-password" minLength={8} maxLength={128} required /></div></> : null}
      <Button type="submit" size="lg" disabled={pending || (mode === 'reset' && !token)}>{pending ? 'Please wait…' : mode === 'mfa' ? 'Verify sign-in' : mode === 'reset' || (mode === 'forgot' && otpReset && sent) ? 'Reset password' : 'Send recovery instructions'}</Button>
      {mode === 'mfa' ? <Button type="button" variant="ghost" disabled={pending} onClick={() => setBackup(!backup)}>{backup ? 'Use authenticator code' : 'Use a recovery code'}</Button> : null}
      {mode === 'forgot' ? <Button type="button" variant="ghost" disabled={pending} onClick={() => { setOtpReset(!otpReset); setSent(false); setNotice('') }}>{otpReset ? 'Use a recovery link instead' : 'Use an email code instead'}</Button> : null}
    </form>
    <p className="mt-6 text-center text-sm text-muted-foreground"><Link href="/auth/login" className="underline underline-offset-4">Back to sign in</Link></p>
    {mode === 'reset' ? <p className="mt-3 text-center text-sm"><Link href="/auth/forgot-password" className="underline underline-offset-4">Request a new recovery link</Link></p> : null}
  </div>
}
