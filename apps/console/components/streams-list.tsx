"use client";

import { LoadingSkeleton } from "@/ui/skeleton";
import { AnimatedValue } from "@/ui/sliding-number";

import Link from "next/link";
import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { streamOverviewPath, streamStatusLabel, streamTypeLabel } from "@/lib/streams";
import type { Page, Stream } from "@/lib/stream-types";
import { useStreams } from "./streams-provider";
import { useRooms } from "./rooms-provider";
import { useWorkspaceResource } from "./use-workspace-resource";
import { useRealtimeRefresh } from "./use-realtime-refresh";
import { useNotifications } from "./notification-provider";
import { CreateStreamDialog } from "./create-stream-dialog";
import { CreateClipDialog } from "./create-clip-dialog";
import { StreamAssets } from "./stream-assets";
import { StreamSchedules } from "./stream-schedules";
import { Button } from "@/ui/button";
import { Icon } from "@/ui/icon";
import { StatusPill } from "@/ui/status-pill";
import { FormFeedback } from "@/ui/auth-fields";
import { DeveloperEnvironment } from "@/ui/developer-fields";

type Tab = "streams" | "recordings" | "clips" | "scheduled";
const tabs: { value: Tab; label: string }[] = [{ value: "streams", label: "Streams" }, { value: "recordings", label: "Recordings" }, { value: "clips", label: "Clips" }, { value: "scheduled", label: "Scheduled" }];
export function StreamsList() {
  const state = useStreams();
  const rooms = useRooms();
  return <section className="content streams-content" aria-label="Streams library">
    <DeveloperEnvironment environments={rooms.environments} value={state.environmentId} onChange={rooms.setEnvironmentId} disabled={!state.ready} />
    {state.ready ? <StreamsLibrary key={state.scope} /> : <><FormFeedback error={state.error} /><LoadingSkeleton rows={3} label="Loading data" />{state.error && <Button onClick={() => void rooms.refresh().catch(() => {})}>Try again</Button>}</>}
  </section>;
}
function StreamsLibrary() {
  const state = useStreams(), { notify } = useNotifications(), router = useRouter();
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<Tab>(() => tabs.find(item => item.value === searchParams.get("tab"))?.value ?? "streams");
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false), [clipping, setClipping] = useState(false);
  const [cursors, setCursors] = useState<string[]>([""]);
  const cursor = cursors[cursors.length - 1];
  const resource = useWorkspaceResource<Page<Stream>>(tab === "streams" ? state.path("streams", { limit: "30", ...(cursor ? { cursor } : {}) }) : null);
  useRealtimeRefresh(resource.refresh, tab === "streams" && !creating && !clipping);
  const query = search.trim().toLowerCase();
  const streams = resource.data?.data.filter(stream => `${stream.name} ${stream.id} ${streamTypeLabel(stream.source.kind)} ${stream.status}`.toLowerCase().includes(query)) ?? [];
  const label = tabs.find(item => item.value === tab)!.label;
  return <>
    <div className="segmented-control report-range media-library-tabs" role="group" aria-label="Stream library">{tabs.map(item => <button type="button" key={item.value} className={tab === item.value ? "segment-active" : ""} aria-pressed={tab === item.value} onClick={() => { setTab(item.value); setSearch(""); }}>{item.label}</button>)}</div>
    <div className="search-field streams-search"><Icon name="search" size={18.1125} /><input className="input" type="search" placeholder={`Search ${label.toLowerCase()} on this page`} aria-label={`Search ${label.toLowerCase()}`} value={search} onChange={event => setSearch(event.target.value)} /></div>
    <div className="rooms-list-heading"><h2>Your {label}</h2>{tab === "streams" && resource.data && <span><AnimatedValue value={resource.data.data.length} />{resource.data.nextCursor ? "+" : ""} on this page</span>}</div>
    {tab === "streams" ? <>
      <FormFeedback error={resource.error} />
      {resource.error && <Button onClick={() => void resource.refresh().catch(() => {})}>Try again</Button>}
      {!resource.data && resource.loading ? <LoadingSkeleton rows={3} label="Loading data" /> : resource.data && (streams.length ? <div className="room-list">{streams.map(stream => <Link key={stream.id} href={streamOverviewPath(stream.id)} className="panel room-card stream-card"><span className="room-symbol"><Icon name={stream.source.kind === "room" ? "rooms" : "streams"} size={23} /></span><span className="room-card-copy"><span className="room-card-name">{stream.name}</span><span className="room-card-meta">{streamTypeLabel(stream.source.kind)}</span></span><StatusPill active={false}>{streamStatusLabel(stream.status)}</StatusPill><Icon name="chevronRight" size={17.325} className="row-chevron" /></Link>)}</div> : <div className="empty-state streams-empty"><div className="empty-state-icon"><Icon name="streams" size={32} /></div><h2>{query ? "No streams found on this page" : "Your next broadcast starts here"}</h2><p>{query ? "Try another name or move to another page." : "Create a WHIP, RTMP, or Room stream."}</p></div>)}
      <div className="account-pagination"><button type="button" disabled={cursors.length === 1 || resource.loading} onClick={() => setCursors(value => value.slice(0, -1))}>Previous</button><span>Page <AnimatedValue value={cursors.length} /></span><button type="button" disabled={!resource.data?.nextCursor || resource.loading} onClick={() => setCursors(value => [...value, resource.data!.nextCursor!])}>Next</button></div>
      {state.canManage && <Button icon="plus" className="create-room-button" onClick={() => setCreating(true)} disabled={!resource.data}>Create Stream</Button>}
    </> : tab === "scheduled" ? <StreamSchedules query={search} /> : <><StreamAssets kind={tab === "recordings" ? "recording" : "clip"} query={search} onClipCreated={() => setTab("clips")} />{tab === "clips" && state.canManage && <Button icon="plus" className="create-room-button" onClick={() => setClipping(true)}>Create Clip</Button>}</>}
    {!state.canManage && <p className="account-section-note">Only organization owners and admins can change streaming settings.</p>}
    <CreateStreamDialog open={creating} onClose={() => setCreating(false)} onCreated={stream => { notify("Stream created"); router.push(streamOverviewPath(stream.id)); }} />
    <CreateClipDialog open={clipping} onClose={() => setClipping(false)} onCreated={() => { notify("Clip queued"); setTab("clips"); }} />
  </>;
}
