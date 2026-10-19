'use client'

import { Download } from 'lucide-react'
import type { OrganizationQuotaResponse, ProjectUsageResponse } from '@relayrtc/validation'
import type { ConsoleEnvironment } from '@/lib/console-types'
import { StatCard } from '@/components/page/stat-card'
import { Button } from '@/components/ui/button'
import { downloadCsv } from '@/lib/csv'
import { ReportingFilters } from './reporting-filters'
import { UsageChart } from './usage-chart'
import { UsageMetrics } from './usage-metrics'
import { ReportingRefresh } from './reporting-refresh'

export function ProjectUsageDashboard({ data, quota, environments, environment }: {
  data: ProjectUsageResponse
  quota: OrganizationQuotaResponse
  environments: readonly ConsoleEnvironment[]
  environment: string
}) {
  const chart = data.buckets.map((bucket) => ({
    ...bucket,
    label: new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...(data.window.range === '24h' ? { hour: '2-digit', minute: '2-digit', hour12: false } as const : { month: 'short', day: 'numeric' } as const) }).format(new Date(bucket.startedAt)),
    value: bucket.participantSeconds / 60,
  }))
  return (
    <div className="flex flex-col gap-6">
      <ReportingRefresh startedAt={data.window.startedAt} endedAt={data.window.endedAt} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ReportingFilters range={data.window.range} environment={environment} environments={environments} />
        <Button variant="ghost" size="icon-sm" aria-label="Download CSV" onClick={() => downloadCsv('project-usage.csv', ['started_at', 'ended_at', 'participant_minutes', 'rooms_created'], chart.map((bucket) => [bucket.startedAt, bucket.endedAt, bucket.value, bucket.roomsCreated]))}><Download /></Button>
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <UsageChart title="Participant minutes" unit="minutes" total={data.summary.participantSeconds / 60} period={data.window.range} points={chart} description="Activity over time · UTC" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
          <UsageChart title="Rooms created" total={data.summary.roomsCreated} period={data.window.range} compact points={chart.map((bucket) => ({ label: bucket.label, value: bucket.roomsCreated }))} />
          <StatCard label="Peak participants" value={data.summary.peakConcurrentParticipants} hint={data.window.range}>
            <p className="mt-2 text-sm text-muted-foreground">{data.summary.peakConcurrentRooms} peak concurrent rooms</p>
          </StatCard>
        </div>
      </div>
      <UsageMetrics summary={data.summary} dataQuality={data.dataQuality} period={data.window.range} />
      <p className="text-xs text-muted-foreground">{quota.status === 'unconfigured' ? 'Organization usage limits are not configured.' : 'Organization quota unavailable.'}</p>
    </div>
  )
}
