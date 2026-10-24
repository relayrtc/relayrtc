import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

const rawKeyPattern = /^(rk_(?:pk|sk)_[a-z0-9-]+_)([A-Za-z0-9_-]{43})$/u

const environmentMarker = (environmentType: string): string => {
  if (environmentType === "development") return "dev"
  if (environmentType === "production") return "live"
  return environmentType.replace(/[^a-z0-9-]/gu, "-")
}

export const hashApiKey = (rawKey: string): string =>
  createHash("sha256").update(rawKey, "utf8").digest("hex")

export const generateApiKey = (
  type: "publishable" | "secret",
  environmentType: string
): { hashedSecret: string; prefix: string; rawKey: string } => {
  const secret = randomBytes(32).toString("base64url")
  const header = `rk_${type === "publishable" ? "pk" : "sk"}_${environmentMarker(environmentType)}_`
  const rawKey = `${header}${secret}`

  return {
    hashedSecret: hashApiKey(rawKey),
    prefix: `${header}${secret.slice(0, 12)}`,
    rawKey,
  }
}

export const apiKeyPrefixFromRaw = (rawKey: string): string | null => {
  const match = rawKeyPattern.exec(rawKey)
  return match ? `${match[1]}${match[2]?.slice(0, 12)}` : null
}

export const apiKeyHashMatches = (rawKey: string, expectedHash: string): boolean => {
  const actual = Buffer.from(hashApiKey(rawKey), "hex")
  const expected = Buffer.from(expectedHash, "hex")

  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

