import {scoreTickets} from '../shared/scoring.js';
// scoreTickets' bands (100/150/200/250) are calibrated as a full eligible period's worth of
// tickets, with no day-based normalization of their own - a raw solved count compared straight
// against those bands silently penalizes anyone who was out on PTO/SL/EL for part of the
// period, the same problem the calls-per-day metrics had. Since these bands are absolute
// monthly totals (not a per-day rate), the fix isn't dividing by days worked like the calls
// metrics - it's projecting: "at the pace they solved tickets on the days they actually worked,
// what would their total have been across every eligible day this period?" That projected
// number is what gets scored against the existing bands; the real raw count is still shown.
function projectToEligiblePeriod(rawCount,workedDays,eligibleWorkdays){
  if(workedDays==null||eligibleWorkdays==null||workedDays<=0||eligibleWorkdays<=workedDays)return rawCount;
  return rawCount/workedDays*eligibleWorkdays;
}
export function nonvoiceMonthlyTickets(metric={},workedDays=null,eligibleWorkdays=null){
  if(metric.sourceReady===false)return{...metric,points:null,status:'Failed'};
  const solved=Number(metric.solved||0),projected=projectToEligiblePeriod(solved,workedDays,eligibleWorkdays),rounded=Math.round(projected);
  const projectedNote=rounded!==solved?` (projected to ${rounded} across ${eligibleWorkdays} eligible days, at the pace shown over ${workedDays} days actually worked)`:'';
  return{...metric,solved,excluded:Number(metric.excluded||0),projected:rounded,...scoreTickets(projected),status:'Ready',formula:`${solved} unique solved tickets${projectedNote}`};
}

