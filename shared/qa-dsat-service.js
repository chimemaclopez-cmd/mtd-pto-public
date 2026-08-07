import {api} from './ui-utils.js';

export const getDsatReview=(period='')=>api(`/api/qa/dsat-review${period?`?period=${encodeURIComponent(period)}`:''}`);
export const decideDsatTicket=(payload)=>api('/api/qa/dsat-review/decide',{method:'POST',body:JSON.stringify(payload)});
export const requestDsatRefresh=(period='')=>api('/api/qa/dsat-review/refresh',{method:'POST',body:JSON.stringify({period})});
export const getQaCoachingHistory=(employeeEmail)=>api(`/api/qa/coaching-history?employeeEmail=${encodeURIComponent(employeeEmail)}`);
export const analyzeDsatTicket=(ticketId,period)=>api('/api/qa/dsat-review/analyze',{method:'POST',body:JSON.stringify({ticketId,period})});
export const getCopilotStatus=()=>api('/api/admin/copilot/status');
export const sendCopilotCode=(email)=>api('/api/admin/copilot/send-code',{method:'POST',body:JSON.stringify({email})});
export const verifyCopilotCode=(email,code)=>api('/api/admin/copilot/verify',{method:'POST',body:JSON.stringify({email,code})});
export const disconnectCopilot=()=>api('/api/admin/copilot/disconnect',{method:'POST',body:'{}'});
