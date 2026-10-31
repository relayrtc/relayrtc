# Playground examples

[The activity example](examples/room-activity.tsx) shows multiple speakers, dominant-speaker availability, activity states, away/privacy preferences and a pointer hold-to-talk button. Its separate keyboard example binds Space outside editable controls. Mount one example at a time so one controller owns the microphone. Both use the existing room provider and the updated browser/React source. No separate application or design system is introduced.

[The room lifecycle example](examples/room-lifecycle.tsx) adds lock, deadline, reload, invitation create/revoke/redeem and room-end controls. Pass a stable `RoomInvitationBackend` object and an `endRoom` callback implemented through your application's authenticated endpoints. Its backend must derive the redemption identity from the verified user session and authorize administration and ending. Keep the same redemption UUID on retries and keep participant tokens private. Mount inside the existing room provider with compatible local browser and React SDK builds. These are source examples, not a running application.

This directory currently contains source examples, not a runnable Playground application. Import [the room access example](examples/room-access.tsx) into a React application using the updated local browser/React SDKs, inside `RelayProvider` and a joined `RelayRoom`.

Pass a target participant ID. Assign your moderator or host through the server/console first. The example displays the local role, revokes the target's screen permission and handles sharing permission errors. It uses native accessible controls so a host application can supply its existing design system.

For host assignment, conflicting edits, permission ceilings, live cleanup timing and audit history, see [the room policy guide](../../../docs/guides/room-roles-and-permissions.mdx).
