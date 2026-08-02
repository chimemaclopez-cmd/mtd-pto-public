import {api} from './ui-utils.js';

export const getMyProfile=()=>api('/api/roster');
export const getMyKpi=(period='')=>api(`/api/my/kpi${period?`?period=${encodeURIComponent(period)}`:''}`);
export const getMySchedule=(startDate='',endDate='')=>{const query=new URLSearchParams(Object.entries({startDate,endDate}).filter(([,value])=>value));return api(`/api/my/schedule${query.size?`?${query}`:''}`)};
export const getMyAttendance=(month='',endDate='')=>{const query=new URLSearchParams(Object.entries({month,endDate}).filter(([,value])=>value));return api(`/api/my/attendance${query.size?`?${query}`:''}`)};
export const updateMyContact=(payload)=>api('/api/my/contact',{method:'PUT',body:JSON.stringify(payload)});
export const getMyStatus=()=>api('/api/my/status');
export const setMyStatus=(activityId)=>api('/api/my/status',{method:'POST',body:JSON.stringify({activityId})});
export const clockInStatus=()=>api('/api/my/status/clock-in',{method:'POST'});
export const clockOutStatus=()=>api('/api/my/status/clock-out',{method:'POST'});
export const getMyNotifications=()=>api('/api/my/notifications');
export const getMyTeamAttendance=(month,endDate)=>api(`/api/my/team-attendance?month=${encodeURIComponent(month)}&endDate=${encodeURIComponent(endDate)}`);
export const saveMyTeamAttendance=(payload)=>api('/api/my/team-attendance',{method:'POST',body:JSON.stringify(payload)});
export const uploadTeamAttendanceAttachment=(payload)=>api('/api/my/team-attendance/attachment',{method:'POST',body:JSON.stringify(payload)});
export const getMyTeamRoster=()=>api('/api/my/team-roster');
export const updateTeamMemberProfile=(payload)=>api('/api/my/team-roster',{method:'PUT',body:JSON.stringify(payload)});
