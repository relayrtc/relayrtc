import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Writes local bind files without starting services or applying migrations.
export async function prepareStreaming(root, environment) {
  const credentials = [
    ["STREAMING_WORKER_KEY", "worker-key"],
    ["STREAMING_GATEWAY_KEY", "gateway-key"],
  ].map(([variable, file]) => {
    const value = environment[variable];
    if (!value || !/^[A-Za-z0-9_-]{32,128}$/u.test(value))
      throw new Error(`Set ${variable} to a 32..128 character base64url secret`);
    return [file, value];
  });
  const directory = resolve(root, ".streaming");
  await mkdir(resolve(directory, "certs"), { recursive: true, mode: 0o700 });
  for (const [file, value] of credentials)
    await writeFile(resolve(directory, file), value, { mode: 0o644 });
}
// Directory isolation protects these readable bind mounts. Windows users should
// restrict the directory ACL to their account and Docker before deployment.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareStreaming(fileURLToPath(new URL("..", import.meta.url)), process.env);
  process.stdout.write(
    "Prepared private monitoring files in .streaming. No services were started.\n",
  );
}
