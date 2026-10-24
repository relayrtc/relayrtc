import { selectionStorageKey } from "./workspace-api";

export function clearAccountStorage(userId: string) {
  try {
    localStorage.removeItem(selectionStorageKey(userId));
  } catch { /* Account deletion still succeeds if local storage is unavailable. */ }
}
