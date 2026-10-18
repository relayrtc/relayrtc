import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { listRestreamSourcesAction } from "@/actions/restream";
import { listStreamsAction } from "@/actions/streaming";
import { RestreamSourcesManager } from "@/components/project/restream-sources-manager";
import { requireProject } from "@/lib/console-data";
export const metadata:Metadata={title:'Sources',description:'Manage approved external streaming sources.'};
export const dynamic='force-dynamic';
export default async function SourcesPage({params,searchParams}:{params:Promise<{orgId:string;projectId:string}>;searchParams:Promise<{environmentId?:string}>}){
 const {orgId,projectId}=await params,{environmentId}=await searchParams,data=await requireProject(orgId,projectId),environments=data.environments.filter(e=>e.status==='active');
 const selected=environmentId?environments.find(e=>e.id===environmentId):(environments.find(e=>e.type==='development')??environments[0]);if(environmentId&&!selected)notFound();
 const [sources,streams]=selected?await Promise.all([listRestreamSourcesAction({projectId,environmentId:selected.id}),listStreamsAction({projectId,environmentId:selected.id,limit:100})]):[null,null];
 return <RestreamSourcesManager key={selected?.id??'empty'} projectId={projectId} environmentId={selected?.id??''} environments={environments} canManage={data.canManage} initialRows={sources?.data?.data??[]} initialError={sources?.error?.description??streams?.error?.description??null} streams={streams?.data?.data??[]}/>;
}
