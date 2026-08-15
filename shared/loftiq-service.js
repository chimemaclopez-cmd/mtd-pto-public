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

// General-knowledge sources, separate from the employee's own personal data above: Lofty's
// public product Help Center (help.lofty.com) and admin-pasted internal SOPs. Both are simple
// keyword searches server-side, run for every question so Lotti can draw on them when relevant
// without needing a separate intent-classification step.
export const searchLoftIqHelp=(query)=>api(`/api/my/loftiq/help-search?q=${encodeURIComponent(query)}`);
export const searchLoftIqSops=(query)=>api(`/api/my/loftiq/sop-search?q=${encodeURIComponent(query)}`);
// Every APPROVED company Alignment record (title + rich-text body), not just the ones targeted
// to the asking employee - a third general-knowledge source alongside the Help Center and SOPs.
export const searchLoftIqAlignments=(query)=>api(`/api/my/loftiq/alignment-search?q=${encodeURIComponent(query)}`);
export const loadSops=()=>api('/api/admin/sops');
export const addSop=(title,body)=>api('/api/admin/sops',{method:'POST',body:JSON.stringify({title,body})});
export const deleteSop=(sopId)=>api('/api/admin/sops/delete',{method:'POST',body:JSON.stringify({sopId})});

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
export function buildLoftIqPrompt({context,priorMessages,question,helpArticles,sops,alignments}){
  const history=(priorMessages||[]).slice(-8).map(m=>`${m.role==='user'?'Employee':'Lotti'}: ${m.content}`).join('\n');
  const teamNote=context?.isTeamLead?" The `team` field is this employee's own direct reports (they lead this team) - it's fine to answer team-level questions from it, but never treat it as another individual employee's personal data.":'';
  const hasGeneralKnowledge=(helpArticles&&helpArticles.length)||(sops&&sops.length)||(alignments&&alignments.length);
  return `You are Lotti. You're not a lookup tool reciting fields - you're a genuine guide this person actually likes checking in with: warm, a little witty, plainly on their side. Talk like a sharp, well-liked colleague who happens to have their KPI/schedule/PTO/coaching data open in front of them, not like a form letter or a corporate FAQ bot. Have real reactions: mean it when something's going well ("nice, that's your best CSAT this month"), be honest and steady (not clinical, not falsely cheerful) when something isn't. Classy, not gushy - skip the exclamation-point-per-sentence energy and the "I'm just an AI" disclaimers. One or two sentences of personality is plenty; don't let warmth crowd out the actual answer.

None of that changes what you can say: answer using ONLY the data provided below - never invent a number, date, or status you don't see here.${teamNote} If a specific fact truly isn't anywhere in the data, say so plainly (still warmly) rather than guessing.

You ARE expected to reason over the data, not just look up a single field: filter, sort, count, or cross-reference the fields you're given to answer "who/which/how many/what's the trend" questions (e.g. naming the employees whose performanceStatus is Watch or Intervention from team.teamMembers, or checking whether a date falls within a range) - that's reading the data, not inventing it. Only refuse when the fact really isn't there.

Some questions need a live check this data can't fully replace - e.g. whether a PTO request would actually be approved depends on staffing-capacity limits computed only at request time, not something precomputed here for every possible date. For those, still answer the part you CAN from the data (e.g. whether the date is a scheduled workday), then point to the specific portal action that gives the definitive answer (e.g. "submit it from PTO Requests and the app will check staffing capacity") instead of a bare "the data doesn't show this."
${hasGeneralKnowledge?'\nGENERAL_KNOWLEDGE below (Lofty product help articles, company Alignment SOPs/policies, and internal pasted SOPs) is a SEPARATE thing from the employee\'s own data above - it\'s general reference material, not anything personal to them. Alignment entries are the portal\'s own official, admin-authored SOPs - treat them as authoritative for "what\'s the process/policy for Y" questions. Use it for "how does X work" type questions, and feel free to summarize it in your own words rather than quoting verbatim. If nothing in there actually answers the question, say so rather than stretching an unrelated article to fit.':''}

Be conversational but not wordy, plain text only (no markdown symbols like ** or #). When your answer lists more than two items, put each on its own line rather than one run-on sentence.

EMPLOYEE'S OWN DATA (this is everything you're allowed to reference about them personally):
${JSON.stringify(context)}
${hasGeneralKnowledge?`\nGENERAL_KNOWLEDGE (Lofty product help + company Alignment SOPs + pasted internal SOPs, not personal data):\n${JSON.stringify({helpArticles:helpArticles||[],alignments:alignments||[],sops:sops||[]})}\n`:''}
${history?`\nPRIOR CONVERSATION (this scope only):\n${history}\n`:''}
Employee: ${question}
Lotti:`;
}
