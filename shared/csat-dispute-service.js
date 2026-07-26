import {api} from './ui-utils.js';

export const loadMyCsatDisputes=()=>api('/api/my/csat-disputes');
export const createCsatDispute=({ticketId,period,reason})=>api('/api/my/csat-disputes',{method:'POST',body:JSON.stringify({ticketId,period,reason})});
