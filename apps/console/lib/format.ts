export function formatDuration(totalSeconds: number) {
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = Math.floor(totalSeconds % 60)
  const parts: string[] = []
  if (hours) parts.push(`${hours}h`)
  if (minutes || hours) parts.push(`${minutes}m`)
  parts.push(`${seconds}s`)
  return parts.join(' ')
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export function formatBytes(bytes: number, fractionDigits = 0) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const exponent = Math.min(Math.max(0, Math.floor(Math.log(bytes) / Math.log(1000))), BYTE_UNITS.length - 1)
  const value = bytes / 1000 ** exponent
  const digits = exponent === 0 ? 0 : fractionDigits
  return `${Number(value.toFixed(digits))} ${BYTE_UNITS[exponent]}`
}

export function formatMinutes(totalSeconds: number) {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '0 min'
  if (totalSeconds < 60) return '<1 min'
  return `${Math.round(totalSeconds / 60).toLocaleString('en-US')} min`
}

export function formatNumber(value: number) {
  return new Intl.NumberFormat('en-US').format(value)
}

export function randomId(prefix: string, length = 16) {
  const alphabet = 'abcdef0123456789'
  let id = ''
  for (let i = 0; i < length; i += 1) {
    id += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return `${prefix}_${id}`
}

export function randomToken(length: number) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let token = ''
  for (let i = 0; i < length; i += 1) {
    token += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return token
}
