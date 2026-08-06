import {api} from './ui-utils.js';

export const loadTrainingNewHires=()=>api('/api/training/new-hires');
export const createTrainingNewHire=(payload)=>api('/api/training/new-hires',{method:'POST',body:JSON.stringify(payload)});
export const endorseTrainingNewHire=(employeeEmail,payload)=>api(`/api/training/new-hires/${encodeURIComponent(employeeEmail)}/endorse`,{method:'POST',body:JSON.stringify(payload)});
export const loadTrainingScores=(employeeEmail='')=>api(`/api/training/scores${employeeEmail?`?employeeEmail=${encodeURIComponent(employeeEmail)}`:''}`);
export const createTrainingScore=(payload)=>api('/api/training/scores',{method:'POST',body:JSON.stringify(payload)});
export const deleteTrainingScore=(scoreId)=>api(`/api/training/scores/${encodeURIComponent(scoreId)}`,{method:'DELETE'});
