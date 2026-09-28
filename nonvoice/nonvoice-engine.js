import {nonvoiceCsat} from './nonvoice-csat.js';import {nonvoiceMonthlyTickets} from './nonvoice-monthly-tickets.js';import {nonvoiceFirstReply} from './nonvoice-first-reply.js';import {nonvoiceCallsBonus} from './nonvoice-calls-bonus.js';import {performanceStatus,resultStatus} from '../shared/scoring.js';
export function calculateNonVoice(employee,attendance,metrics={}){
  const days=attendance?.eligibleWorkdays??null;
  // See voice-engine.js for why the bonus per-day average uses presentDayEquivalent instead of
  // eligibleWorkdays (PTO-only exclusion) - eligibleWorkdays itself is untouched below.
  const workedDays=attendance?.presentDayEquivalent??null;
  const csat=nonvoiceCsat(metrics.csat),tickets=nonvoiceMonthlyTickets(metrics.tickets,workedDays,days),frt=nonvoiceFirstReply(metrics.frt),bonus=nonvoiceCallsBonus(metrics.calls,workedDays),required=[csat,tickets,frt],base=required.every(x=>x.points!=null)?required.reduce((s,x)=>s+x.points,0):null,final=base==null?null:base+(bonus.bonus??0),errors=required.filter(x=>x.status==='Failed').map(x=>x.error||x.status);return{employeeEmail:employee.employeeEmail,employeeName:employee.employeeName,teamLeadName:employee.teamLeadName,kpiType:employee.kpiType,primaryChannel:employee.primaryChannel,eligibleWorkdays:days,workedDays,csat,tickets,frt,bonus,baseKpi:base,finalKpi:final,performanceStatus:performanceStatus(final),dataStatus:resultStatus(base,bonus.bonus,errors),errors,lastUpdated:new Date().toISOString()}}

