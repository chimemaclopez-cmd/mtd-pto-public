import {api} from './ui-utils.js';

export const loadMyServiceRecovery=period=>api(`/api/my/service-recovery${period?`?period=${encodeURIComponent(period)}`:''}`);
export const markServiceRecoveryContacted=(ticketId,employeeEmail,period)=>api('/api/my/service-recovery/contact',{method:'POST',body:JSON.stringify({ticketId,employeeEmail,period})});
export const loadServiceRecoverySummary=period=>api(`/api/team-leads/service-recovery-summary${period?`?period=${encodeURIComponent(period)}`:''}`);
