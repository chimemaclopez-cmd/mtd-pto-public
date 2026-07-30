import {scoreFRT} from '../shared/scoring.js';
export function nonvoiceFirstReply(metric={}){if(metric.sourceReady===false)return{...metric,points:null,status:'Failed'};const count=Number(metric.qualifyingCount||0);if(!count&&metric.validUnavailable!==true)return{...metric,points:null,status:'No Data'};const hours=metric.averageMinutes==null?null:Number(metric.averageMinutes)/60,s=scoreFRT(hours,metric.validUnavailable===true);return{...metric,qualifyingCount:count,hours,...s,status:'Ready',formula:count?`${metric.averageMinutes} average minutes`:'Validly unavailable'}}

