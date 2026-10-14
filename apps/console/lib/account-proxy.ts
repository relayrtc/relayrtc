import { reportingOrigin } from '@/lib/reporting/request'

// Transport only. Fastify owns account validation, sessions, credentials,
// delivery and audit policy. Keep one browser origin and host-only cookies.
export async function proxyAccountRequest(request: Request) {
  const incoming = new URL(request.url)
  const path = incoming.pathname
  if (!path.startsWith('/api/auth/') && path !== '/api/account' && !path.startsWith('/api/account/')) {
    return Response.json({ message: 'Invalid account API path' }, { status: 400 })
  }
  const headers = new Headers()
  for (const name of ['cookie', 'origin', 'content-type', 'accept', 'user-agent', 'sec-fetch-site']) {
    const value = request.headers.get(name)
    if (value) headers.set(name, value)
  }
  try {
    const response = await fetch(new URL(`${path}${incoming.search}`, reportingOrigin()), {
      method: request.method, headers, redirect: 'manual', cache: 'no-store',
      signal: AbortSignal.timeout(25000),
      ...(['GET', 'HEAD'].includes(request.method) ? {} : { body: await request.text() }),
    })
    const output = new Headers()
    for (const name of ['content-type', 'location', 'retry-after', 'x-request-id', 'content-disposition']) {
      const value = response.headers.get(name)
      if (value) output.set(name, value)
    }
    for (const cookie of response.headers.getSetCookie()) output.append('set-cookie', cookie)
    output.set('cache-control', 'private, no-store')
    output.set('referrer-policy', 'no-referrer')
    return new Response(response.body, { status: response.status, headers: output })
  } catch {
    return Response.json({ message: 'Account services are temporarily unavailable. Please try again.' }, {
      status: 503, headers: { 'cache-control': 'no-store' },
    })
  }
}
