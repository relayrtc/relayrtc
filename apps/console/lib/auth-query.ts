import { z } from "zod"

export type RawSearchParams = Record<string, string | string[] | undefined>

const trackingKeys = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
] as const

const firstValue = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value

const redirectSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    if (
      !value.startsWith("/") ||
      value.startsWith("//") ||
      value.includes("\\")
    ) {
      return false
    }

    try {
      const url = new URL(value, "https://app.relayrtc.com")
      const pathname = decodeURIComponent(url.pathname)
      // Cleanup belongs to a previous account/resource, never a post-auth destination.
      if (pathname === "/cleanup" || pathname.startsWith("/cleanup/")) return false
      return (
        url.origin ===
        "https://app.relayrtc.com"
      )
    } catch {
      return false
    }
  })
  .catch("/")

const optionalValue = z.string().trim().max(256).optional().catch(undefined)

export interface AuthQuery {
  error: string | undefined
  redirect: string
  tracking: Partial<Record<(typeof trackingKeys)[number], string>>
}

export const readAuthQuery = (raw: RawSearchParams): AuthQuery => {
  const tracking: AuthQuery["tracking"] = {}

  for (const key of trackingKeys) {
    const value = optionalValue.parse(firstValue(raw[key]))
    if (value) tracking[key] = value
  }

  return {
    error: optionalValue.parse(firstValue(raw.error)),
    redirect: redirectSchema.parse(firstValue(raw.redirect) ?? "/"),
    tracking,
  }
}

export const buildPostAuthRedirect = (query: AuthQuery): string => {
  const url = new URL(query.redirect, "https://app.relayrtc.com")

  for (const [key, value] of Object.entries(query.tracking)) {
    if (value && !url.searchParams.has(key)) url.searchParams.set(key, value)
  }

  return `${url.pathname}${url.search}${url.hash}`
}

export const buildAuthHref = (path: string, query: AuthQuery): string => {
  const params = new URLSearchParams()
  params.set("redirect", query.redirect)

  for (const [key, value] of Object.entries(query.tracking)) {
    if (value) params.set(key, value)
  }

  return `${path}?${params.toString()}`
}
