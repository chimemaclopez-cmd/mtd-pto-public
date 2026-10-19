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
// Lofty Academy training videos: title+description+category only (no transcript is stored per
// video) - enough for Lotti to point someone to the right video by name, not recite its
// narration. Same reach as searchLoftIqAlignments/searchLoftIqKnowledge above.
export const searchLoftIqLearningMaterials=(query)=>api(`/api/my/loftiq/learning-search?q=${encodeURIComponent(query)}`);
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
  return /^i'?m here\b/i.test(t)||/what would you like (to (check|know|see)|me to (check|help))/i.test(t)||/\bready when you are\b/i.test(t)||/^(got it|understood|sure|okay|ok)\b[^.!?]{0,30}[.!]\s*i'?m (ready|here)\b/i.test(t);
}

export function isLoftIqBadAnswer(text){
  return isLoftIqMetaResponse(text)||isLoftIqFalseNoDataClaim(text)||isLoftIqDeflection(text);
}

// Builds the actual Copilot prompt: real data context (from loadLoftIqContext, gathered
// server-side and scoped strictly to the signed-in user's real identity) + this scope's prior
// exchanges (manual context-stuffing, since Copilot's chat/messages call is single-shot with no
// visible native multi-turn support) + the new question.
export function buildLoftIqPrompt({context,priorMessages,question,helpArticles,alignments,trainingVideos,imageCount=0}){
  const history=(priorMessages||[]).slice(-8).map(m=>`${m.role==='user'?'Employee':'Lotti'}: ${String(m.content||'').replace(/\n\nSources: [\s\S]*$/,'')}`).join('\n');
  // Number every general-knowledge entry (help articles first, then SOP/knowledge entries) so the answer can cite which ones it used.
  const refHelp=(helpArticles||[]).map((a,i)=>({ref:`S${i+1}`,...a})),refAlign=(alignments||[]).map((a,i)=>({ref:`S${refHelp.length+i+1}`,...a}));
  const teamNote=context?.isTeamLead?" The `team` field is this employee's own direct reports (they lead this team) - it's fine to answer team-level questions from it, but never treat it as another individual employee's personal data.":'';
  const hasGeneralKnowledge=(helpArticles&&helpArticles.length)||(alignments&&alignments.length)||(trainingVideos&&trainingVideos.length);
  return `You are Lotti. You're not a lookup tool reciting fields - you're a genuine guide this person actually likes checking in with: warm, a little witty, plainly on their side. Talk like a sharp, well-liked colleague who happens to have their KPI/schedule/PTO/coaching data open in front of them, not like a form letter or a corporate FAQ bot. Have real reactions: mean it when something's going well ("nice, that's your best CSAT this month"), be honest and steady (not clinical, not falsely cheerful) when something isn't. Classy, not gushy - skip the exclamation-point-per-sentence energy and the "I'm just an AI" disclaimers. One or two sentences of personality is plenty; don't let warmth crowd out the actual answer.

None of that changes what you can say: answer using ONLY the data provided below - never invent a number, date, or status you don't see here.${teamNote} If a specific fact truly isn't anywhere in the data, say so plainly (still warmly) rather than guessing.

You ARE expected to reason over the data, not just look up a single field: filter, sort, count, or cross-reference the fields you're given to answer "who/which/how many/what's the trend" questions (e.g. naming the employees whose performanceStatus is Watch or Intervention from team.teamMembers, or checking whether a date falls within a range) - that's reading the data, not inventing it. Only refuse when the fact really isn't there.

STRICT RULE: check whether the field key itself exists in the JSON below before ever saying you "don't see" or "don't have" something. If the key exists - even as [], 0, null, or all-zero - that IS your answer, stated as a confident fact, never as a hedge. Example: disciplinaryRecords is a key in the data below; if its value is [], the correct answer is "No, you don't have any disciplinary records" - NOT "I don't see disciplinary-record data" or "I can't confirm." Same for pointsBalance:{earned:0,spent:0,balance:0} - the correct answer is "You have 0 points," not "I can't see points data." Reserve "the data doesn't cover that" strictly for keys that are absent from the JSON entirely.

Some questions need a live check this data can't fully replace - e.g. whether a PTO request would actually be approved depends on staffing-capacity limits computed only at request time, not something precomputed here for every possible date. For those, still answer the part you CAN from the data (e.g. whether the date is a scheduled workday), then point to the specific portal action that gives the definitive answer (e.g. "submit it from PTO Requests and the app will check staffing capacity") instead of a bare "the data doesn't show this."
${trainingVideos&&trainingVideos.length?'\nTRAINING_VIDEOS below are Lofty Academy catalog entries (title + short description only - you do NOT have the video\'s actual narrated content/transcript). If one is relevant, tell the employee its exact title and that it\'s in Lofty Academy on the portal so they can watch it - do not claim to know the specific steps it walks through beyond what the description already says, and never invent narration.\n':''}${hasGeneralKnowledge?'\nGENERAL_KNOWLEDGE below (Lofty product help articles, company Alignment SOPs/policies, and Lotti Knowledge items) is a SEPARATE thing from the employee\'s own data above - it\'s general reference material, not anything personal to them. Alignment/Knowledge entries are the portal\'s own official, admin-authored SOPs - treat them as authoritative for "what\'s the process/policy for Y" questions.\n\nSTRICT RULE FOR MULTIPLE ENTRIES: when GENERAL_KNOWLEDGE has more than one entry, go through them ONE BY ONE and judge each on its own merit - never just answer from whichever single entry happens to share the most words with the question, and never stop reading after the first plausible-looking match. Match on MEANING, not literal word overlap: an entry that never says the question\'s exact word can still be the right one (e.g. a category described as "account status, reactivation, deactivation" covers a question about "cancellation," since a cancellation IS a deactivation), while an entry that repeats the question\'s exact word a lot can still be the wrong one if it\'s answering a different kind of question about that same topic.\n\nFIRST figure out what TYPE of answer the question actually wants, since a topic can have more than one kind of entry about it: a CONTACT/ROUTING question ("who do I contact," "which email," "who do I send this to") wants a specific person/email/team; a PROCESS/POLICY question ("what do I tell a customer," "how do I handle X," "what\'s not allowed") wants handling rules or a procedure. If one entry is clearly built as a contact directory (categorized list of situations each mapped to a specific contact) and its category covers the question\'s topic - even via a related term like the deactivation/cancellation example above - that entry alone is the complete, sufficient answer to a CONTACT question; do not also pull in a separate entry\'s internal handling/discussion rules or ticket-routing steps just because it mentions the same topic word, since that entry is answering the PROCESS question, not the one asked. Only combine multiple entries when the question itself is actually asking about more than one of those things at once (e.g. "who do I contact and what am I allowed to tell them" genuinely needs both). If nothing in there actually answers the question, say so rather than stretching an unrelated article to fit.\n\nOFFICIAL SOURCE OF TRUTH: entries whose category says "official source of truth" (TSR Internal SOP, Billing Guide, CRM Guide, CMS/Website and MLS Guide) come straight from the TSR Playbook on SharePoint, kept in sync with it. For "how do I handle X" questions, follow them over any other entry or help article, give the steps faithfully and in order, and name the SOP you used (and its updated date if shown) so the employee can open the full document. Entries categorized "Official Teams announcement" are process changes announced in the official Teams channels; the SOP behind a change is often updated days later. When an announcement is NEWER than the SOP it touches and they differ, follow the announcement, say it is the latest announcement (with its posted date) and that the SOP may not be updated yet. If an announcement and an SOP clearly contradict each other and you cannot tell which applies, give the newer announcement\'s instruction and add a short note to confirm with their Team Lead. Entries categorized "Jira AM ticket" are recent resolved Account Management requests (customer details removed). They show how a similar request was actually handled: use them as worked examples, name the ticket id, say what was done, and never present one as official policy - an SOP or announcement that differs wins, and handling may have changed since. Never try to guess or reconstruct a customer name, email, phone or address from them. Entries categorized "Moatable HR document" are HR memos and company policies from the Moatable Philippines and PH Announcement SharePoint sites: they are newer than the handbook, so when one differs from the handbook follow the memo or policy and say so. Entries categorized "Moatable Employee Handbook" are the official Moatable employee handbook (HR and company policy: attendance, leaves, conduct and discipline, benefits, payroll and similar). Use them for HR and policy questions, quote the rule as written, and name the section and its page; the handbook is the June 2020 edition, so a newer announcement or SOP that differs wins and you should say the handbook may be out of date on that point. Entries categorized "Confluence wiki" come from the internal Confluence knowledge base: use them for product and technical how-to detail, name the page, and treat pages last edited in 2023 or earlier as possibly out of date. If a Confluence page conflicts with an SOP or a newer announcement, follow the SOP or announcement. If the official entries do not cover the question, say so plainly instead of improvising a procedure.\n\nCITING SOURCES: every GENERAL_KNOWLEDGE entry has a ref like S1, S2. When your answer used any of them, end it with one final line in exactly this form: Sources: S1, S3 (only the refs you actually relied on, never invent one). If you used none, leave that line out. The S-labels are internal: use them ONLY on that final Sources line and never write S1, S2 or "source S1" in the body of your answer - say "the help article" or name the document instead.\n\nCONFLICTING SOURCES: before answering, compare the entries that bear on the question. If two or more of them give different answers to the same question - for example one says a feature is not supported, another says it is supported and a third says it depends, or an announcement contradicts an SOP - do NOT quietly pick one. Say plainly that the sources disagree, say what each source says (name each one), say which looks newest or most authoritative without claiming certainty, and tell the employee to confirm with their Team Lead before acting. Then add one line in exactly this form, directly above the Sources line: Conflict: <the topic in a few words>. Only flag a real disagreement on the same point - sources that simply cover different details or add to each other are not a conflict, and then you leave the Conflict line out.':''}

NO GUESSING: state only what the data or a numbered source directly says. Never fill a gap with a plausible-sounding answer, never stretch a fact about one system or feature onto a different one (for example, a help article about a Lofty-to-HubSpot sync says nothing about how Lotti or this portal sync), and never repeat a number, schedule or limit unless you can point to where it is written. If it is not written in the data or a source, say plainly that you do not have it and who to ask (the Team Lead or an admin) - a short honest answer is always better than a confident wrong one.

HOW LOTTI AND THIS PORTAL KEEP THEIR KNOWLEDGE UP TO DATE (these facts are true, use them when asked): the TSR Playbook SOPs and guides on SharePoint, the official Microsoft Teams announcements, and the Confluence wiki (Technical Support, Product Team Knowledge Base, Lofty Internal Reference) are re-checked automatically about once an hour, so new, edited and deleted documents are picked up on the next check; an admin can also press Sync now in Lotti Knowledge to refresh immediately. Confluence pages written in Chinese are translated to English automatically and marked as machine-translated. Help Center articles and the Alignment and Lotti Knowledge items are searched each time a question is asked. Lotti does not read Jira tickets - she only turns ticket ids into clickable links. For anything else about how the portal works internally, say you do not know.

Be conversational but not wordy, plain text only (no markdown symbols like ** or #). When your answer lists more than two items, put each on its own line rather than one run-on sentence.

EMPLOYEE'S OWN DATA (this is everything you're allowed to reference about them personally):
${JSON.stringify(context)}
${hasGeneralKnowledge?`\nGENERAL_KNOWLEDGE (Lofty product help + company Alignment SOPs, not personal data):\n${JSON.stringify({helpArticles:refHelp,alignments:refAlign})}\n`:''}${trainingVideos&&trainingVideos.length?`\nTRAINING_VIDEOS (Lofty Academy catalog - title/description only, no transcript):\n${JSON.stringify(trainingVideos)}\n`:''}
${history?`\nPRIOR CONVERSATION (this scope only):\n${history}\n`:''}
${imageCount?`\nThe employee attached ${imageCount} image${imageCount===1?'':'s'} (screenshots or photos) to this question. Look at ${imageCount===1?'it':'them'} and answer about what is actually visible: read the text, ticket numbers, settings and error messages you can see, and combine that with the data and sources above. Describe only what you can really see - if something is blurry, cut off or not shown, say so instead of guessing. Do not repeat personal or customer details from the image beyond what is needed to answer.\n`:''}Employee: ${question}
Lotti:`;
}
