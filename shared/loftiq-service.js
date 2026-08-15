import {api} from './ui-utils.js';

// LoftIQ: the portal's own Copilot-backed Q&A bot. The actual Copilot call itself reuses
// qa-dsat-service.js's copilotChat/copilotResponseText directly (one Copilot connection, no
// parallel integration) - this module only handles LoftIQ's own server-side pieces: the
// real-identity-scoped data context to ground answers, and the persisted, scope-keyed thread.
export const loadLoftIqContext=()=>api('/api/my/loftiq/context');
export const loadLoftIqThread=(scopeType='general',scopeId='')=>api(`/api/my/loftiq/thread?scopeType=${encodeURIComponent(scopeType)}&scopeId=${encodeURIComponent(scopeId)}`);
export const saveLoftIqExchange=(scopeType,scopeId,question,answer)=>api('/api/my/loftiq/save-exchange',{method:'POST',body:JSON.stringify({scopeType,scopeId,question,answer})});
export const markLoftIqViewed=()=>api('/api/my/loftiq/mark-viewed',{method:'POST',body:'{}'});

export const LOFTIQ_QUICK_ACTIONS=[
  'Why did my KPI score drop this period?',
  'How many PTO days do I have left?',
  'Am I on track to hit my ticket target this month?',
  'Is my DSAT dispute still pending?'
];

// Builds the actual Copilot prompt: real data context (from loadLoftIqContext, gathered
// server-side and scoped strictly to the signed-in user's real identity) + this scope's prior
// exchanges (manual context-stuffing, since Copilot's chat/messages call is single-shot with no
// visible native multi-turn support) + the new question.
export function buildLoftIqPrompt({context,priorMessages,question}){
  const history=(priorMessages||[]).slice(-8).map(m=>`${m.role==='user'?'Employee':'LoftIQ'}: ${m.content}`).join('\n');
  return `You are LoftIQ, the Lofty Support Portal's own assistant. Answer the employee's question using ONLY the data provided below - never invent a number, date, or status you don't see here. If the data doesn't cover what they're asking, say so plainly rather than guessing. Be concise and direct, plain text only, no markdown.

EMPLOYEE'S OWN DATA (this is everything you're allowed to reference):
${JSON.stringify(context)}
${history?`\nPRIOR CONVERSATION (this scope only):\n${history}\n`:''}
Employee: ${question}
LoftIQ:`;
}
