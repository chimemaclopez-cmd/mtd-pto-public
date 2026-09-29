import {api} from './ui-utils.js';

export const HUDDLE_ACTION_STATUSES=['Open','In Progress','Done'];
export const loadHuddleLog=weekStart=>api(`/api/my/huddle-log${weekStart?`?weekStart=${encodeURIComponent(weekStart)}`:''}`);
export const createHuddleEntry=entry=>api('/api/my/huddle-log',{method:'POST',body:JSON.stringify(entry)});
export const updateHuddleEntry=(huddleId,entry)=>api(`/api/my/huddle-log/${encodeURIComponent(huddleId)}`,{method:'PUT',body:JSON.stringify(entry)});
export const deleteHuddleEntry=huddleId=>api(`/api/my/huddle-log/${encodeURIComponent(huddleId)}`,{method:'DELETE'});
export const setHuddleCoLeadOverride=emails=>api('/api/my/huddle-log/co-leads',{method:'POST',body:JSON.stringify({emails})});
export const sendHuddleReportNow=weekStart=>api('/api/my/huddle-log/send-now',{method:'POST',body:JSON.stringify({weekStart})});
export const previewHuddleReport=weekStart=>api(`/api/my/huddle-log/preview?weekStart=${encodeURIComponent(weekStart)}`);
