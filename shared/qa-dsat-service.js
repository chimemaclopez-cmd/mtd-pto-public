import {api} from './ui-utils.js';

export const getDsatReview=(period='')=>api(`/api/qa/dsat-review${period?`?period=${encodeURIComponent(period)}`:''}`);
export const decideDsatTicket=(payload)=>api('/api/qa/dsat-review/decide',{method:'POST',body:JSON.stringify(payload)});
export const requestDsatRefresh=(period='')=>api('/api/qa/dsat-review/refresh',{method:'POST',body:JSON.stringify({period})});
