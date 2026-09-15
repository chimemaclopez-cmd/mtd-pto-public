import {api} from './ui-utils.js';

export const getQaScorecardLookupLists=()=>api('/api/qa/scorecards/lookup-lists');
export const listQaScorecards=(params={})=>{const query=new URLSearchParams(Object.entries(params).filter(([,v])=>v));return api(`/api/qa/scorecards${query.size?`?${query}`:''}`)};
export const createQaScorecard=(payload)=>api('/api/qa/scorecards',{method:'POST',body:JSON.stringify(payload)});
export const getQaScorecard=(id)=>api(`/api/qa/scorecards/${encodeURIComponent(id)}`);
export const updateQaScorecard=(id,payload)=>api(`/api/qa/scorecards/${encodeURIComponent(id)}`,{method:'PUT',body:JSON.stringify(payload)});
export const deleteQaScorecard=(id)=>api(`/api/qa/scorecards/${encodeURIComponent(id)}`,{method:'DELETE'});
export const getQaScorecardReporting=(params={})=>{const query=new URLSearchParams(Object.entries(params).filter(([,v])=>v));return api(`/api/qa/scorecards/reporting${query.size?`?${query}`:''}`)};
export const getMyQaScorecards=()=>api('/api/my/qa-scorecards');
export const getQaScorecardTicketThread=(ticketId)=>api(`/api/qa/scorecards/ticket-thread?ticketId=${encodeURIComponent(ticketId)}`);
export const acknowledgeQaScorecard=(id,payload)=>api(`/api/qa/scorecards/${encodeURIComponent(id)}/acknowledge`,{method:'POST',body:JSON.stringify(payload)});

export const QA_SCORECARD_STATUS_LABELS={DRAFT:'Draft',PUBLISHED:'Published',ACKNOWLEDGED:'Acknowledged'};
export const QA_SCORECARD_RATING_LABELS={YES:'Yes',PARTLY:'Partly',NO:'No',NA:'N/A'};

// Pure mirror of the server's computeQaScorecardScore (pto-public-server.js) - used for the
// live-score sidebar as a reviewer clicks ratings, before anything is saved. The server always
// recomputes and persists its own authoritative result on save; this is display-only.
export function computeQaScorecardScore(categories,ratings,criticalErrors){
  let earnedPoints=0,availablePoints=0;const sections={};
  for(const category of categories){
    let earned=0,available=0;
    for(const criterion of category.criteria){
      const value=ratings?.[criterion.key];
      if(value==='NA')continue;
      available+=criterion.points;
      if(value==='YES')earned+=criterion.points;
      else if(value==='PARTLY')earned+=criterion.points/2;
    }
    sections[category.key]={earned,available,pct:available>0?Math.round((earned/available)*100):null};
    earnedPoints+=earned;availablePoints+=available;
  }
  const hasCriticalError=Object.values(criticalErrors||{}).some(Boolean);
  const rawPct=availablePoints>0?Math.round((earnedPoints/availablePoints)*100):0;
  const pct=hasCriticalError?0:rawPct;
  return {earnedPoints,availablePoints,pct,sections,hasCriticalError};
}

export function qaScorecardCompletedCount(categories,ratings){
  let total=0,completed=0;
  for(const category of categories)for(const criterion of category.criteria){total++;if(ratings?.[criterion.key])completed++}
  return {completed,total};
}

// Calibration notes derived from the 88 real evaluations already on file in the reference QA
// tool this rubric was modeled on (pulled live via its /api/evaluations endpoint, 2026-09-16 -
// avg score 94%, range 61-100%, zero critical errors recorded). Folded into the AI Pre-QA prompt
// so the AI's grading tendencies match how this rubric is actually used in practice, not a naive
// reading of the criteria text:
// - "Partly" was used ZERO times across all 88 evaluations, on any criterion - real reviewers
//   grade decisively Yes/No and use N/A liberally for what doesn't apply, not partial credit.
// - N/A is the majority answer for several criteria depending on context: Empathy was N/A in
//   87/88 (mostly email tickets with no visible distress to acknowledge), Follow-up & expectations
//   N/A in 68/88 (no follow-up was actually needed), Correct JIRA creation N/A in 72/88 (nothing
//   was escalated).
// - The most common real "No": Accurate Zendesk information (12/88), typically wrong/incomplete
//   account or client ID on the ticket - a concrete, checkable fact, not a judgment call.
const QA_SCORECARD_CALIBRATION_NOTE = `Calibration notes from 88 real historical evaluations of this exact rubric (so your grading matches how it's actually used, not just a literal reading of the criteria):
- "Partly" is almost never actually used in practice - grade decisively Yes or No. Reach for Partly only when the interaction is genuinely a mixed/half case, not as a default hedge.
- Use N/A generously whenever a criterion truly doesn't apply to this specific ticket - e.g. Empathy is usually N/A when there's no visible frustration to acknowledge (very common on routine email tickets), Follow-up & expectations is N/A when no follow-up was actually needed, and Correct JIRA creation is N/A whenever nothing was escalated.
- The most common real failure is Accurate Zendesk information (wrong/incomplete account or client ID, wrong category) - a checkable fact, not a subjective call. Check ticket metadata carefully for this one.
- Typical scores run high (historical average ~94%, rarely below ~85%) when the agent's core resolution is correct - most real gaps are in a couple of specific criteria, not spread evenly across the whole rubric.`;

// Turns the server's computeQaScorecardLiveCalibration() output (per-criterion Yes/Partly/No/N-A
// rates across every real evaluation saved in THIS portal, once there are enough to be
// meaningful) into prompt text - this is what lets the AI's grading keep adapting to how this
// specific team actually scores as more evaluations pile up, instead of staying frozen at the
// one-time reference-tool snapshot below. Returns '' when there isn't a live sample yet
// (computeQaScorecardLiveCalibration returns null under the min-sample threshold), so the
// prompt just falls back to QA_SCORECARD_CALIBRATION_NOTE alone.
export function buildQaLiveCalibrationNote(liveCalibration,categories){
  if(!liveCalibration)return '';
  const byKey=new Map(categories.flatMap(cat=>cat.criteria.map(c=>[c.key,c.label])));
  const lines=Object.entries(liveCalibration.criterionRates||{}).filter(([,r])=>r).map(([key,r])=>`- ${byKey.get(key)||key}: ${r.yesPct}% Yes, ${r.partlyPct}% Partly, ${r.noPct}% No, ${r.naPct}% N/A`).join('\n');
  return `\nLive calibration from ${liveCalibration.sampleSize} evaluations actually recorded in this portal so far (average score ${liveCalibration.avgScore}%, critical error rate ${liveCalibration.criticalErrorRate}%) - weight this over the historical reference notes above where they disagree, since it reflects this team's current real practice:\n${lines}\n`;
}

// AI Pre-QA: build the prompt for the shared Copilot connection (same tsr-bot token already
// used by DSAT Review's AI triage) to pre-score a ticket transcript against this exact rubric,
// and parse its JSON reply back into the same {ratings, criticalErrors} shape the form uses.
export function buildQaPreQaPrompt({categories,criticalErrors,subject,transcript,liveCalibration}){
  const rubricText=categories.map(cat=>`${cat.label} (${cat.groupLabel}):\n`+cat.criteria.map(c=>`- ${c.key}: "${c.label}" - ${c.description} (${c.points} pts)`).join('\n')).join('\n\n');
  const criticalText=criticalErrors.map(e=>`- ${e.key}: ${e.label}`).join('\n');
  return `You are a QA analyst scoring one support ticket interaction against a fixed rubric. Read the ticket transcript below and rate EVERY criterion.

Rubric criteria (rate each Yes / Partly / No / NA - use NA only if the criterion genuinely could not apply):
${rubricText}

Critical errors (true only if clearly evidenced in the transcript, otherwise false):
${criticalText}

${QA_SCORECARD_CALIBRATION_NOTE}
${buildQaLiveCalibrationNote(liveCalibration,categories)}
Ticket subject: ${subject||'(none)'}

Transcript:
${transcript||'(no transcript available)'}

Respond with ONLY a single JSON object, no prose, no markdown code fences, in exactly this shape:
{"ratings":{"<criterionKey>":"YES|PARTLY|NO|NA", ...one entry per criterion key above...},"reasons":{"<criterionKey>":"for YES/NA: one short sentence citing the specific transcript evidence behind that rating (for NA, say why it doesn't apply). For NO or PARTLY: that same evidence sentence PLUS a second sentence starting with 'Could have' giving one concrete, specific thing the agent should have said or done instead - not generic advice, something they could have literally said in this transcript.", ...one entry per criterion key above, required for every criterion...},"criticalErrors":{"<errorKey>":true|false, ...one entry per critical error key above...},"feedback":"2-4 sentence summary of strengths and gaps, citing specific transcript evidence","actionPlan":"1-2 concrete, specific coaching actions"}`;
}

export function isQaPreQaBadAnswer(raw){
  return !/\{[\s\S]*\}/.test(String(raw||''));
}

export function parseQaPreQaResponse(raw,categories,criticalErrors){
  const match=String(raw||'').match(/\{[\s\S]*\}/);
  if(!match)throw new Error('AI response did not contain a JSON object.');
  let parsed;
  try{parsed=JSON.parse(match[0])}catch{throw new Error('AI response JSON could not be parsed.')}
  const validRatings=new Set(['YES','PARTLY','NO','NA']);
  const ratings={},reasons={};
  for(const category of categories)for(const c of category.criteria){
    const v=String(parsed.ratings?.[c.key]||'').toUpperCase();
    ratings[c.key]=validRatings.has(v)?v:null;
    reasons[c.key]=String(parsed.reasons?.[c.key]||'').trim();
  }
  const criticalOut={};
  for(const e of criticalErrors)criticalOut[e.key]=Boolean(parsed.criticalErrors?.[e.key]);
  return {ratings,reasons,criticalErrors:criticalOut,feedback:String(parsed.feedback||'').trim(),actionPlan:String(parsed.actionPlan||'').trim()};
}
