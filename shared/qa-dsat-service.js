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
// Bump this whenever the PapagoAI Copilot Chrome extension ships a new version - tsr-bot
// rejects requests reporting an older client version than it currently expects (confirmed via
// the real 2.6.0 extension build: same base URL/auth/header shape, just this string changed).
const COPILOT_CLIENT_VERSION='2.6.0';
// No timeout used to mean a hung tsr-bot request left the UI (a triage loop, LoftIQ's
// "thinking" state, Suggest Reply) stuck indefinitely with no way out but a page reload -
// 30s is generous for a single chat/messages call but still bounds the wait.
const COPILOT_TIMEOUT_MS=30000;
async function copilotDirectFetch(path,opts={}){
  let r;
  try{r=await fetch(`${COPILOT_BASE}${path}`,{...opts,signal:AbortSignal.timeout(COPILOT_TIMEOUT_MS),headers:{Accept:'application/json','X-Client-Version':COPILOT_CLIENT_VERSION,...(opts.headers||{})}})}
  catch(error){throw new Error(error.name==='TimeoutError'?`Copilot did not respond within ${COPILOT_TIMEOUT_MS/1000}s.`:'Could not reach Copilot from this browser/network.')}
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

// Single home for "is this error really an expired/invalid connection" - every Copilot call
// site across the portal (LoftIQ, DSAT/Service Recovery triage, Suggest Reply, Alignment
// Consistency Check, rephrase/quiz) used to each carry its own copy of this regex.
export function isCopilotAuthError(error){
  return Boolean(error?.copilotCode)||/invalid.*token|token.*invalid|expired|unauthor|401/i.test(error?.message||'');
}

// tsr-bot is flaky in ways one call can't distinguish from a real answer - a dropped
// connection, an unreadable response, or (for callers that pass isBadAnswer) a detectably
// wrong-shaped reply (LoftIQ's meta-response/false-refusal patterns, a DSAT triage reply that
// failed schema validation). One retry on the identical prompt has resolved every flaky case
// observed live during calibration testing. Auth errors are never retried - they need a fresh
// token, not another attempt with the same expired one, so they're thrown immediately for the
// caller's existing reconnect-prompt handling. Bounded to maxRetries extra attempts so a
// stubbornly bad answer still returns (or throws) rather than looping.
export async function copilotChatWithRetry(token,question,{isBadAnswer,maxRetries=1}={}){
  let lastError=null,lastResult=null;
  for(let attempt=0;attempt<=maxRetries;attempt++){
    try{
      const result=await copilotChat(token,question);
      if(!isBadAnswer||!isBadAnswer(copilotResponseText(result)))return result;
      lastResult=result;lastError=null;
    }catch(error){
      if(isCopilotAuthError(error))throw error;
      lastError=error;lastResult=null;
    }
  }
  if(lastError)throw lastError;
  return lastResult;
}
