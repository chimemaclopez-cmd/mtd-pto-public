import {api} from './ui-utils.js';

export const LEARNING_STATUS_LABELS={NOT_STARTED:'Not started',COMPLETED:'Completed'};

export const loadLearningMaterials=()=>api('/api/learning/materials');
export const createLearningMaterial=payload=>api('/api/learning/materials',{method:'POST',body:JSON.stringify(payload)});
export const updateLearningMaterial=(id,payload)=>api(`/api/learning/materials/${encodeURIComponent(id)}`,{method:'PUT',body:JSON.stringify(payload)});
export const deleteLearningMaterial=id=>api(`/api/learning/materials/${encodeURIComponent(id)}`,{method:'DELETE'});
export const markLearningMaterialComplete=id=>api(`/api/learning/materials/${encodeURIComponent(id)}/complete`,{method:'POST'});
export const reorderLearningMaterials=ids=>api('/api/learning/materials/reorder',{method:'POST',body:JSON.stringify({ids})});
export const loadLearningTeamProgress=()=>api('/api/learning/team-progress');
