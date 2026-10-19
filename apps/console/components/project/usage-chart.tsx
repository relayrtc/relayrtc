'use client'

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { Panel } from '@/components/page/panel'
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
import { formatDuration, formatMinutes, formatNumber } from '@/lib/format'

export function UsageChart({ title, total, period, points, compact = false, horizontal = false, description, unit }: {
  title: string
  total: number
  period: string
  points: { label: string; value: number }[]
  compact?: boolean
  horizontal?: boolean
  description?: string
  unit?: 'minutes'
}) {
  return (
    <Panel className="flex flex-col">
      <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
        <span>{title}</span><span>{period}</span>
      </div>
      <p title={unit === 'minutes' ? formatDuration(total * 60) : undefined} className="text-2xl tracking-tight tabular-nums sm:text-[1.75rem]">{unit === 'minutes' ? formatMinutes(total * 60) : formatNumber(total)}</p>
      {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
      <ChartContainer config={{ value: { label: title, color: 'var(--chart-1)' } }} className={compact ? 'mt-3 h-24 w-full' : 'mt-4 h-64 w-full sm:h-72'}>
        <BarChart accessibilityLayer data={points} layout={horizontal ? 'vertical' : 'horizontal'} margin={{ left: 0, right: 0, top: 4 }}>
          {!compact && <CartesianGrid vertical={horizontal} horizontal={!horizontal} />}
          <XAxis dataKey={horizontal ? 'value' : 'label'} type={horizontal ? 'number' : 'category'} hide={compact} tickLine={false} axisLine={false} tickMargin={8} minTickGap={16} />
          {!compact && (horizontal
            ? <YAxis dataKey="label" type="category" width={128} tickLine={false} axisLine={false} tickFormatter={(value: string) => value.length > 18 ? `${value.slice(0, 18)}…` : value} />
            : <YAxis width={44} tickLine={false} axisLine={false} />)}
          <ChartTooltip content={<ChartTooltipContent />} />
          <Bar dataKey="value" fill="var(--color-value)" radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]} {...(horizontal ? { maxBarSize: 28 } : {})} />
        </BarChart>
      </ChartContainer>
    </Panel>
  )
}
