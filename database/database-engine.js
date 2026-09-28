import {scoreJiraLeadImport,scoreDatabaseCsat,scoreDatabaseCalls,scoreOtherJiraTickets,performanceStatus,resultStatus} from '../shared/scoring.js';
// See nonvoice-monthly-tickets.js's projectToEligiblePeriod() comment - same reasoning: Lead
// Import's bands (40/60/80/100) are an absolute total over the period, not a per-day rate, so a
// Database Agent out on PTO/SL/EL for part of the period gets their raw count projected up to
// what it would have been across every eligible day, at the pace they actually showed on days
// worked - rather than being penalized for days they weren't there at all.
function projectToEligiblePeriod(rawCount,workedDays,eligibleWorkdays){
  if(workedDays==null||eligibleWorkdays==null||workedDays<=0||eligibleWorkdays<=workedDays)return rawCount;
  return rawCount/workedDays*eligibleWorkdays;
}
function databaseJiraLeadImport(metric={},workedDays=null,eligibleWorkdays=null){
  if(metric.sourceReady===false)return{...metric,points:null,status:'Failed'};
  const count=Number(metric.count||0),projected=projectToEligiblePeriod(count,workedDays,eligibleWorkdays),rounded=Math.round(projected);
  const projectedNote=rounded!==count?` (projected to ${rounded} across ${eligibleWorkdays} eligible days, at the pace shown over ${workedDays} days actually worked)`:'';
  return{...metric,count,projected:rounded,...scoreJiraLeadImport(projected),status:'Ready',formula:`${count} Lead Import ticket(s) resolved${projectedNote}`};
}
function databaseCsat(metric={}){if(metric.sourceReady===false)return{...metric,rate:null,points:null,status:'Failed'};const good=Number(metric.good||0),bad=Number(metric.bad||0),valid=good+bad,rate=valid?good/valid*100:null;return{...metric,good,bad,recovered:Number(metric.recovered||0),validSurveyCount:valid,rate,...scoreDatabaseCsat(rate,valid),status:'Ready',formula:valid?`${good} / ${valid} × 100`:'No surveys this period - neutral score applied'}}
// The 2nd param here is presentDayEquivalent (see calculateDatabaseAgent below), despite the
// local name below - kept as "eligibleWorkdays" only because that's this function's own
// pre-existing internal variable name for "whatever day-count denominator was passed in."
function databaseCalls(metric={},eligibleWorkdays){if(metric.sourceReady===false)return{...metric,dailyAverage:null,points:null,status:'Failed'};if(eligibleWorkdays==null)return{...metric,dailyAverage:null,points:null,status:'Missing Attendance'};if(eligibleWorkdays<=0)return{...metric,dailyAverage:null,points:null,status:'No Data'};const accepted=Number(metric.accepted||0),dailyAverage=accepted/eligibleWorkdays;return{...metric,accepted,eligibleWorkdays,dailyAverage,...scoreDatabaseCalls(dailyAverage),status:'Ready',formula:`${accepted} / ${eligibleWorkdays}`}}
function databaseOtherJira(metric={}){if(metric.sourceReady===false)return{...metric,bonus:null,status:'Failed'};const count=Number(metric.count||0),s=scoreOtherJiraTickets(count);return{...metric,count,score:s.score,multiplier:s.multiplier,bonus:s.points,status:'Ready',formula:count?`${count} other Jira ticket(s) handled - flat bonus`:'No other Jira tickets this period'}}
export function calculateDatabaseAgent(employee,attendance,metrics={}){
  const days=attendance?.eligibleWorkdays??null;
  // See voice-engine.js for why the per-day calls average uses presentDayEquivalent instead of
  // eligibleWorkdays (PTO-only exclusion) - eligibleWorkdays itself is untouched below.
  const workedDays=attendance?.presentDayEquivalent??null;
  const jiraLeadImport=databaseJiraLeadImport(metrics.jiraLeadImport,workedDays,days);
  const csat=databaseCsat(metrics.csat);
  const calls=databaseCalls(metrics.calls,workedDays);
  const bonus=databaseOtherJira(metrics.jiraOther);
  const required=[jiraLeadImport,csat,calls];
  const base=required.every(x=>x.points!=null)?required.reduce((s,x)=>s+x.points,0):null;
  const final=base==null?null:base+(bonus.bonus??0);
  const errors=required.filter(x=>['Failed','Missing Attendance'].includes(x.status)).map(x=>x.error||x.status);
  return{
    employeeEmail:employee.employeeEmail,employeeName:employee.employeeName,teamLeadName:employee.teamLeadName,
    kpiType:employee.kpiType,primaryChannel:employee.primaryChannel,eligibleWorkdays:days,
    jiraLeadImport,csat,calls,bonus,baseKpi:base,finalKpi:final,
    performanceStatus:performanceStatus(final),dataStatus:resultStatus(base,bonus.bonus,errors),errors,
    lastUpdated:new Date().toISOString()
  };
}
