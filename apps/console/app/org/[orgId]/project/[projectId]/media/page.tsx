import ActivityPage from "../activity/page";
export const dynamic = "force-dynamic";
export const metadata = { title: "Media" };
export default async function Page(props: Parameters<typeof ActivityPage>[0]) {
  const query = await props.searchParams;
  return ActivityPage({ ...props, searchParams: Promise.resolve({ ...query, view: "assets" }) });
}
