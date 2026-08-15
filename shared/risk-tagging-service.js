// Shared AI ticket risk-tagging: one prompt/parse contract, reused by both DSAT Review and
// Service Recovery, so this stays a single Copilot integration (not two parallel ones) and both
// queues show the same sentiment/risk/patience/evidence shape. The actual Copilot HTTP call
// itself lives in qa-dsat-service.js (copilotChat/copilotResponseText) - this module only builds
// the prompt, parses the reply, and derives the per-employee composite score on top of it.

export const SENTIMENT_LABELS = ['Angry', 'Frustrated', 'Calm'];
export const RISK_LABELS = ['high_risk', 'critical', 'none'];

export function buildRiskTaggingPrompt({ subject, comment }) {
  return `You are triaging a customer support interaction for risk. Reply with ONLY a JSON object, no other text and no markdown formatting, in exactly this shape: {"sentiment":"Angry|Frustrated|Calm","risk":"high_risk|critical|none","patience":0-100,"evidence":"a short quote from the ticket text backing these labels"}.

"patience" reflects how much the customer's patience appears to be wearing thin (0 = completely out of patience, 100 = fully patient) - score it from the tone and content below, it does not need to match any external system.
"evidence" must be an actual short excerpt from the ticket text below (not a paraphrase) that best justifies the sentiment/risk you chose.

Ticket subject: ${subject || '(none)'}
Ticket text: ${comment || '(no comment left)'}`;
}

// Copilot is asked for exactly this JSON shape but is still a free-text model underneath -
// validate every field rather than trusting the reply, same caution mbr-report.js's
// stringBullets/stringField already apply to Groq's output.
export function parseRiskTaggingResponse(raw) {
  let parsed;
  try { parsed = JSON.parse(String(raw || '').match(/\{[\s\S]*\}/)?.[0] || raw); }
  catch { parsed = {}; }
  const sentiment = SENTIMENT_LABELS.includes(parsed.sentiment) ? parsed.sentiment : 'Unknown';
  const risk = RISK_LABELS.includes(parsed.risk) ? parsed.risk : 'none';
  const patienceNum = Number(parsed.patience);
  const patience = Number.isFinite(patienceNum) ? Math.max(0, Math.min(100, Math.round(patienceNum))) : null;
  const evidence = typeof parsed.evidence === 'string' ? parsed.evidence.trim().slice(0, 300) : '';
  return { sentiment, risk, patience, evidence };
}

// Reverse-engineered from TSR Workbench's own Risk Customers panel, confirmed exact for the two
// sub-scores below; the final blend is a best-guess approximation (Workbench doesn't expose its
// real weighting) - TUNABLE, adjust these three constants once real data suggests a better mix.
export const RISK_SCORE_WEIGHTS = { tags: 0.5, volume: 0.3, lowPatience: 0.2 };
const LOW_PATIENCE_THRESHOLD = 50;

// tickets: array of {sentiment, risk, patience} already-tagged tickets for ONE employee (or one
// customer, if this ever gets keyed that way instead) within whatever window the caller scoped -
// this function doesn't fetch or filter by date itself, it just scores what it's handed.
export function computeCompositeRiskScore(tickets) {
  const tagged = (tickets || []).filter(Boolean);
  const angryCount = tagged.filter(t => t.sentiment === 'Angry').length;
  const highRiskCount = tagged.filter(t => t.risk === 'high_risk' || t.risk === 'critical').length;
  const activeCount = tagged.length;
  const lowPatienceCount = tagged.filter(t => t.patience != null && t.patience < LOW_PATIENCE_THRESHOLD).length;

  const tagsScore = Math.min(1, (angryCount + highRiskCount) * 0.2);
  const volumeScore = Math.min(1, activeCount * 0.1);
  const lowPatienceScore = Math.min(1, lowPatienceCount / 3);
  const composite = Math.round(100 * (
    RISK_SCORE_WEIGHTS.tags * tagsScore +
    RISK_SCORE_WEIGHTS.volume * volumeScore +
    RISK_SCORE_WEIGHTS.lowPatience * lowPatienceScore
  ));
  return { composite, angryCount, highRiskCount, activeCount, lowPatienceCount, tagsScore, volumeScore, lowPatienceScore };
}

// Draft-reply text is copy-to-clipboard only in this portal - there is no "send" action anywhere
// here (no Zendesk write access from the browser), so a suggested reply can never be auto-sent
// by construction, not merely by policy. The rep reviews, edits, and pastes it into Zendesk
// themselves.
export function buildDraftReplyPrompt({ subject, comment, employeeName }) {
  return `You are helping a support team member draft a reply to a customer for a support ticket. Write ONLY the reply text itself - no preamble, no markdown, no explanation, just the message a human would send. Keep it warm, specific to the complaint below, and professional. Sign off as "The Lofty Support Team" (not any one person's name - a human will review and personalize this before sending).

Ticket subject: ${subject || '(none)'}
Customer's message: ${comment || '(no comment left)'}${employeeName ? `\nHandling rep: ${employeeName}` : ''}`;
}
