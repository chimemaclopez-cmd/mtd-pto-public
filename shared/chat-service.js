import {api} from './ui-utils.js';

export const loadChatMessages=()=>api('/api/chat/messages');
export const sendChatMessage=(text)=>api('/api/chat/messages',{method:'POST',body:JSON.stringify({text})});
export const sendChatHeartbeat=()=>api('/api/chat/presence',{method:'POST'});
export const loadChatPresence=()=>api('/api/chat/presence');
