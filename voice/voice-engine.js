import {voiceCsat} from './voice-csat.js';import {voiceDailyCalls} from './voice-daily-calls.js';import {voiceLongCallRate} from './voice-long-call-rate.js';import {voiceEmailChatBonus} from './voice-email-chat-bonus.js';import {performanceStatus,resultStatus} from '../shared/scoring.js';
export function calculateVoice(employee,attendance,metrics={}){
  const days=attendance?.eligibleWorkdays??null;
  // Per-day averages (Accepted Calls/day, email-chat bonus/day) use presentDayEquivalent, NOT
  // eligibleWorkdays - eligibleWorkdays only excludes PTO (it's the attendance%/reliability
  // denominator, by design), so a rep out on SL/EL would otherwise have their daily average
  // diluted by days they never reported to work at all. presentDayEquivalent already excludes
  // PTO, full SL/EL, and any other absence (with the correct 0.5 credit for a half-day
  // SL-HD/EL-HD), so it's the right denominator for "how much did they do per day worked."
  // eligibleWorkdays itself is left untouched below and still returned/displayed as-is.
  const workedDays=attendance?.presentDayEquivalent??null;
  const csat=voiceCsat(metrics.csat),calls=voiceDailyCalls(metrics.calls,workedDays),lcr=voiceLongCallRate(metrics.calls),bonus=voiceEmailChatBonus(metrics.emailChat,workedDays);const required=[csat,calls,lcr],base=required.every(x=>x.points!=null)?required.reduce((s,x)=>s+x.points,0):null,final=base==null?null:base+(bonus.bonus??0),errors=required.filter(x=>['Failed','Missing Attendance'].includes(x.status)).map(x=>x.error||x.status);return{employeeEmail:employee.employeeEmail,employeeName:employee.employeeName,teamLeadName:employee.teamLeadName,kpiType:employee.kpiType,primaryChannel:employee.primaryChannel,eligibleWorkdays:days,csat,calls,lcr,bonus,baseKpi:base,finalKpi:final,performanceStatus:performanceStatus(final),dataStatus:resultStatus(base,bonus.bonus,errors),errors,lastUpdated:new Date().toISOString()}}

