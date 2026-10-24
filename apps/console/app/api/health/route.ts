export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ status: "ok", service: "console" }, {
    headers: { "cache-control": "no-store" },
  });
}
