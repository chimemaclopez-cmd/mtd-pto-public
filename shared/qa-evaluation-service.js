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

// A QA audit is meant to judge a completed interaction - scoring a still-open ticket (open,
// pending, hold, new) risks marking the agent down for steps they simply haven't gotten to yet
// (a follow-up not sent, a resolution not confirmed). Used both live (warn before/while scoring)
// and on saved records (so a scorecard created before the ticket was resolved still carries the
// caveat later, in the view modal, printable PDF, and history).
export const QA_SCORECARD_RESOLVED_TICKET_STATUSES=new Set(['solved','closed']);
export function isQaScorecardTicketUnresolved(ticketStatus){
  const s=String(ticketStatus||'').trim().toLowerCase();
  return Boolean(s)&&!QA_SCORECARD_RESOLVED_TICKET_STATUSES.has(s);
}
export function qaScorecardTicketStatusWarning(ticketStatus){
  return `This ticket's status is currently "${ticketStatus}" — it isn't solved or closed yet. This audit may not be fully accurate until the ticket is resolved.`;
}

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
    if(category.key==='technicalPerformance'&&ratings?.correctResolution==='NO')earned=0;
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
export function buildQaPreQaPrompt({categories,criticalErrors,subject,transcript,liveCalibration,agentName,fieldsText}){
  const rubricText=categories.map(cat=>`${cat.label} (${cat.groupLabel}):\n`+cat.criteria.map(c=>`- ${c.key}: "${c.label}" - ${c.description} (${c.points} pts)`).join('\n')).join('\n\n');
  const criticalText=criticalErrors.map(e=>`- ${e.key}: ${e.label}`).join('\n');
  const agentLine=agentName?`\nThe agent being evaluated is: ${agentName}. Every criterion judges ONLY this person's own actions and wording.\n`:'';
  const fieldsLine=fieldsText?`\nTicket fields as actually recorded in Zendesk (this is the ONLY evidence for "Accurate Zendesk information" - it is a metadata check, not a conversation check; you cannot judge it from the transcript alone):\n${fieldsText}\nCross-check these values against anything the customer or agent mentions in the transcript (account name, company, product, ID) - a mismatch (e.g. a Client ID that doesn't match the account discussed) or a required field left blank is a No, not a Yes.\n`:'';
  return `You are a QA analyst scoring one support ticket interaction against a fixed rubric. Read the ticket transcript below and rate EVERY criterion.
${agentLine}
IMPORTANT - the transcript mixes messages from several kinds of sender: the actual human agent, the requester/customer, and automated system senders (e.g. "CS Integration", macros, triggers, auto-follow-up emails, workflow bots - anything that reads like a canned system-generated message rather than something a person typed live in the moment). Never credit or penalize the agent for an automated/system message - it is not something they personally wrote. If the only evidence for a criterion (e.g. a closing recap, an empathy statement) comes from an automated message rather than the human agent's own words, rate that criterion NA rather than No, since there is no real evidence of what the human agent themselves did.

This especially applies to Closing & recap and Correct resolution when the ticket ends via an automated auto-solve/auto-close after the customer simply stopped replying to follow-ups (not because the agent decided to close it). In that situation, check what the human agent's OWN last message actually was: if it was still mid-troubleshooting - asking a question, requesting information (e.g. "please send a screenshot"), waiting on the customer - the agent never reached, and was never GIVEN, a real closing moment. There is no missing closing to penalize; rate Closing & recap and Correct resolution NA, and do NOT flag "closed before resolution" as a critical error either, since the agent didn't close anything - the automation did, after the customer went silent. Only rate these No if the agent themselves had reached an actual decision point (e.g. they had enough information to resolve it, or they personally marked/solved the ticket) and still skipped the recap or resolution.

STRICT REQUIREMENT - read this before you start: for EVERY criterion you rate NO or PARTLY, its reason string MUST contain two sentences: (1) the evidence, then (2) a sentence starting with the literal word "Could have" naming one specific, concrete thing the agent should have said or done instead in this exact transcript. This is never optional - a No/Partly reason with only the evidence sentence and no "Could have" sentence is an incomplete answer. Example of a correct reason for a No rating: "The agent did not acknowledge the customer's frustration. Could have said: 'I understand how frustrating this is, let's get it sorted for you.'" Yes/NA reasons stay a single evidence sentence, no "Could have" needed.

Rubric criteria (rate each Yes / Partly / No / NA - use NA only if the criterion genuinely could not apply):
${rubricText}

Critical errors (true only if clearly evidenced in the transcript, otherwise false):
${criticalText}

${QA_SCORECARD_CALIBRATION_NOTE}
${buildQaLiveCalibrationNote(liveCalibration,categories)}
${fieldsLine}
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

// "Generate Feedback & Action Plan": run AFTER the reviewer has finished their own manual
// rating (qaScorecardFormRatings/FormCriticalErrors), not from the AI's original Pre-QA draft -
// so the write-up reflects what the reviewer actually decided, even where they overrode the AI's
// suggestion. Built purely from the confirmed ratings/labels, no ticket transcript needed.
export function buildQaFeedbackPrompt({categories,criticalErrors,ratings,criticalErrorFlags,agentName}){
  const lines=categories.flatMap(cat=>cat.criteria.map(c=>{
    const v=ratings?.[c.key];
    if(!v)return null;
    return `- ${c.label} (${cat.label}): ${QA_SCORECARD_RATING_LABELS[v]||v}`;
  })).filter(Boolean).join('\n');
  const flagged=criticalErrors.filter(e=>criticalErrorFlags?.[e.key]).map(e=>e.label);
  return `You are a QA analyst writing the final coaching write-up for a completed ticket-handling evaluation${agentName?` of ${agentName}`:''}. These are the reviewer's own FINAL confirmed ratings for this ticket, not a draft - write feedback strictly consistent with these ratings, don't introduce claims they don't support.

Ratings:
${lines||'(no criteria rated yet)'}
${flagged.length?`\nCritical errors confirmed: ${flagged.join(', ')}`:''}

Respond with ONLY a single JSON object, no prose, no markdown code fences, in exactly this shape:
{"feedback":"2-4 sentence summary of strengths and gaps consistent with the ratings above","actionPlan":"1-2 concrete, specific coaching actions addressing the No/Partly-rated criteria (or acknowledging strong performance if there are none)"}`;
}

export function isQaFeedbackBadAnswer(raw){
  return !/\{[\s\S]*\}/.test(String(raw||''));
}

export function parseQaFeedbackResponse(raw){
  const match=String(raw||'').match(/\{[\s\S]*\}/);
  if(!match)throw new Error('AI response did not contain a JSON object.');
  let parsed;
  try{parsed=JSON.parse(match[0])}catch{throw new Error('AI response JSON could not be parsed.')}
  return {feedback:String(parsed.feedback||'').trim(),actionPlan:String(parsed.actionPlan||'').trim()};
}
