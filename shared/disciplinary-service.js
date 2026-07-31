import {api} from './ui-utils.js';

export const DISCIPLINARY_STATUS_LABELS={FILED:'Awaiting Pre-Review',PRE_DECIDED:'Awaiting Final Decision',DECIDED:'Awaiting Signature',ACKNOWLEDGED:'Acknowledged',WITHDRAWN:'Withdrawn'};
export const loadMyTeamDisciplinary=()=>api('/api/my/team-disciplinary');
export const fileDisciplinary=record=>api('/api/my/team-disciplinary',{method:'POST',body:JSON.stringify(record)});
export const loadTeamDisciplinaryRecord=violationId=>api(`/api/my/team-disciplinary/${encodeURIComponent(violationId)}`);
export const updateTeamDisciplinary=(violationId,record)=>api(`/api/my/team-disciplinary/${encodeURIComponent(violationId)}`,{method:'PUT',body:JSON.stringify(record)});
export const withdrawTeamDisciplinary=violationId=>api(`/api/my/team-disciplinary/${encodeURIComponent(violationId)}`,{method:'DELETE'});
export const preDecideDisciplinary=(violationId,payload)=>api(`/api/my/team-disciplinary/${encodeURIComponent(violationId)}/predecide`,{method:'POST',body:JSON.stringify(payload)});
export const decideDisciplinary=(violationId,payload)=>api(`/api/my/team-disciplinary/${encodeURIComponent(violationId)}/decide`,{method:'POST',body:JSON.stringify(payload)});
export const loadMyDisciplinary=()=>api('/api/my/disciplinary');
export const acknowledgeDisciplinary=(violationId,payload)=>api(`/api/my/disciplinary/${encodeURIComponent(violationId)}/acknowledge`,{method:'POST',body:JSON.stringify(payload)});
