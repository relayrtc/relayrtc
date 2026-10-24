export type LegacyConsoleDestination = { organizationId: string; projectId?: string; href: string };

const validId = (id: string | undefined): id is string => Boolean(id && id.length <= 128 && id !== "." && id !== ".." && !/[\\/\u0000-\u001f]/.test(id));

// Keep saved console URLs useful without carrying their old presentation forward.
// The redirect component validates access and selects this exact workspace first.
export function legacyConsoleDestination(organizationId: string, path: string[] = [], search: Record<string, string | string[] | undefined> = {}): LegacyConsoleDestination | null {
  if (!validId(organizationId)) return null;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first && key !== "tab") query.set(key, first);
  }
  const organization = `/organizations/${encodeURIComponent(organizationId)}`;
  const destination = (href: string, projectId?: string): LegacyConsoleDestination => ({ organizationId, projectId, href: `${href}${query.size ? `?${query}` : ""}` });
  if (!path.length) return destination(organization);
  if (path.length === 1 && path[0] === "settings") {
    const tab = Array.isArray(search.tab) ? search.tab[0] : search.tab;
    if (tab === "profile") return destination("/account");
    if (tab === "profile-sessions") return destination("/account/sessions");
    if (tab === "profile-audit-logs") return destination("/account/activity");
    if (tab === "audit-logs") return destination(`${organization}/activity`);
    if (["team", "members", "invitations"].includes(tab ?? "")) {
      if (tab === "invitations") query.set("view", "invitations");
      return destination(`${organization}/members`);
    }
    return destination(organization);
  }
  if (path.length === 1 && path[0] === "usage") { query.set("scope", "organization"); return destination("/usage"); }
  const projectId = path[1];
  if (path[0] !== "project" || !validId(projectId)) return null;
  const project = `/projects/${encodeURIComponent(projectId)}`;
  if (path.length === 2) return destination(project, projectId);
  const section = path[2];
  if (path.length === 3) {
    if (section === "settings") return destination(project, projectId);
    if (["environments", "api-keys", "webhooks"].includes(section)) return destination(`${project}/${section}`, projectId);
    if (["rooms", "realtime", "streams", "analytics", "usage", "activity"].includes(section)) return destination(`/${section}`, projectId);
    if (["recordings", "clips", "schedules"].includes(section)) { query.set("tab", section === "schedules" ? "scheduled" : section); return destination("/streams", projectId); }
    if (section === "media" || section === "sources") { query.set("view", section === "media" ? "assets" : "sources"); return destination("/activity", projectId); }
    if (section === "broadcasts" || section === "mixers") return destination("/streams", projectId);
  }
  if (section === "activity" && path.length === 5 && ["rooms", "streams", "assets", "sources"].includes(path[3]) && validId(path[4])) {
    query.set("projectId", projectId);
    return destination(`/activity/${path[3]}/${encodeURIComponent(path[4])}`, projectId);
  }
  if (section === "streams" && validId(path[3])) return destination(`/streams/${encodeURIComponent(path[3])}/overview`, projectId);
  return null;
}
