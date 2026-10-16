import { webhookConfigurationSchema, revealedWebhookConfigurationSchema, webhookEventTypeSchema } from '@relayrtc/validation'
import { z } from 'zod'

export type WebhookConfiguration = z.infer<typeof webhookConfigurationSchema>
export type RevealedWebhookConfiguration = z.infer<typeof revealedWebhookConfigurationSchema>
export type WebhookEventType = z.infer<typeof webhookEventTypeSchema>
export interface WebhookError { readonly code: string; readonly description: string }
export type WebhookResult<T> = { data: T; error: null } | { data: null; error: WebhookError }
export const unavailableWebhookError: WebhookError = {
  code: 'WEBHOOKS_UNAVAILABLE',
  description: 'Webhooks are temporarily unavailable. Please try again.',
}
export const eventGroups: readonly { label: string; events: readonly { value: WebhookEventType; label: string }[] }[] = [
  { label: 'Streams', events: [
    { value: 'stream.created', label: 'Stream created' },
    { value: 'stream.starting', label: 'Source starting' },
    { value: 'stream.live', label: 'Source live' },
    { value: 'stream.reconnecting', label: 'Source reconnecting' },
    { value: 'stream.ended', label: 'Source ended' },
    { value: 'stream.failed', label: 'Source failed' },
  ] },
  { label: 'Rooms', events: [
    { value: 'room.created', label: 'Room created' },
    { value: 'room.started', label: 'Room started' },
    { value: 'room.ended', label: 'Room ended' },
  ] },
  { label: 'Participants', events: [
    { value: 'participant.joined', label: 'Participant joined' },
    { value: 'participant.left', label: 'Participant left' },
    { value: 'participant.reconnected', label: 'Participant reconnected' },
  ] },
  { label: 'Tracks', events: [
    { value: 'track.published', label: 'Track published' },
    { value: 'track.unpublished', label: 'Track unpublished' },
  ] },
  { label: 'Connections', events: [
    { value: 'connection.degraded', label: 'Connection degraded' },
    { value: 'connection.recovered', label: 'Connection recovered' },
  ] },
]
