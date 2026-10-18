import { validateWebhookDestination, type WebhookAddressResolver } from "./webhook-security.js";

/** Resolve once, reject every non-public answer, then connect only to the returned IP.
 * RTMPS is terminated by Node TLS with the original hostname and certificate checks. */
export async function resolveEgressDestination(endpoint: string, resolve?: WebhookAddressResolver) {
  const url = new URL(endpoint);
  const port = Number(url.port || (url.protocol === "rtmps:" ? 443 : 1935));
  if (
    !["rtmp:", "rtmps:"].includes(url.protocol) ||
    ![1935, 1936, 443].includes(port) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/[A-Za-z0-9_/-]{1,200}$/u.test(url.pathname)
  )
    throw new Error("DESTINATION_ADDRESS_REJECTED");
  const checked = await validateWebhookDestination(`https://${url.hostname}/`, resolve);
  return {
    hostname: checked.hostname,
    address: checked.address.address,
    family: checked.address.family,
    port,
    secure: url.protocol === "rtmps:",
    path: url.pathname,
  };
}
