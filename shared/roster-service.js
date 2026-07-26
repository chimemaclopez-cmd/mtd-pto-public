import {api} from './ui-utils.js';
export const loadRoster=()=>api('/api/roster');
export const loadRosterHistory=()=>api('/api/roster/history');
export const saveEmployee=(employee,existingEmail='')=>api(existingEmail?`/api/roster/${encodeURIComponent(existingEmail)}`:'/api/roster',{method:existingEmail?'PUT':'POST',body:JSON.stringify(employee)});
export const deleteEmployee=email=>api(`/api/roster/${encodeURIComponent(email)}`,{method:'DELETE'});
export const rosterForMonth=(month,endDate)=>api(`/api/roster/by-month?month=${encodeURIComponent(month)}&endDate=${encodeURIComponent(endDate)}`);
export const resetPassword=(employeeEmail,temporaryPassword)=>api('/api/pto/admin/reset-password',{method:'POST',body:JSON.stringify({employeeEmail,temporaryPassword,role:'ADMINISTRATOR',user:'Local administrator'})});
export const resetTour=employeeEmail=>api('/api/pto/admin/reset-tour',{method:'POST',body:JSON.stringify({employeeEmail,role:'ADMINISTRATOR'})});
export const resetTourForAll=()=>api('/api/pto/admin/reset-tour',{method:'POST',body:JSON.stringify({resetAll:true,role:'ADMINISTRATOR'})});

