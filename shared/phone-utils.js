const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export const COUNTRY_CODES=[['+63','Philippines'],['+1','US/Canada'],['+44','UK'],['+61','Australia'],['+65','Singapore'],['+852','Hong Kong'],['+971','UAE'],['+966','Saudi Arabia'],['+81','Japan'],['+91','India']];

export function populatePhoneCodeSelect(select){if(!select||select.options.length)return;select.innerHTML=COUNTRY_CODES.map(([code,name])=>`<option value="${code}">${code} ${esc(name)}</option>`).join('')}

export function formatPhoneLocal(raw){const digits=String(raw||'').replace(/\D/g,'').slice(0,10);return[digits.slice(0,3),digits.slice(3,6),digits.slice(6,10)].filter(Boolean).join(' ')}

export function parsePhoneNumber(full){const value=String(full||'').trim();if(!value)return{code:'+63',local:''};const match=COUNTRY_CODES.map(([code])=>code).sort((a,b)=>b.length-a.length).find(code=>value.startsWith(code));if(match)return{code:match,local:formatPhoneLocal(value.slice(match.length))};return{code:'+63',local:formatPhoneLocal(value)}}

export function combinePhoneNumber(code,local){return local?`${code} ${local}`:''}
