#!/usr/bin/env node
'use strict';
const fs=require('fs');
function duration(v){if(!v)return null; const m=/^\s*(\d+(?:\.\d+)?)\s*(s|m|h|d)\s*$/i.exec(v); if(!m)return NaN; return Number(m[1])*({s:1,m:60,h:3600,d:86400}[m[2].toLowerCase()]);}
const window=duration(process.env.BELT_COMPLETION_STALL_WINDOW);
if(window===null){console.log(JSON.stringify({code:'no_opinion',healthy:true,reason:'BELT_COMPLETION_STALL_WINDOW absent'}));process.exit(0)}
if(!Number.isFinite(window)||window<=0){console.error(JSON.stringify({code:'belt_completion_configuration_invalid',healthy:false}));process.exit(2)}
const input=process.env.BELT_COMPLETION_LIVENESS_INPUT||'-'; let data;
try{data=JSON.parse(input==='-'?fs.readFileSync(0,'utf8'):fs.readFileSync(input,'utf8'))}catch(e){console.error(JSON.stringify({code:'belt_completion_metrics_unavailable',healthy:false,error:e.message}));process.exit(2)}
const now=Date.parse(data.now||new Date().toISOString()); const ws=data.workspace||data.workspace_id||'unknown';
if(!ws||ws==='unknown'){console.error(JSON.stringify({code:'belt_completion_metrics_unavailable',healthy:false,error:'workspace missing'}));process.exit(2)}
const admitted=Number(data.unresolved_admitted_work||0)>0, consumed=Number(data.task_consumption||0)>0, due=Number(data.due_handoff_obligations||0)>0;
const last=data.last_done_at?Date.parse(data.last_done_at):null; const age=last===null?Infinity:(now-last)/1000;
const active=admitted&&(consumed||due), stalled=active&&age>=window;
const statePath=process.env.BELT_COMPLETION_LIVENESS_STATE||'/var/lib/gsp/.local/state/belt-completion-liveness.json'; let state={};
try{state=JSON.parse(fs.readFileSync(statePath,'utf8'))}catch{}
state[ws]={last_done_at:data.last_done_at||null,oldest_pending_obligation:data.oldest_pending_obligation||null,updated_at:new Date(now).toISOString(),incident:stalled};
try{fs.mkdirSync(require('path').dirname(statePath),{recursive:true}); const t=statePath+'.tmp'; fs.writeFileSync(t,JSON.stringify(state)); fs.renameSync(t,statePath)}catch(e){console.error(JSON.stringify({code:'belt_completion_incident_persist_failed',healthy:false,error:e.message}));process.exit(2)}
const out={code:stalled?'belt_completion_stalled':'ok',healthy:!stalled,workspace:ws,last_done_at:data.last_done_at||null,oldest_pending_obligation:data.oldest_pending_obligation||null,task_consumption:Number(data.task_consumption||0),rejected_handoffs:Number(data.rejected_handoffs||0),blocker_reasons:data.blocker_reasons||{}};
console.log(JSON.stringify(out)); process.exit(stalled?1:0);
