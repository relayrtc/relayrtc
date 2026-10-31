'use client'

import { useState } from 'react'
import { useLocalParticipant, useRoomAccess } from '@relayrtc/react'

export function RoomAccessExample({ participantId }: { participantId: string }) {
  const { capabilities, get, update } = useRoomAccess()
  const local = useLocalParticipant()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const canShare = capabilities?.permissions.includes('screen:publish') ?? false
  async function restrictScreen() {
    setPending(true)
    setError('')
    try {
      const access = await get(participantId)
      const ceiling = access.allowedPermissions ?? ['room:join', 'audio:publish', 'video:publish', 'screen:publish', 'messages:send', 'metadata:update'] as const
      await update(participantId, { version: access.version, role: access.role,
        allowedPermissions: ceiling.filter(permission => permission !== 'screen:publish') })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to update access')
    } finally {
      setPending(false)
    }
  }
  return <section aria-label="Room access example">
    <p role="status">Role: {capabilities?.role ?? 'Unavailable'}</p>
    <button disabled={pending || !capabilities?.canManagePermissions} onClick={() => void restrictScreen()}>Revoke target screen sharing</button>
    <button disabled={pending || !local || !canShare} onClick={() => {
      setPending(true)
      setError('')
      void local?.screen.start({ video: true }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Unable to share'))
        .finally(() => setPending(false))
    }}>Share screen</button>
    <button disabled={pending || !local} onClick={() => {
      setPending(true)
      setError('')
      void local?.screen.stop().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Unable to stop sharing'))
        .finally(() => setPending(false))
    }}>Stop sharing</button>
    {error && <p role="alert">{error}</p>}
  </section>
}
