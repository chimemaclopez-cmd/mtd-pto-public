import {api} from './ui-utils.js';

export const PTO_STATUSES=['DRAFT','SUBMITTED','PENDING','PRE_APPROVED','FINAL_APPROVAL_QUEUED','FINAL_APPROVAL_APPLYING','APPROVED','PARTIALLY_APPROVED','DECLINED','CANCELLED','WITHDRAWN'];
export const PTO_STATUS_LABELS={DRAFT:'Draft',SUBMITTED:'Submitted',PENDING:'Pending Team Lead Review',PRE_APPROVED:'Pre-Approved · Awaiting Final Approval',FINAL_APPROVAL_QUEUED:'Final Approval Queued',FINAL_APPROVAL_APPLYING:'Applying Final Approval',APPROVED:'Approved',PARTIALLY_APPROVED:'Partially Approved',DECLINED:'Declined',CANCELLED:'Cancelled',WITHDRAWN:'Withdrawn'};
export const loadPtoRequests=(filters={})=>{const query=new URLSearchParams(Object.entries(filters).filter(([,value])=>value));return api(`/api/pto/requests${query.size?`?${query}`:''}`)};
export const loadTeamPtoRequests=()=>api('/api/pto/team-requests');
export const createPtoRequest=request=>api('/api/pto/requests',{method:'POST',body:JSON.stringify(request)});
export const loadPtoRequest=requestId=>api(`/api/pto/requests/${encodeURIComponent(requestId)}`);
export const updatePtoRequest=(requestId,request)=>api(`/api/pto/requests/${encodeURIComponent(requestId)}`,{method:'PUT',body:JSON.stringify(request)});
export const ptoAction=(requestId,action,payload={})=>api(`/api/pto/requests/${encodeURIComponent(requestId)}/${action}`,{method:'POST',body:JSON.stringify(payload)});
export const deletePtoRequest=(requestId,payload={})=>api(`/api/pto/requests/${encodeURIComponent(requestId)}`,{method:'DELETE',body:JSON.stringify(payload)});
export const loadPtoForecast=params=>{const query=new URLSearchParams(Object.entries(params).filter(([,value])=>value!=null&&value!==''));return api(`/api/pto/forecast?${query}`)};
export const loadPtoConflicts=params=>{const query=new URLSearchParams(Object.entries(params).filter(([,value])=>value));return api(`/api/pto/conflicts?${query}`)};
export const loadPtoAudit=(requestId='')=>api(`/api/pto/audit${requestId?`?requestId=${encodeURIComponent(requestId)}`:''}`);
export const loadPtoSettings=()=>api('/api/pto/settings');
export const savePtoSettings=settings=>api('/api/pto/settings',{method:'PUT',body:JSON.stringify(settings)});
