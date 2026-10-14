import { AccountRecoveryPage } from '@/components/auth/account-recovery-page'
export const metadata = { title: 'Verify sign-in', referrer: 'no-referrer' }
export default function Page() { return <AccountRecoveryPage mode="mfa" /> }
