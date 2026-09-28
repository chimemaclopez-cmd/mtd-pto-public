import {scoreSeniorTickets} from '../shared/scoring.js';
// See nonvoice-monthly-tickets.js's projectToEligiblePeriod() comment - same reasoning applies
// here: scoreSeniorTickets' bands are an absolute-total-over-the-period threshold, not a
// per-day rate, so a Senior out on PTO/SL/EL for part of the period gets their raw count
// projected up to what it would have been across every eligible day, at the pace they actually
// showed on days worked - rather than being penalized for days they weren't there at all.
function projectToEligiblePeriod(rawCount,workedDays,eligibleWorkdays){
  if(workedDays==null||eligibleWorkdays==null||workedDays<=0||eligibleWorkdays<=workedDays)return rawCount;
  return rawCount/workedDays*eligibleWorkdays;
}
export function seniorUpdatedTickets(metric={},workedDays=null,eligibleWorkdays=null){
  if(metric.sourceReady===false)return{...metric,points:null,status:'Failed'};
  const unique=Number(metric.unique||0),projected=projectToEligiblePeriod(unique,workedDays,eligibleWorkdays),rounded=Math.round(projected);
  const projectedNote=rounded!==unique?` (projected to ${rounded} across ${eligibleWorkdays} eligible days, at the pace shown over ${workedDays} days actually worked)`:'';
  return{...metric,unique,publicCount:Number(metric.publicCount||0),internalCount:Number(metric.internalCount||0),projected:rounded,...scoreSeniorTickets(projected),status:'Ready',formula:`${unique} unique updated tickets${projectedNote}`};
}

