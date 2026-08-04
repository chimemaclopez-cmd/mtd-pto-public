import {scoreCsat} from '../shared/scoring.js';
// Zero surveys this period (nothing to judge) defaults to a scored 80% rather than penalizing
// for something out of the rep's control - this also matters beyond just the CSAT component:
// calculateVoice/calculateNonVoice treat csat as required, so a null points value here used to
// make the rep's ENTIRE KPI unratable for the period, not just their CSAT line.
export function voiceCsat(metric={}){if(metric.status&&metric.status!=='Ready')return{...metric,points:null};const good=Number(metric.good||0),bad=Number(metric.bad||0),valid=good+bad;if(!valid)return{...metric,validSurveyCount:0,rate:null,recovered:Number(metric.recovered||0),...scoreCsat(80),status:'Ready',formula:'No surveys this period - default 80% score applied'};const rate=good/valid*100,score=scoreCsat(rate);return{...metric,good,bad,recovered:Number(metric.recovered||0),validSurveyCount:valid,rate,...score,status:'Ready',formula:`${good} / ${valid} × 100`}}

