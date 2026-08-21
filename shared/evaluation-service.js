import {api} from './ui-utils.js';

export const EVALUATION_STATUS_LABELS={DRAFT:'Draft',SENT:'Awaiting Signature',ACKNOWLEDGED:'Acknowledged'};
export const EVALUATION_ATTRIBUTE_LABELS={
  quantityOfWork:'Quantity of Work',
  qualityOfWork:'Quality of Work',
  jobKnowledge:'Job Knowledge',
  dependabilityAccountabilityProfessionalism:'Dependability / Accountability / Professionalism',
  attendanceAndReliability:'Attendance and Reliability',
  speedAndExecutiveAbility:'Speed and Executive Ability',
  capacityToDevelop:'Capacity to Develop',
  leadershipManagement:'Leadership / Management (supervisor or manager level)'
};
export const loadMyTeamEvaluations=()=>api('/api/my/team-evaluations');
export const createTeamEvaluation=record=>api('/api/my/team-evaluations',{method:'POST',body:JSON.stringify(record)});
export const loadTeamEvaluationRecord=evaluationId=>api(`/api/my/team-evaluations/${encodeURIComponent(evaluationId)}`);
export const updateTeamEvaluation=(evaluationId,record)=>api(`/api/my/team-evaluations/${encodeURIComponent(evaluationId)}`,{method:'PUT',body:JSON.stringify(record)});
export const deleteTeamEvaluation=evaluationId=>api(`/api/my/team-evaluations/${encodeURIComponent(evaluationId)}`,{method:'DELETE'});
export const sendTeamEvaluation=evaluationId=>api(`/api/my/team-evaluations/${encodeURIComponent(evaluationId)}/send`,{method:'POST',body:'{}'});
export const loadMyEvaluations=()=>api('/api/my/evaluations');
export const acknowledgeEvaluation=(evaluationId,payload)=>api(`/api/my/evaluations/${encodeURIComponent(evaluationId)}/acknowledge`,{method:'POST',body:JSON.stringify(payload)});
