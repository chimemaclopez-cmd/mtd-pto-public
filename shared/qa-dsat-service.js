import {api} from './ui-utils.js';

export const getDsatReview=(period='')=>api(`/api/qa/dsat-review${period?`?period=${encodeURIComponent(period)}`:''}`);
export const decideDsatTicket=(payload)=>api('/api/qa/dsat-review/decide',{method:'POST',body:JSON.stringify(payload)});
export const requestDsatRefresh=(period='')=>api('/api/qa/dsat-review/refresh',{method:'POST',body:JSON.stringify({period})});
export const getQaCoachingHistory=(employeeEmail)=>api(`/api/qa/coaching-history?employeeEmail=${encodeURIComponent(employeeEmail)}`);
export const saveDsatAnalysis=(ticketId,period,analysis)=>api('/api/qa/dsat-review/save-analysis',{method:'POST',body:JSON.stringify({ticketId,period,analysis})});
export const getCopilotStatus=()=>api('/api/admin/copilot/status');
export const saveCopilotConnection=(email,token)=>api('/api/admin/copilot/save-connection',{method:'POST',body:JSON.stringify({email,token})});
export const disconnectCopilot=()=>api('/api/admin/copilot/disconnect',{method:'POST',body:'{}'});

// tsr-bot ("PapagoAI Copilot") is only reachable from Lofty's own network - calls from this
// server (Render, a public host) get a bare 500 from its openresty front door. So auth
// (send-code/verify) and the actual chat call happen directly from whichever browser is doing
// them, same as Team_Mac_Daily_Operations_Dashboard.html already does successfully.
const COPILOT_BASE='https://tsr-bot.d.chime.me/api/v1';
const COPILOT_CLIENT_VERSION='2.4.2';
async function copilotDirectFetch(path,opts={}){
  let r;
  try{r=await fetch(`${COPILOT_BASE}${path}`,{...opts,headers:{Accept:'application/json','X-Client-Version':COPILOT_CLIENT_VERSION,...(opts.headers||{})}})}
  catch{throw new Error('Could not reach Copilot from this browser/network.')}
  const raw=await r.text();
  let parsed;
  try{parsed=raw?JSON.parse(raw):{}}
  catch{throw new Error(`Copilot returned an unreadable response (HTTP ${r.status}). ${raw.replace(/\s+/g,' ').trim().slice(0,180)||'(empty)'}`)}
  if(!r.ok)throw new Error(parsed.status?.msg||parsed.message||`Copilot returned HTTP ${r.status}.`);
  // tsr-bot answers with HTTP 200 even on a logical failure (e.g. an invalid/expired token) -
  // the real result is status.code (0 = success), not the HTTP status. Miss this and an
  // expired token silently produces garbage "Unknown" analysis instead of a clear reconnect
  // prompt (confirmed live: /auth/check-token with a bad token returns HTTP 200 with
  // {status:{code:1007,msg:"The token is invalid."}}).
  if(parsed.status && typeof parsed.status.code==='number' && parsed.status.code!==0){
    const err=new Error(parsed.status.msg||`Copilot error ${parsed.status.code}.`);
    err.copilotCode=parsed.status.code;
    throw err;
  }
  return parsed;
}
export const copilotSendCode=(email)=>copilotDirectFetch('/auth/send-code',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email})});
export const copilotVerifyCode=(code)=>copilotDirectFetch(`/auth/login/${encodeURIComponent(code)}`);
export function copilotResponseText(data){
  if(typeof data==='string')return data;
  if(data?.data?.content)return Array.isArray(data.data.content)?data.data.content.map(x=>x.content||x.text||'').join('\n'):String(data.data.content);
  return data?.content||data?.answer||data?.message||JSON.stringify(data);
}
export const copilotChat=(token,question)=>copilotDirectFetch('/chat/messages',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({question,streaming_mode:false})});
