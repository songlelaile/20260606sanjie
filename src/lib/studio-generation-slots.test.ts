import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const source=readFileSync(resolve('public/creative/labs/image-prompt-lab/studio-genesis-ui.js'),'utf8');

describe('shared studio browser concurrency slots',()=>{
  it('reads and clears an exact concurrent receipt without clearing another job or workspace',()=>{
    const local=new Map<string,string>(),account='same-owner',scope='single:main';
    const storage={get length(){return local.size;},key:(index:number)=>[...local.keys()][index]||null,getItem:(key:string)=>local.get(key)??null,
      setItem:(key:string,value:string)=>local.set(key,value),removeItem:(key:string)=>local.delete(key)};
    const context=createContext({localStorage:storage,account,environment:'',workspaceScope:scope});
    const start=source.indexOf('  function journal()'),end=source.indexOf('  // Shared browser slots',start);
    runInContext(source.slice(start,end),context);
    const journal=context.journal(),receipt={jobId:'one',accountKey:account,taskId:'task',shotId:'shot-1',batchId:'batch',createdAt:100},other={...receipt,jobId:'two',shotId:'shot-2'};
    journal.write(receipt);journal.write(other);
    const foreignKey=`sz_studio_genesis_pending_v2:${account}:single:detail:foreign`;
    local.set(foreignKey,JSON.stringify({...receipt,jobId:'foreign'}));
    expect(journal.readExcluding(['one'])).toEqual(other);expect(journal.readReceipt(other)).toEqual(other);
    expect(journal.compareAndClear({...other,taskId:'changed'})).toBe(false);expect(local.size).toBe(3);
    expect(journal.compareAndClear(other)).toBe(true);expect(journal.readReceipt(other)).toBeNull();expect(journal.read()).toEqual(receipt);
    expect(journal.compareAndClear(receipt)).toBe(true);expect(journal.read()).toBeNull();expect(local.has(foreignKey)).toBe(true);
  });
  it('caps two workspaces at 100 live requests and keeps a slot until its provider reply',async()=>{
    const held=new Set<string>();
    const locks={request:async(name:string,_options:unknown,callback:(lock:unknown)=>Promise<unknown>)=>{
      if(held.has(name))return callback(null);
      held.add(name);try{return await callback({name});}finally{held.delete(name);}
    }};
    const makeClient=()=>{
      const context=createContext({navigator:{locks},environment:'',ensureAccount:async()=>{},setTimeout});
      const start=source.indexOf('  async function withGenerationSlot('),end=source.indexOf('  async function persist',start);
      runInContext(source.slice(start,end),context);return context.withGenerationSlot;
    };
    const clients=[makeClient(),makeClient()],releases:Array<()=>void>=[];let started=0,live=0,peak=0;
    const send=()=>{started++;live++;peak=Math.max(peak,live);return new Promise(resolve=>releases.push(()=>{live--;resolve({ok:true});}));};
    const jobs=Array.from({length:101},(_,index)=>clients[index%2]('same-owner',send,()=>false));
    await expect.poll(()=>started).toBe(100);expect(live).toBe(100);expect(held.size).toBe(100);
    releases[0]();await expect.poll(()=>started).toBe(101);expect(peak).toBe(100);
    releases.slice(1).forEach(release=>release());await Promise.all(jobs);expect(held.size).toBe(0);
  },20000);
});
