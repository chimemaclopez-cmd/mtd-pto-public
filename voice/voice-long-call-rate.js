import {scoreLongCallRate} from '../shared/scoring.js';
export function voiceLongCallRate(metric={}){const accepted=Number(metric.accepted||0),longCalls=Number(metric.longCalls||0);if(!accepted)return{...metric,accepted,longCalls,rate:null,points:null,status:metric.sourceReady===false?'Failed':'No Data'};const rate=longCalls/accepted*100;return{...metric,accepted,longCalls,rate,...scoreLongCallRate(rate),status:'Ready',formula:`${longCalls} / ${accepted} × 100`}}

