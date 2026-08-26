import {api} from './ui-utils.js';

export const OPERATIONAL_NOTE_KPI_LABELS={COMPLETION_RATE:'Completion Rate',CSAT:'CSAT',PRODUCTIVITY:'Productivity',ATTENDANCE:'Attendance',OTHER:'Other'};
export const OPERATIONAL_NOTE_SCOPE_LABELS={COMPANY:'Company-wide',SITE:'Site',TEAM:'Team',INDIVIDUAL:'Individual'};
export const OPERATIONAL_NOTE_IMPACT_LABELS={NEGATIVE:'Negative',POSITIVE:'Positive',NEUTRAL:'Neutral'};
export const OPERATIONAL_NOTE_STATUS_LABELS={ONGOING:'Ongoing',MONITORING:'Monitoring',RESOLVED:'Resolved'};

export const loadOperationalNotes=()=>api('/api/leadership/operational-notes');
export const createOperationalNote=payload=>api('/api/leadership/operational-notes',{method:'POST',body:JSON.stringify(payload)});
export const updateOperationalNote=(id,payload)=>api(`/api/leadership/operational-notes/${encodeURIComponent(id)}`,{method:'PUT',body:JSON.stringify(payload)});
export const deleteOperationalNote=id=>api(`/api/leadership/operational-notes/${encodeURIComponent(id)}`,{method:'DELETE'});
