import { Suspense } from 'react'
import { AccountRecoveryForm } from '@/components/auth/account-recovery-form'
import { EmailVerificationForm } from '@/components/auth/email-verification-form'
import { ThemeToggle } from '@/components/shell/theme-toggle'

export function AccountRecoveryPage({ mode }: { mode: 'forgot' | 'reset' | 'verify' | 'mfa' }) {
  return <div className="relative flex min-h-dvh items-center justify-center px-4 py-12">
    <div className="absolute right-4 top-4"><ThemeToggle /></div>
    <Suspense fallback={<p role="status">Loading account recovery…</p>}>{mode === 'verify' ? <EmailVerificationForm /> : <AccountRecoveryForm mode={mode} />}</Suspense>
  </div>
}
