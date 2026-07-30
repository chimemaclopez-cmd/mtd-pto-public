import {api} from './ui-utils.js';
export const cacheStatus=(month,endDate)=>api(`/api/mtd-cache/status?month=${month}&endDate=${endDate}`);
export const refreshCache=(dataset,month,endDate)=>api('/api/mtd-cache/refresh',{method:'POST',body:JSON.stringify({dataset,month,endDate})});
export const startBackgroundRefresh=(dataset,month,endDate)=>api('/api/mtd-cache/refresh',{method:'POST',body:JSON.stringify({dataset,month,endDate,background:true})});
export const readCache=(dataset,month,endDate)=>api(`/api/mtd-cache/${encodeURIComponent(dataset)}?month=${month}&endDate=${endDate}`);
export const refreshProgress=(dataset,month,endDate)=>api(`/api/mtd-cache/progress?dataset=${dataset}&month=${month}&endDate=${endDate}`);
export const loadAutoRefreshConfig=()=>api('/api/mtd-cache/auto-refresh');
export const saveAutoRefreshConfig=(intervalMinutes,month,endDate)=>api('/api/mtd-cache/auto-refresh',{method:'POST',body:JSON.stringify({enabled:Number(intervalMinutes)>0,intervalMinutes:Number(intervalMinutes),month,endDate})});
