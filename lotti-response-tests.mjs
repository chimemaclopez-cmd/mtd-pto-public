import assert from 'node:assert/strict';
import fs from 'node:fs';
import {buildLoftIqSearchQuery,buildLoftIqPrompt,hasInvalidLoftIqSourceRefs,isLoftIqBadAnswer} from './shared/loftiq-service.js';

const prior=[{role:'user',content:'How do I cancel a website add-on?'},{role:'assistant',content:'An unverified previous answer about payroll.'}];
assert.match(buildLoftIqSearchQuery('Who should handle that?',prior),/website add-on/);
assert.match(buildLoftIqSearchQuery('What about annual plans?',prior),/website add-on/);
assert.equal(buildLoftIqSearchQuery('Why did my KPI drop?',prior),'Why did my KPI drop?');
assert.equal(buildLoftIqSearchQuery('How do I reset a password?',prior),'How do I reset a password?');
assert.equal(buildLoftIqSearchQuery('What about annual plans?',[]),'What about annual plans?');
assert.ok(buildLoftIqSearchQuery('What about that?', [{role:'user',content:'x'.repeat(5000)}]).length<=320);
assert.equal(hasInvalidLoftIqSourceRefs('Use the current SOP.\nSources: S1, S2',2),false);
assert.equal(hasInvalidLoftIqSourceRefs('Use the current SOP.\nSources: S1, S4',2),true);
assert.equal(hasInvalidLoftIqSourceRefs('Sources: S0',2),true);
assert.equal(hasInvalidLoftIqSourceRefs('Answer.\nSources: S99\nConflict: example',2),true);
assert.equal(hasInvalidLoftIqSourceRefs('Sources: S1',0),true);
assert.equal(hasInvalidLoftIqSourceRefs('Your points balance is 0.',0),false);
assert.equal(isLoftIqBadAnswer('You have 0 points in the current snapshot.'),false);
assert.equal(isLoftIqBadAnswer('No disciplinary records appear in the current snapshot.'),false);

const prompt=buildLoftIqPrompt({context:{teamAverage:null,pointsBalance:{balance:0},disciplinaryRecords:[]},priorMessages:prior,question:'What is my team average?',helpArticles:[{title:'Help',ref:'S999'}],alignments:[{title:'SOP',ref:'S999'}],unavailableSources:['Confluence']});
assert.match(prompt,/null value, empty string, absent key or unavailable source means the fact is unknown/);
assert.match(prompt,/Numeric 0 and boolean false are valid results/);
assert.match(prompt,/could not be checked on this request: \["Confluence"\]/);
assert.match(prompt,/modification date alone does not prove a rule supersedes/);
assert.doesNotMatch(prompt,/give the newer announcement's instruction/);
assert.match(prompt,/previous assistant answer or a user's claim is not verified policy/);
assert.match(prompt,/never infer a remaining leave balance/i);
const knowledge=JSON.parse(prompt.split('GENERAL_KNOWLEDGE (Lofty product help + company Alignment SOPs, not personal data):\n')[1].split('\n')[0]);
assert.equal(knowledge.helpArticles[0].ref,'S1');assert.equal(knowledge.alignments[0].ref,'S2');

// Exercise the actual knowledge-search handler with failed and empty libraries.
const server=fs.readFileSync(new URL('./pto-public-server.js',import.meta.url),'utf8');
const start=server.indexOf("    if (parsed.pathname === '/api/my/loftiq/knowledge-search'");
const end=server.indexOf('    // The handbook for the Company',start);
const block=server.slice(start,end);
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const names=['parsed','req','res','json','loadLottiKnowledge','loadLottiSopRecords','loadLottiAnnouncements','stripArticleHtml','keywordSearchRecords','searchSopRecords','searchConfluence','searchHandbook','searchHrDocs','searchJiraAm'];
const run=new AsyncFunction(...names,block);
const empty=async()=>[],fail=async()=>{throw new Error('Test source unavailable')};
const result=await run({pathname:'/api/my/loftiq/knowledge-search',searchParams:new URLSearchParams({q:'domain transfer'})},{method:'GET'},{},(_res,status,body)=>({status,...body}),empty,empty,empty,x=>x,()=>[],()=>[],fail,empty,fail,empty);
assert.equal(result.status,200);assert.deepEqual(result.items,[]);assert.deepEqual(result.unavailableSources.sort(),['Confluence','HR documents']);
const healthy=await run({pathname:'/api/my/loftiq/knowledge-search',searchParams:new URLSearchParams({q:'domain transfer'})},{method:'GET'},{},(_res,status,body)=>({status,...body}),empty,empty,empty,x=>x,()=>[],()=>[],empty,empty,empty,empty);
assert.deepEqual(healthy.unavailableSources,[]);
console.log('Lotti response and source-failure checks passed.');

// Official Help Center provenance and passage retrieval.
const {articleText,buildHelpArticleSources}=await import('./server/help-center.js');
assert.equal(articleText('<p>Step 1 &amp; Step 2</p><script>ignore this</script><p>&#39;Save&#39;</p>'),"Step 1 & Step 2\n'Save'");
const article={title:'Smart Plan setup',html_url:'https://help.lofty.com/hc/en-us/articles/123-Smart-Plan',updated_at:'2026-10-01T12:00:00Z',body:'<p>Official introduction.</p>'+('<p>General background text. </p>'.repeat(500))+'<p>Smart Plan enrollment requires the account admin.</p>'};
const help=buildHelpArticleSources([article,{...article,html_url:'https://example.com/article'},{...article,draft:true}],'Smart Plan enrollment');
assert.equal(help.length,1);assert.equal(help[0].updatedAt,article.updated_at);assert.equal(help[0].excerpted,true);assert.ok(help[0].snippet.length<=6000);assert.match(help[0].snippet,/Smart Plan enrollment requires the account admin/);assert.match(help[0].category,/official product source of truth/);
const helpPrompt=buildLoftIqPrompt({question:'How do I enroll?',helpArticles:help});
assert.match(helpPrompt,/LOFTY HELP CENTER — OFFICIAL PRODUCT SOURCE OF TRUTH/);assert.match(helpPrompt,/Distinguish Lofty AOS from Lofty Classic/);assert.match(helpPrompt,/Company-specific approvals/);
console.log('Official Help Center provenance and retrieval checks passed.');
