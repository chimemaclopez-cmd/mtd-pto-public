import {api} from './ui-utils.js';

export const SCHEDULE_REQUEST_STATUSES=['DRAFT','SUBMITTED','PENDING','APPROVED','DECLINED','CANCELLED','WITHDRAWN'];
export const SCHEDULE_REQUEST_STATUS_LABELS={DRAFT:'Draft',SUBMITTED:'Submitted',PENDING:'Pending',APPROVED:'Approved',DECLINED:'Declined',CANCELLED:'Cancelled',WITHDRAWN:'Withdrawn'};
export const loadMyScheduleRequests=(filters={})=>{const query=new URLSearchParams(Object.entries(filters).filter(([,value])=>value));return api(`/api/my/schedule-requests${query.size?`?${query}`:''}`)};
export const createScheduleRequest=request=>api('/api/my/schedule-requests',{method:'POST',body:JSON.stringify(request)});
export const loadScheduleRequest=requestId=>api(`/api/my/schedule-requests/${encodeURIComponent(requestId)}`);
export const updateScheduleRequest=(requestId,request)=>api(`/api/my/schedule-requests/${encodeURIComponent(requestId)}`,{method:'PUT',body:JSON.stringify(request)});
export const scheduleRequestAction=(requestId,action,payload={})=>api(`/api/my/schedule-requests/${encodeURIComponent(requestId)}/${action}`,{method:'POST',body:JSON.stringify(payload)});
