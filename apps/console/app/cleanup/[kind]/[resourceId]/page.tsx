import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { AlertCircle, ArrowLeft } from 'lucide-react'
import { getDeletionOperationAction } from '@/actions/resource-deletion'
import { DeletionProgress } from '@/components/settings/deletion-progress'
import { PageHeader } from '@/components/page/page-header'
import { Panel } from '@/components/page/panel'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { requireConsoleSession } from '@/lib/console-data'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Deletion progress' }

export default async function CleanupPage({ params }: { params: Promise<{ kind: string; resourceId: string }> }) {
  const { kind, resourceId } = await params
  if (kind !== 'project' && kind !== 'organization' && kind !== 'environment') notFound()
  await requireConsoleSession('/')
  const result = await getDeletionOperationAction({ kind, resourceId })
  if ('code' in result && result.code === 'DELETION_ACCESS_DENIED') redirect('/')
  if (!result.data && !result.error) notFound()
  return <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-6 px-4 py-12">
    <PageHeader title={`${kind[0]?.toUpperCase()}${kind.slice(1)} deletion`} description="This resource is being removed. Its normal pages and actions are unavailable while cleanup finishes." />
    <Panel className="border">{result.error ? <Alert variant="destructive"><AlertCircle /><AlertDescription>{result.error}</AlertDescription></Alert> : <DeletionProgress kind={kind} resourceId={resourceId} destination="/" initialOperation={result.data} />}</Panel>
    <Button nativeButton={false} variant="outline" className="w-fit" render={<Link href="/" />}><ArrowLeft />Back to console</Button>
  </main>
}
