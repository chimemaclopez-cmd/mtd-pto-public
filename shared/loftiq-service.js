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
// public product Help Center (help.lofty.com) and the portal's own Alignment (SOP/policy)
// records. Both are simple keyword searches server-side, run for every question so Lotti can
// draw on them when relevant without needing a separate intent-classification step. Alignment
// is the SOLE SOP source - there is deliberately no separate pasted-text SOP library, since
// Alignment already is the portal's real, admin-authored SOP system and a second parallel one
// would just be two places to keep in sync.
export const searchLoftIqHelp=(query)=>api(`/api/my/loftiq/help-search?q=${encodeURIComponent(query)}`);
// Every APPROVED company Alignment record (title + rich-text body), not just the ones targeted
// to the asking employee.
export const searchLoftIqAlignments=(query)=>api(`/api/my/loftiq/alignment-search?q=${encodeURIComponent(query)}`);
// Full text of every APPROVED alignment, for the admin "check for contradictions" review -
// admin-only, unlike the search above which any signed-in employee's Lotti question can trigger.
export const loadAllApprovedAlignments=()=>api('/api/admin/alignment/all-approved');

// Lotti Knowledge: admin-authored reference content (managed on its own admin-only tab, never
// shown in the employee-facing Alignment tabs) that Lotti also draws on for ANY employee's
// question - same reach as searchLoftIqAlignments above, just a separate content source for
// things nobody needs to be assigned to read/acknowledge.
export const searchLoftIqKnowledge=(query)=>api(`/api/my/loftiq/knowledge-search?q=${encodeURIComponent(query)}`);
export const loadLottiKnowledge=()=>api('/api/admin/lotti-knowledge');
export const createLottiKnowledge=(payload)=>api('/api/admin/lotti-knowledge',{method:'POST',body:JSON.stringify(payload)});
export const updateLottiKnowledge=(id,payload)=>api(`/api/admin/lotti-knowledge/${encodeURIComponent(id)}`,{method:'PUT',body:JSON.stringify(payload)});
export const deleteLottiKnowledge=(id)=>api(`/api/admin/lotti-knowledge/${encodeURIComponent(id)}`,{method:'DELETE'});

// Builds the Copilot prompt for the admin "check Alignments for contradictions" review - a
// company-wide oversight tool, separate from LoftIQ's own per-question prompt above but reusing
// the same Copilot connection (copilotChat/copilotResponseText).
export function buildAlignmentContradictionPrompt(alignments){
  return `You are reviewing a company's internal SOP/policy documents (from the Alignment system) for direct contradictions - places where two or more documents give genuinely conflicting instructions on the same situation, not just different topics or complementary guidance.

For each contradiction you find: name the SOP titles involved, quote the specific conflicting instructions from each (briefly), and explain the conflict in one sentence. If you find no real contradictions, say so plainly rather than inventing one. Only flag a real conflict - where following one SOP would mean violating another - not overlapping-but-compatible guidance. Plain text only, no markdown symbols.

SOPs to review:
${JSON.stringify(alignments)}`;
}

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

// Copilot occasionally acknowledges its own system-prompt instructions instead of answering the
// actual question - observed live during calibration testing (e.g. "Got it. I'll use Camille's
// data only, keep things warm and straightforward..."), resolved cleanly on an identical retry
// both times it happened. This catches that shape so askLoftIq can retry automatically rather
// than showing the user a non-answer. Deliberately narrow (short reply + an acknowledgment
// opener + persona words lifted straight from the prompt above) so a real short answer that
// happens to mention "warm" or "direct" isn't mistaken for one of these.
export function isLoftIqMetaResponse(text){
  const t=(text||'').trim();
  if(!t||t.length>220)return false;
  const acksOpener=/^(got it|understood|sure(?:,| )|okay|ok\b)/i;
  const personaTalk=/\b(i'?ll|i will)\b[^.!?]{0,80}\b(warm|straightforward|grounded|classy|colleague|data only|keep (it|things)|call out|clearly when)\b/i;
  return acksOpener.test(t)&&personaTalk.test(t);
}

// A second, distinct flaky failure mode observed during calibration: Copilot claims a fact
// "wasn't provided" (e.g. "no employee KPI data was provided") when the field is actually
// present and populated in EMPLOYEE'S OWN DATA above - confirmed live by an identical retry
// answering correctly both times observed, so this is Copilot flakiness, not a real data gap.
// Deliberately keyed on "data/information ... provided" phrasing rather than any "don't have
// X" wording - the prompt's own STRICT RULE instructs Lotti to phrase a genuinely-empty field
// as "you don't have any X," which is a correct, confident answer and must never be mistaken
// for this failure mode (e.g. "No, you don't have any disciplinary records" doesn't match).
export function isLoftIqFalseNoDataClaim(text){
  const t=(text||'').trim();
  if(!t)return false;
  return /\b(no|not|wasn'?t|weren'?t|isn'?t|don'?t|doesn'?t|can'?t|couldn'?t|didn'?t)\b[^.!?]{0,60}\b(data|information)\b[^.!?]{0,40}\b(provided|given|included|shared|available)\b/i.test(t);
}

// A third flaky failure mode, observed live testing this on the production site: Copilot
// deflects with a generic "what would you like to check next?" prompt instead of answering the
// specific question actually asked (e.g. asked "how many PTO days do I have left?", got back
// "I'm here - what would you like to check next? Could be PTO, schedule..."). An identical retry
// answered correctly. Keyed on the distinctive idle-chat opener/phrasing real data-driven answers
// don't use, not on length alone, so a genuine short answer isn't mistaken for this.
export function isLoftIqDeflection(text){
  const t=(text||'').trim();
  if(!t||t.length>220)return false;
  return /^i'?m here\b/i.test(t)||/what would you like (to (check|know|see)|me to (check|help))/i.test(t);
}

export function isLoftIqBadAnswer(text){
  return isLoftIqMetaResponse(text)||isLoftIqFalseNoDataClaim(text)||isLoftIqDeflection(text);
}

// Builds the actual Copilot prompt: real data context (from loadLoftIqContext, gathered
// server-side and scoped strictly to the signed-in user's real identity) + this scope's prior
// exchanges (manual context-stuffing, since Copilot's chat/messages call is single-shot with no
// visible native multi-turn support) + the new question.
export function buildLoftIqPrompt({context,priorMessages,question,helpArticles,alignments}){
  const history=(priorMessages||[]).slice(-8).map(m=>`${m.role==='user'?'Employee':'Lotti'}: ${m.content}`).join('\n');
  const teamNote=context?.isTeamLead?" The `team` field is this employee's own direct reports (they lead this team) - it's fine to answer team-level questions from it, but never treat it as another individual employee's personal data.":'';
  const hasGeneralKnowledge=(helpArticles&&helpArticles.length)||(alignments&&alignments.length);
  return `You are Lotti. You're not a lookup tool reciting fields - you're a genuine guide this person actually likes checking in with: warm, a little witty, plainly on their side. Talk like a sharp, well-liked colleague who happens to have their KPI/schedule/PTO/coaching data open in front of them, not like a form letter or a corporate FAQ bot. Have real reactions: mean it when something's going well ("nice, that's your best CSAT this month"), be honest and steady (not clinical, not falsely cheerful) when something isn't. Classy, not gushy - skip the exclamation-point-per-sentence energy and the "I'm just an AI" disclaimers. One or two sentences of personality is plenty; don't let warmth crowd out the actual answer.

None of that changes what you can say: answer using ONLY the data provided below - never invent a number, date, or status you don't see here.${teamNote} If a specific fact truly isn't anywhere in the data, say so plainly (still warmly) rather than guessing.

You ARE expected to reason over the data, not just look up a single field: filter, sort, count, or cross-reference the fields you're given to answer "who/which/how many/what's the trend" questions (e.g. naming the employees whose performanceStatus is Watch or Intervention from team.teamMembers, or checking whether a date falls within a range) - that's reading the data, not inventing it. Only refuse when the fact really isn't there.

STRICT RULE: check whether the field key itself exists in the JSON below before ever saying you "don't see" or "don't have" something. If the key exists - even as [], 0, null, or all-zero - that IS your answer, stated as a confident fact, never as a hedge. Example: disciplinaryRecords is a key in the data below; if its value is [], the correct answer is "No, you don't have any disciplinary records" - NOT "I don't see disciplinary-record data" or "I can't confirm." Same for pointsBalance:{earned:0,spent:0,balance:0} - the correct answer is "You have 0 points," not "I can't see points data." Reserve "the data doesn't cover that" strictly for keys that are absent from the JSON entirely.

Some questions need a live check this data can't fully replace - e.g. whether a PTO request would actually be approved depends on staffing-capacity limits computed only at request time, not something precomputed here for every possible date. For those, still answer the part you CAN from the data (e.g. whether the date is a scheduled workday), then point to the specific portal action that gives the definitive answer (e.g. "submit it from PTO Requests and the app will check staffing capacity") instead of a bare "the data doesn't show this."
${hasGeneralKnowledge?'\nGENERAL_KNOWLEDGE below (Lofty product help articles and company Alignment SOPs/policies) is a SEPARATE thing from the employee\'s own data above - it\'s general reference material, not anything personal to them. Alignment entries are the portal\'s own official, admin-authored SOPs - treat them as authoritative for "what\'s the process/policy for Y" questions. Use it for "how does X work" type questions, and feel free to summarize it in your own words rather than quoting verbatim. If nothing in there actually answers the question, say so rather than stretching an unrelated article to fit.':''}

Be conversational but not wordy, plain text only (no markdown symbols like ** or #). When your answer lists more than two items, put each on its own line rather than one run-on sentence.

EMPLOYEE'S OWN DATA (this is everything you're allowed to reference about them personally):
${JSON.stringify(context)}
${hasGeneralKnowledge?`\nGENERAL_KNOWLEDGE (Lofty product help + company Alignment SOPs, not personal data):\n${JSON.stringify({helpArticles:helpArticles||[],alignments:alignments||[]})}\n`:''}
${history?`\nPRIOR CONVERSATION (this scope only):\n${history}\n`:''}
Employee: ${question}
Lotti:`;
}
