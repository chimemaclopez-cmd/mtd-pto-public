import {api} from './ui-utils.js';

// LoftIQ: the portal's own Copilot-backed Q&A bot. The actual Copilot call itself reuses
// qa-dsat-service.js's copilotChat/copilotResponseText directly (one Copilot connection, no
// parallel integration) - this module only handles LoftIQ's own server-side pieces: the
// real-identity-scoped data context to ground answers, and the persisted, scope-keyed thread.
export const loadLoftIqContext=()=>api('/api/my/loftiq/context');
export const loadLoftIqThread=(scopeType='general',scopeId='')=>api(`/api/my/loftiq/thread?scopeType=${encodeURIComponent(scopeType)}&scopeId=${encodeURIComponent(scopeId)}`);
export const saveLoftIqExchange=(scopeType,scopeId,question,answer)=>api('/api/my/loftiq/save-exchange',{method:'POST',body:JSON.stringify({scopeType,scopeId,question,answer})});
export const markLoftIqViewed=()=>api('/api/my/loftiq/mark-viewed',{method:'POST',body:'{}'});
export const clearLoftIqThread=(scopeType='general',scopeId='')=>api('/api/my/loftiq/clear-thread',{method:'POST',body:JSON.stringify({scopeType,scopeId})});

export const LOFTIQ_QUICK_ACTIONS=[
  'Why did my KPI score drop this period?',
  'How many PTO days do I have left?',
  'Am I on track to hit my ticket target this month?',
  'Is my DSAT dispute still pending?'
];

// Shown instead of the rep questions above when the signed-in employee leads a team (same
// isTeamLeader check /api/my/kpi already uses) - grounded in the `team` block
// /api/my/loftiq/context adds for team leads, built from data the lead already has access to
// elsewhere in the portal (Team KPI, Team Attendance, Team Coaching, Service Recovery), never
// from another rep's own personal tab.
export const LOFTIQ_LEAD_QUICK_ACTIONS=[
  'How is my team performing this period?',
  'Which of my reports have coaching follow-ups due?',
  'Any attendance red flags on my team this month?',
  "How's my team doing on Service Recovery follow-ups?"
];

// Builds the actual Copilot prompt: real data context (from loadLoftIqContext, gathered
// server-side and scoped strictly to the signed-in user's real identity) + this scope's prior
// exchanges (manual context-stuffing, since Copilot's chat/messages call is single-shot with no
// visible native multi-turn support) + the new question.
export function buildLoftIqPrompt({context,priorMessages,question}){
  const history=(priorMessages||[]).slice(-8).map(m=>`${m.role==='user'?'Employee':'LoftIQ'}: ${m.content}`).join('\n');
  const teamNote=context?.isTeamLead?" The `team` field is this employee's own direct reports (they lead this team) - it's fine to answer team-level questions from it, but never treat it as another individual employee's personal data.":'';
  return `You are LoftIQ, the Lofty Support Portal's own assistant. Answer the employee's question using ONLY the data provided below - never invent a number, date, or status you don't see here. If a specific fact truly isn't anywhere in the data, say so plainly rather than guessing.${teamNote}

You ARE expected to reason over the data, not just look up a single field: filter, sort, count, or cross-reference the fields you're given to answer "who/which/how many/what's the trend" questions (e.g. naming the employees whose performanceStatus is Watch or Intervention from team.teamMembers, or checking whether a date falls within a range) - that's reading the data, not inventing it. Only refuse when the fact really isn't there.

Some questions need a live check this data can't fully replace - e.g. whether a PTO request would actually be approved depends on staffing-capacity limits computed only at request time, not something precomputed here for every possible date. For those, still answer the part you CAN from the data (e.g. whether the date is a scheduled workday), then point to the specific portal action that gives the definitive answer (e.g. "submit it from PTO Requests and the app will check staffing capacity") instead of a bare "the data doesn't show this."

Be direct and concise, plain text only (no markdown symbols like ** or #). When your answer lists more than two items, put each on its own line rather than one run-on sentence.

EMPLOYEE'S OWN DATA (this is everything you're allowed to reference):
${JSON.stringify(context)}
${history?`\nPRIOR CONVERSATION (this scope only):\n${history}\n`:''}
Employee: ${question}
LoftIQ:`;
}
