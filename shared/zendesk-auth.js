import {api} from './ui-utils.js';

const STORAGE_KEY = 'loftyZendeskCredentials:v1';

function savedZendeskCredentials(){
  try{const raw=localStorage.getItem(STORAGE_KEY);return raw?JSON.parse(raw):null}catch{return null}
}

export async function ensureZendeskSession(){
  let session;
  try{session=await api('/api/auth/session')}catch{return null}
  if(session.authenticated)return session;
  const saved=savedZendeskCredentials();
  if(!saved?.subdomain||!saved?.email||!saved?.apiToken)return session;
  try{return await api('/api/auth/login',{method:'POST',body:JSON.stringify(saved)})}catch{return session}
}
