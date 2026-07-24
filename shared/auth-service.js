import {api} from './ui-utils.js';

export const getSession=()=>api('/api/auth/session');
export const login=(email,password)=>api('/api/auth/login',{method:'POST',body:JSON.stringify({email,password})});
export const logout=()=>api('/api/auth/logout',{method:'POST'});
export const changePassword=(currentPassword,newPassword)=>api('/api/auth/change-password',{method:'POST',body:JSON.stringify({currentPassword,newPassword})});
