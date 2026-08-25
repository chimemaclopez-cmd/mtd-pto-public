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
// Verbatim from the source Word form, so the evaluator sees exactly what each rating means
// while scoring, not just a bare attribute name.
export const EVALUATION_ATTRIBUTE_DESCRIPTIONS={
  quantityOfWork:'The extent to which the employee accomplishes assigned work of a specified quality within a specified time period',
  qualityOfWork:"The extent to which the employee's work is well executed, thorough, effective, accurate.",
  jobKnowledge:'Possesses and continually updates requisite knowledge and understanding of assigned duties, responsibilities, policies, procedures and compliance requirements to perform the position. Demonstrates technical skills required for the position. Understands business needs and desired outcomes.',
  dependabilityAccountabilityProfessionalism:'Follows through on assignments. Takes ownership of work. Is reliable, professional and responsible. Adheres to procedures, practices, and work schedule. Work is completed in a timely manner and within established deadlines effectively using resources. Demonstrates commitment to professional development.',
  attendanceAndReliability:'The extent to which employee arrives on time and demonstrates consistent attendance; the extent to which the employee contacts supervisor on a timely basis when employee will be late or absent.',
  speedAndExecutiveAbility:'The extent to which the employee is self-directed, and reacts quickly in meeting job objectives; consider how fast the employee follows through on assignments.',
  capacityToDevelop:'The extent to which the employee demonstrates the ability and willingness to accept new/more complex duties/responsibilities.',
  leadershipManagement:'Establishes clear vision for staff and motivates employees to achieve their best performance. Engages and motivates staff, coaching for peak performance. Makes outreach efforts and uses resources to create a diverse workforce. Leads and manages change. Builds and manages relationships across the department. Participate company projects or programs to motivate staff to improve their performance.'
};
// Average of whichever attributes actually have a 1-5 rating (N/A ones - normally just
// Leadership/Management - are excluded from both the sum and the count, not treated as 0).
// Matches the source form's own convention: date + average score sit together in the header
// cell above the attribute rows. Returns null (render as "-") when nothing has been rated yet.
export function evaluationAverageScore(ratings){
  const values=Object.values(ratings||{}).filter(v=>typeof v==='number'&&Number.isFinite(v));
  if(!values.length)return null;
  return Math.round((values.reduce((sum,v)=>sum+v,0)/values.length)*100)/100;
}
export const loadMyTeamEvaluations=()=>api('/api/my/team-evaluations');
export const createTeamEvaluation=record=>api('/api/my/team-evaluations',{method:'POST',body:JSON.stringify(record)});
export const loadTeamEvaluationRecord=evaluationId=>api(`/api/my/team-evaluations/${encodeURIComponent(evaluationId)}`);
export const updateTeamEvaluation=(evaluationId,record)=>api(`/api/my/team-evaluations/${encodeURIComponent(evaluationId)}`,{method:'PUT',body:JSON.stringify(record)});
export const deleteTeamEvaluation=evaluationId=>api(`/api/my/team-evaluations/${encodeURIComponent(evaluationId)}`,{method:'DELETE'});
export const sendTeamEvaluation=evaluationId=>api(`/api/my/team-evaluations/${encodeURIComponent(evaluationId)}/send`,{method:'POST',body:'{}'});
export const loadMyEvaluations=()=>api('/api/my/evaluations');
export const acknowledgeEvaluation=(evaluationId,payload)=>api(`/api/my/evaluations/${encodeURIComponent(evaluationId)}/acknowledge`,{method:'POST',body:JSON.stringify(payload)});

// Probationary KPI Metrics - a running table separate from the formal evaluation form above,
// for direct reports still within their first 5 months of tenure.
export const loadTeamProbationKpi=()=>api('/api/my/team-probation-kpi');
export const saveProbationCompliance=(employeeEmail,periodNumber,percent)=>api(`/api/my/team-probation-kpi/${encodeURIComponent(employeeEmail)}/compliance`,{method:'POST',body:JSON.stringify({periodNumber,percent})});
// Months 4-5 only - which raw count (tickets vs calls) counts as Productivity for this
// employee/period, since that's flexible per business need rather than fixed by role.
export const saveProbationProductivityKind=(employeeEmail,periodNumber,kind)=>api(`/api/my/team-probation-kpi/${encodeURIComponent(employeeEmail)}/productivity-kind`,{method:'POST',body:JSON.stringify({periodNumber,kind})});
