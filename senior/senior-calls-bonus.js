import {scoreBonus} from '../shared/scoring.js';
export function seniorCallsBonus(metric={},eligibleWorkdays){if(eligibleWorkdays==null)return{...metric,bonus:null,status:'Missing Attendance'};if(eligibleWorkdays<=0)return{...metric,bonus:null,status:'No Data'};const accepted=Number(metric.accepted||0),dailyAverage=accepted/eligibleWorkdays,s=scoreBonus(dailyAverage,10);return{...metric,accepted,eligibleWorkdays,dailyAverage,score:s.score,multiplier:s.multiplier,bonus:s.points,status:'Ready',formula:`${accepted} / ${eligibleWorkdays}`}}

