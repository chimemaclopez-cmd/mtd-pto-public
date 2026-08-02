export const BUILTIN_ACTIVITIES=[
  ['CALL','Call','Call','Queue',true,true,true],['CHAT','Chat','Chat','Queue',true,true,true],['EMAIL','Email','Email','Queue',true,true,true],['EMAIL_CHAT','Email / Chat','E/C','Queue',true,true,true],['LEAD_IMPORT','Lead Import','Import','Queue',true,true,true],['SENIOR_TSR','Senior TSR','Sr TSR','Queue',true,true,true],
  ['SHORT_BREAK','Short Break','Break','Break',false,true,false],['LUNCH','Lunch','Lunch','Break',false,true,false],
  ['COACHING','Coaching','Coach','Development',false,true,true],['TRAINING','Training','Train','Development',false,true,true],['TEAM_HUDDLE','Team Huddle','Huddle','Meeting',false,true,true],['ONE_ON_ONE','1:1 Session','1:1','Meeting',false,true,true],['QA_REVIEW','QA Review','QA','Quality',false,true,true],['MEETING','Meeting','Meet','Meeting',false,true,true],['CALIBRATION','Calibration','Cal','Quality',false,true,true],['SIDE_BY_SIDE','Side-by-Side','SxS','Development',false,true,true],['PROJECT_WORK','Project Work','Project','Project',false,true,true],['ADMIN','Admin','Admin','Administrative',false,true,true],['DOCUMENTATION','Documentation','Docs','Administrative',false,true,true],['CASE_REVIEW','Case Review','Case','Quality',false,true,true],['SYSTEM_DOWNTIME','System Downtime','System','System',false,false,false],['OTHER_OFFLINE','Other Offline Task','Other','Other',false,true,false],
  ['OFFLINE','Offline','Offline','Other',false,true,false],['PTO','PTO','PTO','Leave',false,false,false],['RD','RD','RD','Leave',false,false,false]
].map(([id,name,shortLabel,category,queue,includedInAdherence,productive],index)=>({id,name,shortLabel,category,queueClassification:queue?'Queue':'Non-Queue',paid:!['PTO','RD'].includes(id),includedInAdherence,productive,active:true,displayOrder:index+1,builtIn:true,notes:''}));

export const LEGACY_ACTIVITY_IDS={Call:'CALL',Chat:'CHAT',Email:'EMAIL','Email / Chat':'EMAIL_CHAT','Lead Import':'LEAD_IMPORT','Senior TSR':'SENIOR_TSR',Break:'SHORT_BREAK','Short Break':'SHORT_BREAK',Lunch:'LUNCH',Coaching:'COACHING',Training:'TRAINING','Team Huddle':'TEAM_HUDDLE','1:1 Session':'ONE_ON_ONE','QA Review':'QA_REVIEW',Meeting:'MEETING',Calibration:'CALIBRATION','Side-by-Side':'SIDE_BY_SIDE','Project Work':'PROJECT_WORK',Admin:'ADMIN',Documentation:'DOCUMENTATION','Case Review':'CASE_REVIEW','System Downtime':'SYSTEM_DOWNTIME','Other Offline Task':'OTHER_OFFLINE',Offline:'OFFLINE',PTO:'PTO',RD:'RD','':''};
export const normalizeActivityId=value=>{const raw=String(value??'').trim();return LEGACY_ACTIVITY_IDS[raw]??(BUILTIN_ACTIVITIES.some(x=>x.id===raw)?raw:raw)};
export const activityMap=activities=>new Map([...BUILTIN_ACTIVITIES,...(activities||[])].map(x=>[x.id,x]));

export function defaultAssignmentFor(employee,configured=''){
  const kpi=String(employee?.kpiType||'').toLowerCase(),channel=String(employee?.primaryChannel||'').toLowerCase(),status=String(employee?.employmentStatus||'').toLowerCase();
  if(employee?.active===false||kpi.includes('excluded')||status.includes('inactive'))return'';
  if(kpi.includes('trainee')||status.includes('trainee'))return'TRAINING';
  if(kpi.includes('non-voice')){
    if(channel.includes('lead import'))return'LEAD_IMPORT';
    if((channel.includes('email')&&channel.includes('chat'))||channel.includes('email / chat'))return'EMAIL_CHAT';
    if(channel.includes('chat'))return'CHAT';
    if(channel.includes('phone')||channel.includes('voice'))return normalizeActivityId(configured)||'EMAIL';
    if(channel.includes('email'))return'EMAIL';
    return normalizeActivityId(configured)||'EMAIL';
  }
  if(kpi.includes('voice jr'))return'CALL';
  if(kpi.includes('senior'))return'SENIOR_TSR';
  if(kpi.includes('database'))return'LEAD_IMPORT';
  return normalizeActivityId(configured)||'CALL';
}

export const activityGroups=[
  ['Queue Activities',['CALL','CHAT','EMAIL','EMAIL_CHAT','LEAD_IMPORT','SENIOR_TSR']],
  ['Break Activities',['SHORT_BREAK','LUNCH']],
  ['Planned Non-Queue Activities',['COACHING','TRAINING','TEAM_HUDDLE','ONE_ON_ONE','QA_REVIEW','MEETING','CALIBRATION','SIDE_BY_SIDE','PROJECT_WORK','ADMIN','DOCUMENTATION','CASE_REVIEW','SYSTEM_DOWNTIME','OTHER_OFFLINE']],
  ['Unavailable',['OFFLINE','PTO','RD']]
];

const minutesOf=v=>{const[h,m]=String(v).split(':').map(Number);return h*60+m};
const clockOf=m=>{const wrapped=((m%1440)+1440)%1440;return`${String(Math.floor(wrapped/60)).padStart(2,'0')}:${String(wrapped%60).padStart(2,'0')}`};

// Defaults applied only when a day has no exactActivities plotted at all - 15-min break at
// 2h into the shift, 60-min lunch at 4h, second 15-min break at 6h, each skipped if it would
// run past shift end (e.g. a short shift). This is a display-time fallback only - it doesn't
// change stored schedule data, just fills in what most shifts look like when never customized.
const DEFAULT_BREAK_OFFSETS=[
  {offsetMinutes:120,durationMinutes:15,activityId:'SHORT_BREAK'},
  {offsetMinutes:240,durationMinutes:60,activityId:'LUNCH'},
  {offsetMinutes:360,durationMinutes:15,activityId:'SHORT_BREAK'}
];

// Merges the 30-min assignment grid with any finer exactActivities blocks (breaks/lunch)
// into a consolidated, human-readable list of contiguous same-activity time ranges - same
// segment-splice-then-merge approach as zendesk-proxy.js's buildAdherenceBlocks, just without
// the adherence-specific metadata, so both the rep and admin schedule views render one shape.
export function consolidateScheduleBlocks({assignments={},exactBlocks=[],shiftStartEastern,shiftEndEastern,overnight=false,defaultActivityId=''}){
  if(!shiftStartEastern||!shiftEndEastern)return[];
  const shiftStart=minutesOf(shiftStartEastern),shiftEndRaw=minutesOf(shiftEndEastern),shiftEnd=shiftEndRaw+(overnight&&shiftEndRaw<=shiftStart?1440:0);
  let segments=[];
  const normalizedAssignments=Object.fromEntries(Object.entries(assignments).map(([time,value])=>[time,normalizeActivityId(value)]));
  const hasAssignments=Object.values(normalizedAssignments).some(Boolean);
  if(hasAssignments){
    for(const[time,activityId]of Object.entries(normalizedAssignments)){
      if(!activityId&&!defaultActivityId)continue;
      let start=minutesOf(time);
      if(start<shiftStart&&shiftEnd>1440)start+=1440;
      segments.push({start,end:Math.min(start+30,shiftEnd),activityId:activityId||defaultActivityId});
    }
  }else if(defaultActivityId){
    segments.push({start:shiftStart,end:shiftEnd,activityId:normalizeActivityId(defaultActivityId)});
  }
  const effectiveExactBlocks=exactBlocks.length?exactBlocks:DEFAULT_BREAK_OFFSETS
    .filter(b=>shiftStart+b.offsetMinutes+b.durationMinutes<=shiftEnd)
    .map(b=>{const s=shiftStart+b.offsetMinutes;return{activityId:b.activityId,startTime:clockOf(s),endTime:clockOf(s+b.durationMinutes),durationMinutes:b.durationMinutes}});
  for(const exact of effectiveExactBlocks){
    let start=minutesOf(exact.startTime),end=exact.endTime?minutesOf(exact.endTime):start+Number(exact.durationMinutes||0);
    if(start<shiftStart&&shiftEnd>1440)start+=1440;
    if(end<=start)end+=1440;
    for(let index=segments.length-1;index>=0;index--){
      const segment=segments[index];
      if(segment.end<=start||segment.start>=end)continue;
      segments.splice(index,1,...(segment.start<start?[{...segment,end:start}]:[]),...(segment.end>end?[{...segment,start:end}]:[]));
    }
    segments.push({start,end,activityId:normalizeActivityId(exact.activityId)});
  }
  segments=segments.filter(x=>x.activityId&&x.end>x.start).sort((a,b)=>a.start-b.start);
  const merged=[];
  for(const segment of segments){
    const last=merged.at(-1);
    if(last&&last.activityId===segment.activityId&&last.end===segment.start)last.end=segment.end;
    else merged.push({...segment});
  }
  return merged.map(segment=>({startTime:clockOf(segment.start),endTime:clockOf(segment.end),activityId:segment.activityId,spansMidnight:segment.end>1440}));
}

export function formatTimeRangeLabel(startTime,endTime){
  const to12=value=>{const[h,m]=String(value).split(':').map(Number),hour12=h%12||12;return m?`${hour12}:${String(m).padStart(2,'0')}`:`${hour12}:00`},
    endHour=Number(String(endTime).split(':')[0])%24;
  return`${to12(startTime)}–${to12(endTime)} ${endHour>=12?'PM':'AM'}`;
}
