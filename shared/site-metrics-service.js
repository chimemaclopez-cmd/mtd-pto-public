import {api} from './ui-utils.js';

export const getSiteMetrics=(period='')=>api(`/api/my/site-metrics${period?`?period=${encodeURIComponent(period)}`:''}`);
export const getSiteTrainees=()=>api('/api/site-trainees');
