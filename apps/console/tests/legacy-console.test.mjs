import assert from "node:assert/strict";
import test from "node:test";
import { legacyConsoleDestination } from "../lib/legacy-console.ts";

test("project links preserve the exact workspace and environment", () => {
  const destination = legacyConsoleDestination("org-one", ["project", "project-two", "rooms"], { environmentId: "env-three" });
  assert.deepEqual(destination, { organizationId: "org-one", projectId: "project-two", href: "/rooms?environmentId=env-three" });
});

test("legacy activity inspection keeps its explicit project scope", () => {
  const destination = legacyConsoleDestination("org", ["project", "project", "activity", "assets", "asset"], { projectId: "wrong", environmentId: "env" });
  const url = new URL(destination.href, "https://console.invalid");
  assert.equal(url.pathname, "/activity/assets/asset");
  assert.equal(url.searchParams.get("projectId"), "project");
  assert.equal(url.searchParams.get("environmentId"), "env");
});

test("media library links select the matching new tab", () => {
  for (const [old, tab] of [["recordings", "recordings"], ["clips", "clips"], ["schedules", "scheduled"]]) {
    assert.equal(legacyConsoleDestination("org", ["project", "project", old]).href, `/streams?tab=${tab}`);
  }
  assert.equal(legacyConsoleDestination("org", ["project", "project", "media"]).href, "/activity?view=assets");
});

test("personal settings and team links keep their destination", () => {
  for (const [tab, href] of [["profile", "/account"], ["profile-sessions", "/account/sessions"], ["profile-audit-logs", "/account/activity"], ["audit-logs", "/organizations/org/activity"], ["members", "/organizations/org/members"], ["invitations", "/organizations/org/members?view=invitations"]]) {
    assert.equal(legacyConsoleDestination("org", ["settings"], { tab }).href, href);
  }
  assert.equal(legacyConsoleDestination("org", ["usage"]).href, "/usage?scope=organization");
});

test("stream links open the new overview", () => {
  assert.equal(legacyConsoleDestination("org", ["project", "project", "streams", "stream", "recordings"]).href, "/streams/stream/overview");
});

test("invalid resources and unknown sections do not redirect", () => {
  for (const id of ["", ".", "..", "bad/id", "bad\\id", "x".repeat(129)]) {
    assert.equal(legacyConsoleDestination(id), null);
    assert.equal(legacyConsoleDestination("org", ["project", id]), null);
  }
  assert.equal(legacyConsoleDestination("org", ["project", "project", "unknown"]), null);
  assert.equal(legacyConsoleDestination("org", ["unknown"]), null);
});
