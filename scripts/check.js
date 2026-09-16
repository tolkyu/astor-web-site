import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
async function files(dir) { const entries=await readdir(dir,{withFileTypes:true}); return (await Promise.all(entries.map(e=>e.isDirectory()?files(dir+'/'+e.name):dir+'/'+e.name))).flat(); }
const targets=(await Promise.all(['server','api','public','scripts','tests'].map(files))).flat().filter(f=>f.endsWith('.js'));
for(const file of targets){const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});if(result.status!==0){process.stderr.write(result.stderr);process.exit(1);}}
for(const file of ['server/templates/page.html','server/templates/admin.html']){
 const html=await readFile(file,'utf8');
 assert(!/<style[\s>]|\sstyle=|\son\w+=/i.test(html),file+': inline CSS/handlers');
 for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g))assert(/src=|application\/ld\+json/.test(match[1]),file+': inline script');
 const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);assert.equal(new Set(ids).size,ids.length,file+': duplicate id');
}
const vercel=JSON.parse(await readFile('vercel.json','utf8'));assert.equal(vercel.outputDirectory,'public');
const exposed=await files('public');assert(exposed.every(f=>!/(^|\/)(data|server|node_modules|\.env)(\/|$)/.test(f)));
console.log('Syntax, template and public-directory checks passed ('+targets.length+' JS files).');
