import {scoreJiraLeadImport,scoreDatabaseCsat,scoreDatabaseCalls,scoreOtherJiraTickets,performanceStatus,resultStatus} from '../shared/scoring.js';
function databaseJiraLeadImport(metric={}){if(metric.sourceReady===false)return{...metric,points:null,status:'Failed'};const count=Number(metric.count||0);return{...metric,count,...scoreJiraLeadImport(count),status:'Ready',formula:`${count} Lead Import ticket(s) resolved`}}
function databaseCsat(metric={}){if(metric.sourceReady===false)return{...metric,rate:null,points:null,status:'Failed'};const good=Number(metric.good||0),bad=Number(metric.bad||0),valid=good+bad,rate=valid?good/valid*100:null;return{...metric,good,bad,recovered:Number(metric.recovered||0),validSurveyCount:valid,rate,...scoreDatabaseCsat(rate,valid),status:'Ready',formula:valid?`${good} / ${valid} × 100`:'No surveys this period - neutral score applied'}}
function databaseCalls(metric={},eligibleWorkdays){if(eligibleWorkdays==null)return{...metric,dailyAverage:null,points:null,status:'Missing Attendance'};if(eligibleWorkdays<=0)return{...metric,dailyAverage:null,points:null,status:'No Data'};const accepted=Number(metric.accepted||0),dailyAverage=accepted/eligibleWorkdays;return{...metric,accepted,eligibleWorkdays,dailyAverage,...scoreDatabaseCalls(dailyAverage),status:'Ready',formula:`${accepted} / ${eligibleWorkdays}`}}
function databaseOtherJira(metric={}){if(metric.sourceReady===false)return{...metric,bonus:null,status:'Failed'};const count=Number(metric.count||0),s=scoreOtherJiraTickets(count);return{...metric,count,score:s.score,multiplier:s.multiplier,bonus:s.points,status:'Ready',formula:count?`${count} other Jira ticket(s) handled - flat bonus`:'No other Jira tickets this period'}}
export function calculateDatabaseAgent(employee,attendance,metrics={}){
  const days=attendance?.eligibleWorkdays??null;
  const jiraLeadImport=databaseJiraLeadImport(metrics.jiraLeadImport);
  const csat=databaseCsat(metrics.csat);
  const calls=databaseCalls(metrics.calls,days);
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
