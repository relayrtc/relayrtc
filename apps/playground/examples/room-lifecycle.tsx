'use client'

import {useState} from 'react'
import {useRoomAccess,useRoomLifecycle,useRoomInvitations} from '@relayrtc/react'
import type {RoomInvitationBackend} from '@relayrtc/client'

export function RoomLifecycleExample({backend,endRoom}:{backend:RoomInvitationBackend;endRoom:()=>Promise<unknown>}) {
  const {capabilities}=useRoomAccess()
  const {policy,remainingSeconds,update,get}=useRoomLifecycle()
  const invites=useRoomInvitations(backend)
  const [pending,setPending]=useState(false)
  const [error,setError]=useState('')
  const [secret,setSecret]=useState('')
  const [name,setName]=useState('')
  const [redemptionId,setRedemptionId]=useState('')
  const [token,setToken]=useState('')
  const [invitationId,setInvitationId]=useState('')
  const canManage=capabilities?.role==='host'||capabilities?.role==='moderator'
  const run=async(task:()=>Promise<unknown>)=>{
    setPending(true);setError('')
    try{await task()}catch(cause){setError(cause instanceof Error?cause.message:'Room action failed')}finally{setPending(false)}
  }
  return <section aria-label="Room admission example">
    <p role="status">{policy?.locked?'Locked':'Unlocked'} · {remainingSeconds===null?'No deadline':`${remainingSeconds} seconds remaining`}</p>
    <button disabled={pending} onClick={()=>void run(get)}>Reload policy</button>
    <button disabled={pending||!policy||!canManage} onClick={()=>void run(async()=>{
      if(policy)await update({version:policy.version,locked:!policy.locked,endsAt:policy.endsAt})
    })}>Toggle lock</button>
    <button disabled={pending||!policy||!canManage} onClick={()=>void run(async()=>{
      if(policy)await update({version:policy.version,locked:policy.locked,endsAt:new Date(Date.now()+600_000).toISOString()})
    })}>Set ten-minute deadline</button>
    <button disabled={pending||!policy||!canManage} onClick={()=>void run(async()=>{
      if(policy)await update({version:policy.version,locked:policy.locked,endsAt:null})
    })}>Remove deadline</button>
    <button disabled={pending||!canManage} onClick={()=>void run(endRoom)}>End room through application backend</button>
    <button disabled={pending||invites.pending||!canManage} onClick={()=>void run(async()=>{
      const created=await invites.create({expiresAt:new Date(Date.now()+900_000).toISOString(),maxUses:1,identity:null,permissions:['room:join','audio:publish']})
      setSecret(created.secret);setInvitationId(created.invitation.id);setRedemptionId('');setToken('')
    })}>Create one-use audio invitation</button>
    <button disabled={pending||invites.pending||!canManage||!invitationId} onClick={()=>void run(async()=>{
      await invites.revoke(invitationId);setSecret('');setInvitationId('');setRedemptionId('');setToken('')
    })}>Revoke created invitation</button>
    <form onSubmit={event=>{event.preventDefault();void run(async()=>{
      const id=redemptionId||crypto.randomUUID();setRedemptionId(id)
      const grant=await invites.redeem({secret,redemptionId:id,participantName:name})
      setToken(grant.token)
    })}}>
      <label>Invitation secret<input type="password" autoComplete="off" value={secret} onChange={event=>{setSecret(event.target.value);setRedemptionId('');setToken('')}} required/></label>
      <label>Participant name<input value={name} onChange={event=>{setName(event.target.value);setRedemptionId('');setToken('')}} required maxLength={120}/></label>
      <button disabled={pending||invites.pending}>Redeem through application backend</button>
      {token&&<label>Participant token<textarea readOnly value={token}/></label>}
    </form>
    {error&&<p role="alert">{error}</p>}
  </section>
}
