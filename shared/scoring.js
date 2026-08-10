const band=(score,multiplier,points)=>({score,multiplier,points});
export function scoreCsat(v,weight=40){if(v==null||!Number.isFinite(+v))return null;v=+v;return v>=95?band(5,1,weight):v>=90?band(4,.9,weight*.9):v>=85?band(3,.8,weight*.8):v>=80?band(2,.7,weight*.7):band(1,.6,weight*.6)}
export function scoreVoiceCalls(v){if(v==null||!Number.isFinite(+v))return null;v=+v;return v>=17?band(5,1,40):v>=15?band(4,.9,36):v>=13?band(3,.8,32):v>=11?band(2,.7,28):band(1,.6,24)}
export function scoreLongCallRate(v){if(v==null||!Number.isFinite(+v))return null;v=+v;return v<5?band(5,1,20):v<=6?band(4,.9,18):v<=8?band(3,.8,16):v<=10?band(2,.7,14):band(1,.6,12)}
export function scoreBonus(v,max=5){if(v==null||!Number.isFinite(+v))return null;v=+v;if(v<=0)return band(0,0,0);const mult=v>=4?1:v>=3?.9:v>=2?.8:v>=1?.7:.6;return band(mult===1?5:mult===.9?4:mult===.8?3:mult===.7?2:1,mult,max*mult)}
export function scoreTickets(v,weight=40){if(v==null||!Number.isFinite(+v))return null;v=+v;return v>=250?band(5,1,weight):v>=200?band(4,.9,weight*.9):v>=150?band(3,.8,weight*.8):v>=100?band(2,.7,weight*.7):band(1,.6,weight*.6)}
export function scoreFRT(hours,validUnavailable=false){if(validUnavailable)return band(1,.6,12);if(hours==null||!Number.isFinite(+hours))return null;hours=+hours;return hours<=1?band(5,1,20):hours<=4?band(4,.9,18):hours<=8?band(3,.8,16):hours<=12?band(2,.7,14):band(1,.6,12)}
export function scoreSeniorTeam(v){if(v==null||!Number.isFinite(+v))return null;v=+v;return v>=95?band(5,1,50):v>=90?band(4,.9,45):v>=85?band(3,.8,40):v>=80?band(2,.7,35):band(1,.6,30)}
export function scoreSeniorTickets(v){return scoreTickets(v,50)}
export function scoreJiraLeadImport(v){if(v==null||!Number.isFinite(+v))return null;v=+v;return v>=100?band(5,1,50):v>=80?band(4,.9,45):v>=60?band(3,.8,40):v>=40?band(2,.7,35):band(1,.6,30)}
// CSAT for roles with low survey volume: a genuine <80% rating still scores 1, but zero surveys
// (nothing to judge) applies a flat neutral score (band 3/32 pts, the middle of the 5 tiers)
// instead of penalizing for something out of their control. This must be its own literal band,
// not scoreCsat(80,40) - 80 lands in scoreCsat's ">=80" tier (28 pts), one tier below the
// intended/documented neutral of 32.
export function scoreDatabaseCsat(rate,validSurveyCount){if(!validSurveyCount)return band(3,.8,32);if(rate==null||!Number.isFinite(+rate))return null;const v=+rate;return v>=95?band(5,1,40):v>=90?band(4,.9,36):v>=85?band(3,.8,32):v>=80?band(2,.7,28):band(1,.6,24)}
export function scoreDatabaseCalls(v){if(v==null||!Number.isFinite(+v))return null;v=+v;return v>=4?band(5,1,10):v>=3?band(4,.9,9):v>=2?band(3,.8,8):v>=1?band(2,.7,7):band(1,.6,6)}
export function scoreOtherJiraTickets(count){return count>0?band(1,1,10):band(0,0,0)}
export function resultStatus(base,bonus,errors=[]){if(errors.length)return base==null?'Failed':'Partial';return base==null?'No Data':'Ready'}
export function performanceStatus(value){if(value==null)return 'Not Rated';return value>=95?'Exceptional':value>=90?'Exceeds':value>=85?'Meets':value>=80?'Watch':'Intervention'}
