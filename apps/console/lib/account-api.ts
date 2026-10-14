'use client'

export interface AccountOverview {
  emailVerificationRequired: boolean
  user: { id: string; name: string; email: string; image: string | null; emailVerified: boolean; twoFactorEnabled: boolean }
  accounts: { id: string; providerId: string; accountId: string; createdAt: string }[]
  ownedOrganizations: { id: string; name: string }[]
}
export interface AccountSession {
  id: string; userAgent: string | null; ipAddress: string | null;
  createdAt: string; updatedAt: string; expiresAt: string; current: boolean
}
export class AccountApiError extends Error {
  constructor(message: string, public code?: string, public retryAfter?: number) { super(message) }
}
export async function accountRequest<T = { success: boolean }>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: body === undefined ? { accept: 'application/json' } : { 'content-type': 'application/json', accept: 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(25000),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new AccountApiError(payload?.error?.message ?? payload?.error?.description ?? payload?.message ?? payload?.description ?? 'Unable to complete this request. Please try again.',
      payload?.error?.code ?? payload?.code, Number(response.headers.get('retry-after')) || undefined)
  }
  return payload as T
}
