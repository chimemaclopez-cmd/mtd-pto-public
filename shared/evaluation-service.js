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

const EVALUATION_RATING_LABELS={1:'Poor',2:'Below Average',3:'Average',4:'Above Average',5:'Excellent'};
// "Generate Feedback": drafts the Evaluator Comments field from the ratings the evaluator has
// already picked on the open form, plus that employee's probationary KPI row for the same period
// (already loaded into probationKpiRows by loadEvaluationsTab - no extra fetch needed). Same
// shape as QA Scorecard's buildQaFeedbackPrompt: write strictly from the given data, JSON-only
// response, regex-extracted so a stray sentence before/after the JSON doesn't break parsing.
export function buildEvaluationFeedbackPrompt({employeeName,evaluationPeriod,ratings,kpiRow}){
  const lines=Object.keys(EVALUATION_ATTRIBUTE_LABELS).map(key=>{
    const v=ratings?.[key];
    if(!v)return null;
    return `- ${EVALUATION_ATTRIBUTE_LABELS[key]}: ${v}/5 (${EVALUATION_RATING_LABELS[v]||v})`;
  }).filter(Boolean).join('\n');
  const kpiLines=kpiRow?[
    kpiRow.productivity?.tierPercent!=null?`- Productivity: ${kpiRow.productivity.tierPercent}%`:null,
    kpiRow.csat?.tierPercent!=null?`- CSAT: ${kpiRow.csat.tierPercent}%`:null,
    kpiRow.processCompliance?.raw!=null?`- Process Compliance: ${kpiRow.processCompliance.raw}%`:null,
    kpiRow.attendance?.raw!=null?`- Attendance: ${kpiRow.attendance.raw}%`:null,
    kpiRow.totalScore!=null?`- Overall KPI score for this period: ${kpiRow.totalScore}%`:null,
    kpiRow.workedDays!=null?`- Worked days this period: ${kpiRow.workedDays}`:null,
  ].filter(Boolean).join('\n'):'';
  return `You are a team lead writing the "Evaluator Comments" section of a probationary performance evaluation${employeeName?` for ${employeeName}`:''}${evaluationPeriod?`, covering ${evaluationPeriod}`:''}. Write feedback strictly consistent with the ratings below - don't introduce claims they don't support, and don't invent specifics the data doesn't give you.

Ratings (1-5 scale: 1 Poor, 2 Below Average, 3 Average, 4 Above Average, 5 Excellent):
${lines||'(no attributes rated yet)'}
${kpiLines?`\nThis period's KPI data:\n${kpiLines}`:''}

Respond with ONLY a single JSON object, no prose, no markdown code fences, in exactly this shape:
{"comments":"3-5 sentence overall assessment covering strengths, specific gaps tied to the lowest-rated attributes, and clear expectations going forward - grounded only in the ratings and KPI data given above"}`;
}
export function isEvaluationFeedbackBadAnswer(raw){
  return !/\{[\s\S]*\}/.test(String(raw||''));
}
export function parseEvaluationFeedbackResponse(raw){
  const match=String(raw||'').match(/\{[\s\S]*\}/);
  if(!match)throw new Error('AI response did not contain a JSON object.');
  let parsed;
  try{parsed=JSON.parse(match[0])}catch{throw new Error('AI response JSON could not be parsed.')}
  return {comments:String(parsed.comments||'').trim()};
}
export const loadMyTeamEvaluations=()=>api('/api/my/team-evaluations');
export const createTeamEvaluation=record=>api('/api/my/team-evaluations',{method:'POST',body:JSON.stringify(record)});
export const loadTeamEvaluationRecord=evaluationId=>api(`/api/my/team-evaluations/${encodeURIComponent(evaluationId)}`);
export const updateTeamEvaluation=(evaluationId,record)=>api(`/api/my/team-evaluations/${encodeURIComponent(evaluationId)}`,{method:'PUT',body:JSON.stringify(record)});
export const deleteTeamEvaluation=evaluationId=>api(`/api/my/team-evaluations/${encodeURIComponent(evaluationId)}`,{method:'DELETE'});
export const sendTeamEvaluation=evaluationId=>api(`/api/my/team-evaluations/${encodeURIComponent(evaluationId)}/send`,{method:'POST',body:'{}'});
export const loadMyEvaluations=()=>api('/api/my/evaluations');
export const acknowledgeEvaluation=(evaluationId,payload)=>api(`/api/my/evaluations/${encodeURIComponent(evaluationId)}/acknowledge`,{method:'POST',body:JSON.stringify(payload)});
// Current-period KPI score + coaching logs for one of MY OWN evaluations - the same appendix
// data baked into the official exported PDF (zendesk-proxy.js's buildEvaluationAppendixData),
// surfaced here so the sign-and-review screen can show the same supporting context.
export const loadMyEvaluationAppendix=evaluationId=>api(`/api/my/evaluation-appendix?evaluationId=${encodeURIComponent(evaluationId)}`);

// Probationary KPI Metrics - a running table separate from the formal evaluation form above,
// for direct reports still within their first 5 months of tenure.
export const loadTeamProbationKpi=()=>api('/api/my/team-probation-kpi');
export const loadMyProbationKpi=()=>api('/api/my/probation-kpi');
export const saveProbationCompliance=(employeeEmail,periodNumber,percent)=>api(`/api/my/team-probation-kpi/${encodeURIComponent(employeeEmail)}/compliance`,{method:'POST',body:JSON.stringify({periodNumber,percent})});
// Months 4-5 only - which raw count (tickets vs calls) counts as Productivity for this
// employee/period, since that's flexible per business need rather than fixed by role.
export const saveProbationProductivityKind=(employeeEmail,periodNumber,kind)=>api(`/api/my/team-probation-kpi/${encodeURIComponent(employeeEmail)}/productivity-kind`,{method:'POST',body:JSON.stringify({periodNumber,kind})});
