import {api} from './ui-utils.js';

export const getMyProfile=()=>api('/api/roster');
export const getMyKpi=()=>api('/api/my/kpi');
export const getMySchedule=(startDate='',endDate='')=>{const query=new URLSearchParams(Object.entries({startDate,endDate}).filter(([,value])=>value));return api(`/api/my/schedule${query.size?`?${query}`:''}`)};
export const getMyAttendance=(month='',endDate='')=>{const query=new URLSearchParams(Object.entries({month,endDate}).filter(([,value])=>value));return api(`/api/my/attendance${query.size?`?${query}`:''}`)};
export const updateMyContact=(payload)=>api('/api/my/contact',{method:'PUT',body:JSON.stringify(payload)});
