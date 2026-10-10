import {api} from './ui-utils.js';

export const getEodReport=date=>api(`/api/my/eod-report?date=${encodeURIComponent(date)}`);
export const requestEodReport=(date,notes)=>api('/api/my/eod-report',{method:'POST',body:JSON.stringify({date,notes})});
