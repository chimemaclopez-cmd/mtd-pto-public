import {api} from './ui-utils.js';

export const getPointsLeaderboard=(month='')=>api(`/api/points/leaderboard${month?`?month=${encodeURIComponent(month)}`:''}`);
export const getRewardCatalog=()=>api('/api/rewards/catalog');
export const createReward=(payload)=>api('/api/rewards/catalog',{method:'POST',body:JSON.stringify(payload)});
export const updateReward=(id,payload)=>api(`/api/rewards/catalog/${encodeURIComponent(id)}`,{method:'PUT',body:JSON.stringify(payload)});
export const deleteReward=(id)=>api(`/api/rewards/catalog/${encodeURIComponent(id)}`,{method:'DELETE'});
export const redeemReward=(rewardId)=>api('/api/rewards/redeem',{method:'POST',body:JSON.stringify({rewardId})});
export const getMyRedemptions=()=>api('/api/rewards/my-redemptions');
export const getAllRedemptions=()=>api('/api/rewards/redemptions');
export const decideRedemption=(id,payload)=>api(`/api/rewards/redemptions/${encodeURIComponent(id)}/decide`,{method:'POST',body:JSON.stringify(payload)});
