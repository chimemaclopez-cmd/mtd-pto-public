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

export const QA_SCORECARD_STATUS_LABELS={DRAFT:'Draft',PUBLISHED:'Published'};
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

// AI Pre-QA: build the prompt for the shared Copilot connection (same tsr-bot token already
// used by DSAT Review's AI triage) to pre-score a ticket transcript against this exact rubric,
// and parse its JSON reply back into the same {ratings, criticalErrors} shape the form uses.
export function buildQaPreQaPrompt({categories,criticalErrors,subject,transcript}){
  const rubricText=categories.map(cat=>`${cat.label} (${cat.groupLabel}):\n`+cat.criteria.map(c=>`- ${c.key}: "${c.label}" - ${c.description} (${c.points} pts)`).join('\n')).join('\n\n');
  const criticalText=criticalErrors.map(e=>`- ${e.key}: ${e.label}`).join('\n');
  return `You are a QA analyst scoring one support ticket interaction against a fixed rubric. Read the ticket transcript below and rate EVERY criterion.

Rubric criteria (rate each Yes / Partly / No / NA - use NA only if the criterion genuinely could not apply):
${rubricText}

Critical errors (true only if clearly evidenced in the transcript, otherwise false):
${criticalText}

Ticket subject: ${subject||'(none)'}

Transcript:
${transcript||'(no transcript available)'}

Respond with ONLY a single JSON object, no prose, no markdown code fences, in exactly this shape:
{"ratings":{"<criterionKey>":"YES|PARTLY|NO|NA", ...one entry per criterion key above...},"criticalErrors":{"<errorKey>":true|false, ...one entry per critical error key above...},"feedback":"2-4 sentence summary of strengths and gaps, citing specific transcript evidence","actionPlan":"1-2 concrete, specific coaching actions"}`;
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
  const ratings={};
  for(const category of categories)for(const c of category.criteria){
    const v=String(parsed.ratings?.[c.key]||'').toUpperCase();
    ratings[c.key]=validRatings.has(v)?v:null;
  }
  const criticalOut={};
  for(const e of criticalErrors)criticalOut[e.key]=Boolean(parsed.criticalErrors?.[e.key]);
  return {ratings,criticalErrors:criticalOut,feedback:String(parsed.feedback||'').trim(),actionPlan:String(parsed.actionPlan||'').trim()};
}
