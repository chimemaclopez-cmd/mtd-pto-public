import {api} from './ui-utils.js';
export const loadAttendance=(month,endDate)=>api(`/api/attendance?month=${encodeURIComponent(month)}&endDate=${encodeURIComponent(endDate)}`);
export const saveAttendance=payload=>api('/api/attendance',{method:'POST',body:JSON.stringify(payload)});
export const loadAttendanceSummary=(month,endDate)=>api(`/api/attendance/summary?month=${encodeURIComponent(month)}&endDate=${encodeURIComponent(endDate)}`);
export const saveAttendanceSummary=payload=>api('/api/attendance/summary',{method:'POST',body:JSON.stringify(payload)});
