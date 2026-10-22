import ActivityPage from "../activity/page";
export const dynamic = "force-dynamic";
export const metadata = { title: "Realtime" };
export default async function Page(props: Parameters<typeof ActivityPage>[0]) {
  const query = await props.searchParams;
  return ActivityPage({ ...props, searchParams: Promise.resolve({ ...query, view: query.view === "streams" || query.view === "sources" ? query.view : "rooms" }) });
}
