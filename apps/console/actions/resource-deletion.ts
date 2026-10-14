'use server'

import { getAuthRuntime } from '@/lib/auth-server'
import { getRuntimeOperation } from '@relayrtc/auth'
import { schema } from '@relayrtc/database'
import { and, eq, sql } from 'drizzle-orm'
import { headers } from 'next/headers'
import { z } from 'zod'

const inputSchema = z.object({
  kind: z.enum(['project', 'organization', 'environment']),
  resourceId: z.string().min(1).max(128),
})

export async function getDeletionOperationAction(input: unknown) {
  const parsed = inputSchema.safeParse(input)
  if (!parsed.success) return { data: null, error: 'Invalid deletion request.' }
  try {
    const runtime = getAuthRuntime()
    const session = await runtime.auth.api.getSession({ headers: await headers() })
    if (!session) return { data: null, error: 'Sign in to view deletion progress.' }
    const operationId = `${parsed.data.kind}.delete:${parsed.data.resourceId}`
    const [operation] = await runtime.database.select().from(schema.runtimeOperation)
      .where(eq(schema.runtimeOperation.id, operationId))
    if (!operation) return { data: null, error: null }
    const [membership] = operation.organizationId
      ? await runtime.database.select({ role: schema.member.role }).from(schema.member)
          .where(and(eq(schema.member.organizationId, operation.organizationId), eq(schema.member.userId, session.user.id)))
      : []
    const roles = membership?.role.split(',').map(role => role.trim()) ?? []
    const observers = Array.isArray(operation.payload.observers) ? operation.payload.observers : []
    const authorized = roles.includes('owner') || (parsed.data.kind !== 'organization' && roles.includes('admin'))
      || (operation.status === 'completed' && (operation.payload.requestedBy === session.user.id || observers.includes(session.user.id)))
    if (!authorized) return { data: null, error: 'You do not have access to this deletion.', code: 'DELETION_ACCESS_DENIED' as const }
    if (operation.status !== 'completed') {
      await runtime.database.execute(sql`UPDATE runtime_operation SET payload = payload || jsonb_build_object('requestedBy', ${session.user.id}::text)
        WHERE id = ${operationId} AND NOT (payload ? 'requestedBy')`)
      await runtime.database.execute(sql`UPDATE runtime_operation SET payload = jsonb_set(payload, '{observers}',
        coalesce(payload->'observers', '[]'::jsonb) || jsonb_build_array(${session.user.id}::text))
        WHERE id = ${operationId} AND status <> 'completed'
        AND NOT (coalesce(payload->'observers', '[]'::jsonb) @> jsonb_build_array(${session.user.id}::text))`)
    }
    return { data: await getRuntimeOperation(runtime.database, operationId), error: null }
  } catch {
    return { data: null, error: 'Deletion progress is temporarily unavailable. Cleanup will continue automatically.' }
  }
}
