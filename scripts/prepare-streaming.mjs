import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Run from the core repository with Node >=22 --env-file=.env.
// Writes local secret files for Prometheus. It does not start services or migrate data.
const directory = resolve(".streaming");
await mkdir(resolve(directory, "certs"), { recursive: true, mode: 0o700 });
for (const [variable, file] of [
  ["STREAMING_WORKER_KEY", "worker-key"],
  ["STREAMING_GATEWAY_KEY", "gateway-key"],
]) {
  const value = process.env[variable];
  if (!value || !/^[A-Za-z0-9_-]{32,128}$/u.test(value))
    throw new Error(`Set ${variable} to a 32..128 character base64url secret`);
  await writeFile(resolve(directory, file), value, { mode: 0o644 });
}
// Directory isolation protects these readable bind mounts. Windows users should
// restrict the directory ACL to their account and Docker before deployment.
process.stdout.write(
  "Prepared private monitoring files in .streaming. No services were started.\n",
);
