import {scoreTickets} from '../shared/scoring.js';
export function nonvoiceMonthlyTickets(metric={}){if(metric.sourceReady===false)return{...metric,points:null,status:'Failed'};const solved=Number(metric.solved||0);return{...metric,solved,excluded:Number(metric.excluded||0),...scoreTickets(solved),status:'Ready',formula:`${solved} unique solved tickets`}}

