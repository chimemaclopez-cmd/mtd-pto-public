import {scoreSeniorTickets} from '../shared/scoring.js';
export function seniorUpdatedTickets(metric={}){if(metric.sourceReady===false)return{...metric,points:null,status:'Failed'};const unique=Number(metric.unique||0);return{...metric,unique,publicCount:Number(metric.publicCount||0),internalCount:Number(metric.internalCount||0),...scoreSeniorTickets(unique),status:'Ready',formula:`${unique} unique updated tickets`}}

