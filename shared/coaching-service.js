import {api} from './ui-utils.js';

export const COACHING_STATUS_LABELS={DRAFT:'Draft',SENT:'Awaiting Signature',ACKNOWLEDGED:'Acknowledged'};
export const loadMyTeamCoaching=()=>api('/api/my/team-coaching');
export const createTeamCoaching=record=>api('/api/my/team-coaching',{method:'POST',body:JSON.stringify(record)});
export const loadTeamCoachingRecord=coachingId=>api(`/api/my/team-coaching/${encodeURIComponent(coachingId)}`);
export const updateTeamCoaching=(coachingId,record)=>api(`/api/my/team-coaching/${encodeURIComponent(coachingId)}`,{method:'PUT',body:JSON.stringify(record)});
export const deleteTeamCoaching=coachingId=>api(`/api/my/team-coaching/${encodeURIComponent(coachingId)}`,{method:'DELETE'});
export const sendTeamCoaching=coachingId=>api(`/api/my/team-coaching/${encodeURIComponent(coachingId)}/send`,{method:'POST',body:'{}'});
export const loadMyCoaching=()=>api('/api/my/coaching');
export const acknowledgeCoaching=(coachingId,payload)=>api(`/api/my/coaching/${encodeURIComponent(coachingId)}/acknowledge`,{method:'POST',body:JSON.stringify(payload)});
export const loadSiteCoachingOverview=()=>api('/api/som/coaching-overview');
