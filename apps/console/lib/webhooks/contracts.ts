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
  {label:'Live guests',events:[{value:'stream.guest.invited',label:'Invited'},{value:'stream.guest.invite_accepted',label:'Invite accepted'},{value:'stream.guest.invite_declined',label:'Invite declined'},{value:'stream.guest.requested',label:'Requested'},{value:'stream.guest.request_approved',label:'Request approved'},{value:'stream.guest.request_rejected',label:'Request rejected'},{value:'stream.guest.joined',label:'Joined'},{value:'stream.guest.left',label:'Left'},{value:'stream.guest.removed',label:'Removed'},{value:'stream.guest.muted',label:'Muted'},{value:'stream.guest.invite_expired',label:'Invite expired'},{value:'stream.guest.invite_cancelled',label:'Invite cancelled'},{value:'stream.guest.grant_revoked',label:'Grant revoked'}]},
  { label: 'DVR', events: [{value:'dvr.enabled',label:'Enabled'},{value:'dvr.window_changed',label:'Window changed'},{value:'dvr.segment_evicted',label:'Segments evicted'},{value:'dvr.disabled',label:'Disabled'}] },
  { label: 'Mixer', events: [
    {value:'mixer.started',label:'Started'},
    {value:'mixer.scene_activated',label:'Scene activated'},
    {value:'mixer.source_lost',label:'Source lost'},
    {value:'mixer.overloaded',label:'Overloaded'},
    {value:'mixer.stopped',label:'Stopped'},
    {value:'mixer.failed',label:'Failed'},
  ] },
  { label: 'Clips', events: [
    {value:'clip.requested',label:'Requested'},
    {value:'clip.rendering',label:'Rendering'},
    {value:'clip.ready',label:'Ready'},
    {value:'clip.failed',label:'Failed'},
    {value:'clip.deleted',label:'Deleted'},
  ] },
  { label: 'External sources', events: [
    { value: 'restream.probing', label: 'Probing' },
    { value: 'restream.source_connected', label: 'Connected' },
    { value: 'restream.source_lost', label: 'Source lost' },
    { value: 'restream.recovering', label: 'Recovering' },
    { value: 'restream.stopped', label: 'Stopped' },
    { value: 'restream.failed', label: 'Failed' },
  ] },
  { label: 'Schedules', events: [
    { value: 'schedule.created', label: 'Created' },
    { value: 'schedule.updated', label: 'Updated' },
    { value: 'schedule.starting', label: 'Starting' },
    { value: 'schedule.started', label: 'Started' },
    { value: 'schedule.missed', label: 'Missed' },
    { value: 'schedule.cancelled', label: 'Cancelled' },
    { value: 'schedule.failed', label: 'Failed' },
    { value: 'schedule.completed', label: 'Completed' },
    { value: 'schedule.reminder', label: 'Reminder' },
  ] },
  { label: 'Recordings', events: [
    { value: 'recording.started', label: 'Started' },
    { value: 'recording.segment_committed', label: 'Segment committed' },
    { value: 'recording.finalizing', label: 'Finalizing' },
    { value: 'recording.ready', label: 'Ready' },
    { value: 'recording.failed', label: 'Failed' },
    { value: 'recording.deleted', label: 'Deleted' },
  ] },
  { label: 'Destinations', events: [
    { value: 'destination.created', label: 'Destination created' },
    { value: 'destination.connected', label: 'Destination connected' },
    { value: 'destination.disconnected', label: 'Destination disconnected' },
    { value: 'destination.retrying', label: 'Destination retrying' },
    { value: 'destination.failed', label: 'Destination failed' },
  ] },
  { label: 'Broadcasts', events: [
    { value: 'broadcast.created', label: 'Broadcast created' },
    { value: 'broadcast.starting', label: 'Broadcast starting' },
    { value: 'broadcast.live', label: 'Broadcast live' },
    { value: 'broadcast.reconnecting', label: 'Broadcast reconnecting' },
    { value: 'broadcast.output_degraded', label: 'Output degraded' },
    { value: 'broadcast.stopped', label: 'Broadcast stopped' },
    { value: 'broadcast.failed', label: 'Broadcast failed' },
  ] },
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
