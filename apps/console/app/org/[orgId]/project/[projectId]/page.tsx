import { ArrowUpRight, Plus } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { PageHeader } from '@/components/page/page-header'
import { Panel } from '@/components/page/panel'
import { MiniBars, StatCard } from '@/components/page/stat-card'
import { QuickstartTabs } from '@/components/project/quickstart-tabs'
import { buttonVariants } from '@/components/ui/button'
import { formatNumber } from '@/lib/format'
import { requireProject } from '@/lib/console-data'
import { routes } from '@/lib/routes'
import { cn } from '@/lib/utils'
import { getProjectAnalytics, getOrganizationQuota } from '@/lib/reporting/client'

export const dynamic = 'force-dynamic'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ orgId: string; projectId: string }>
}): Promise<Metadata> {
  const { orgId, projectId } = await params
  const data = await requireProject(orgId, projectId)

  return {
    title: data.project.name,
  }
}

export default async function ProjectOverviewPage({
  params,
}: {
  params: Promise<{ orgId: string; projectId: string }>
}) {
  const { orgId, projectId } = await params
  await requireProject(orgId, projectId)

  const [analytics, quota] = await Promise.all([getProjectAnalytics(projectId, '7d'), getOrganizationQuota(orgId)])


  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Overview"
        description="Usage, connection health and activity across your project."
        actions={
          <Link
            href={`${routes.projectPage(orgId, projectId, 'api-keys')}?new=1`}
            className={cn(
              buttonVariants({ size: 'lg' }),
              'rounded-full',
            )}
          >
            <Plus />
            Create API key
          </Link>
        }
      />

      <Panel>
        <h2 className="text-base font-medium">Organization quota</h2>
        <p className="mt-1 text-sm text-muted-foreground">{quota.status === 'unconfigured' ? 'No usage limits configured.' : 'Quota unavailable.'}</p>
        <Link href={`/org/${orgId}/usage`} className="mt-3 inline-block text-sm underline">Organization usage</Link>
      </Panel>
      {(analytics.dataQuality.sessionHistory === 'partial' || analytics.dataQuality.messageHistory === 'partial') && <p role="status" className="text-sm text-muted-foreground">Some historical activity is unavailable. These totals may be incomplete.</p>}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Peak participants" value={formatNumber(analytics.summary.peakConcurrent)} hint="7d">
          {analytics.summary.peakConcurrent > 0 && <MiniBars label="Peak participants by UTC day" values={analytics.traffic.map(bucket => bucket.participants)} />}
        </StatCard>
        <StatCard label="Participant minutes" value={formatNumber(analytics.summary.participantSeconds / 60)} hint="7d">
          {analytics.summary.participantSeconds > 0 && <MiniBars label="Participant minutes by UTC day" values={analytics.traffic.map(bucket => bucket.participantSeconds / 60)} />}
        </StatCard>
        <StatCard label="Sessions" value={formatNumber(analytics.summary.totalSessions)} hint="7d">
          {analytics.summary.totalSessions > 0 && <MiniBars label="Sessions overlapping each UTC day" values={analytics.traffic.map(bucket => bucket.sessions)} />}
        </StatCard>
        <StatCard label="Connection success" value={analytics.summary.totalSessions === 0 ? 'No sessions' : `${analytics.summary.connectionSuccessRate.toFixed(1)}%`} hint="7d" />
      </div>

      <details className="rounded-xl border p-5">
        <summary className="cursor-pointer text-sm font-medium">Integration quickstart</summary>
      <Panel className="mt-4 flex flex-col gap-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-medium">Start building</h2>

            <p className="mt-0.5 text-sm text-muted-foreground">
              Create an API key, mint a token on your server, then join a room
              from any client.
            </p>
          </div>

          <Link
            href={routes.projectPage(orgId, projectId, 'api-keys')}
            className={cn(
              buttonVariants({ variant: 'outline', size: 'sm' }),
              'shrink-0 rounded-full',
            )}
          >
            API keys
            <ArrowUpRight />
          </Link>
        </div>

        <QuickstartTabs />
      </Panel>
      </details>
    </div>
  )
}