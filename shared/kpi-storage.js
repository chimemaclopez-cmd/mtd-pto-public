import {api} from './ui-utils.js';
export const loadResults=(month,endDate)=>api(`/api/mtd-kpi/results?month=${month}&endDate=${endDate}`);
export const loadResultsByMonth=month=>api(`/api/mtd-kpi/results/by-month?month=${month}`);
export const saveResults=payload=>api('/api/mtd-kpi/results',{method:'POST',body:JSON.stringify(payload)});
export const recalculate=(month,endDate)=>api('/api/mtd-kpi/recalculate',{method:'POST',body:JSON.stringify({month,endDate})});

