'use client'

import { useState } from 'react'
import {
  useRoomActivity,
  useActiveSpeakers,
  PushToTalkButton,
  usePushToTalk,
} from '@relayrtc/react'

export function RoomActivityExample() {
  const { snapshot, preferences, configure } = useRoomActivity()
  const { speakers, dominantSpeakerId, state } = useActiveSpeakers()
  const [error, setError] = useState('')
  const update = async (mode: 'auto' | 'away', shareActivity: boolean, shareSpeaking: boolean) => {
    try {
      await configure({ mode, shareActivity, shareSpeaking })
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Activity settings could not be saved')
    }
  }
  return (
    <section aria-label="Room activity example">
      <p>
        Speaker state: {state}. Dominant: {dominantSpeakerId ?? 'None'}
      </p>
      <ul>
        {speakers.map((speaker) => (
          <li key={speaker.participantId}>{speaker.participantId} is speaking</li>
        ))}
      </ul>
      <ul>
        {snapshot?.participants.map((participant) => (
          <li key={participant.participantId}>
            {participant.participantId}: {participant.state}
          </li>
        ))}
      </ul>
      <button
        onClick={() =>
          void update(
            preferences?.mode === 'away' ? 'auto' : 'away',
            preferences?.shareActivity ?? true,
            preferences?.shareSpeaking ?? true,
          )
        }
      >
        Toggle away
      </button>
      <button
        onClick={() =>
          void update(
            preferences?.mode ?? 'auto',
            !(preferences?.shareActivity ?? true),
            preferences?.shareSpeaking ?? true,
          )
        }
      >
        Toggle activity privacy
      </button>
      <button
        onClick={() =>
          void update(
            preferences?.mode ?? 'auto',
            preferences?.shareActivity ?? true,
            !(preferences?.shareSpeaking ?? true),
          )
        }
      >
        Toggle speaking privacy
      </button>
      <PushToTalkButton />
      {error && <p role="alert">{error}</p>}
    </section>
  )
}

export function KeyboardPushToTalkExample() {
  const talk = usePushToTalk({ key: 'Space' })
  return (
    <section aria-label="Keyboard push-to-talk">
      <p>
        Hold Space outside editable controls to speak. Mount this instead of the pointer example so
        only one controller owns the microphone.
      </p>
      <p role="status">{talk.active ? 'Talking' : 'Muted'}</p>
      {talk.error && <p role="alert">{talk.error.message}</p>}
    </section>
  )
}
