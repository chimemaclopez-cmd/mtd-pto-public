import {api} from './ui-utils.js';

export const loadAnnouncements=()=>api('/api/announcements');
export const createAnnouncement=(payload)=>api('/api/announcements',{method:'POST',body:JSON.stringify(payload)});
export const updateAnnouncement=(id,payload)=>api(`/api/announcements/${encodeURIComponent(id)}`,{method:'PUT',body:JSON.stringify(payload)});
export const deleteAnnouncement=(id)=>api(`/api/announcements/${encodeURIComponent(id)}`,{method:'DELETE'});
export const loadMyAnnouncements=()=>api('/api/my/announcements');
export const createMyAnnouncement=(payload)=>api('/api/my/announcements',{method:'POST',body:JSON.stringify(payload)});
export const updateMyAnnouncement=(id,payload)=>api(`/api/my/announcements/${encodeURIComponent(id)}`,{method:'PUT',body:JSON.stringify(payload)});
export const deleteMyAnnouncement=(id)=>api(`/api/my/announcements/${encodeURIComponent(id)}`,{method:'DELETE'});
