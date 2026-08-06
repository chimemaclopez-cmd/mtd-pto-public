import {api} from './ui-utils.js';

export const ALIGNMENT_STATUS_LABELS={DRAFT:'Draft',PENDING_APPROVAL:'Pending Approval',APPROVED:'Approved',REJECTED:'Rejected'};
export const loadMyTeamAlignment=()=>api('/api/my/team-alignment');
export const createTeamAlignment=record=>api('/api/my/team-alignment',{method:'POST',body:JSON.stringify(record)});
export const updateTeamAlignment=(alignmentId,record)=>api(`/api/my/team-alignment/${encodeURIComponent(alignmentId)}`,{method:'PUT',body:JSON.stringify(record)});
export const deleteTeamAlignment=alignmentId=>api(`/api/my/team-alignment/${encodeURIComponent(alignmentId)}`,{method:'DELETE'});
export const submitTeamAlignment=alignmentId=>api(`/api/my/team-alignment/${encodeURIComponent(alignmentId)}/submit`,{method:'POST',body:'{}'});
export const loadAlignmentReviewQueue=()=>api('/api/som/alignment-review');
export const decideAlignment=(alignmentId,payload)=>api(`/api/som/alignment-review/${encodeURIComponent(alignmentId)}/decide`,{method:'POST',body:JSON.stringify(payload)});
export const loadMyAlignment=()=>api('/api/my/alignment');
export const acknowledgeAlignment=(alignmentId,payload)=>api(`/api/my/alignment/${encodeURIComponent(alignmentId)}/acknowledge`,{method:'POST',body:JSON.stringify(payload)});
