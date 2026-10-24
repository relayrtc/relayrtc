export const realtimeProjectPath = (projectId: string) => `/api/account/realtime/projects/${encodeURIComponent(projectId)}`;
export const roomEnvironmentPath = (projectId: string, environmentId: string) => `${realtimeProjectPath(projectId)}/environments/${encodeURIComponent(environmentId)}`;
export const roomApiPath = (projectId: string, roomId: string) => `${realtimeProjectPath(projectId)}/rooms/${encodeURIComponent(roomId)}`;
export const roomLookupPath = (roomId: string) => `/api/account/realtime/rooms/${encodeURIComponent(roomId)}`;
