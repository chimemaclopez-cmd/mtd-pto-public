import {scoreCsat} from '../shared/scoring.js';
export function voiceCsat(metric={}){if(metric.status&&metric.status!=='Ready')return{...metric,points:null};const good=Number(metric.good||0),bad=Number(metric.bad||0),valid=good+bad;if(!valid)return{...metric,validSurveyCount:0,rate:null,points:null,status:'No Data'};const rate=good/valid*100,score=scoreCsat(rate);return{...metric,good,bad,recovered:Number(metric.recovered||0),validSurveyCount:valid,rate,...score,status:'Ready',formula:`${good} / ${valid} × 100`}}

