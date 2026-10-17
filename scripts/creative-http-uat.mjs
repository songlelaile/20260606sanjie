import { createPaymentUatDatabase } from './payment-uat-db.mjs';
import { PrismaClient } from '@prisma/client';
import { randomBytes, scryptSync } from 'node:crypto';
import { mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
const source = process.env.CREATIVE_UAT_SOURCE || path.join(process.cwd(), '.codex-deploy/creative-uat-20261001/source');
const port = 32101;
const origin = `http://localhost:${port}`;
const out = path.join(source, 'acceptance'); mkdirSync(out,{recursive:true});
const db = await createPaymentUatDatabase();
const client = new PrismaClient({datasources:{db:{url:db.url}},log:[]});
const password = `Uat-${randomBytes(12).toString('hex')}`;
const salt=randomBytes(16); const hash=['scrypt','16384','8','1',salt.toString('hex'),scryptSync(password,salt,64,{N:16384,r:8,p:1}).toString('hex')].join('$');
const tenant=await client.tenant.create({data:{name:'UAT管理员工作区',slug:`uat-admin-${randomBytes(4).toString('hex')}`}});
await client.user.create({data:{username:'19900000001',password:hash,name:'测试管理员',tenantId:tenant.id,authRole:'admin'}});
const env={...process.env,DATABASE_URL:db.url,SESSION_SECRET:randomBytes(32).toString('hex'),SHARE_ENCRYPTION_KEY:randomBytes(32).toString('hex'),AI_API_ENCRYPTION_KEY:randomBytes(32).toString('hex'),PUBLIC_APP_ORIGIN:origin,MODEL_GATEWAY_PAYMENT_PROVIDER:'manual',MODEL_GATEWAY_MANUAL_PAY_URL:'',MODEL_GATEWAY_AUTO_PAY:'1',MODEL_GATEWAY_CONFIG_FILE:path.join(out,'relay.json'),SANJIE_TEST_ENVIRONMENT:'creative-20261001',SANJIE_SESSION_COOKIE_NAME:'sanjie_session_creative_uat',SANJIE_ACTIVE_SHOP_COOKIE_NAME:'sanjie_shop_creative_uat',SANJIE_TEST_RELEASE_LABEL:'作图视频收口测试版 · 独立测试数据'};
for(const name of Object.keys(env)) if(/^MODEL_GATEWAY_.*API_KEY$/.test(name)) env[name]='';
writeFileSync(path.join(out,'local-test-accounts.json'),JSON.stringify({origin,admin:{username:'19900000001',password},self:{username:'19900000002',password},invited:{username:'19900000003',password}},null,2),{mode:0o600});
writeFileSync(path.join(source,'.env.local'),Object.entries(env).filter(([n])=>/^(DATABASE_URL|SESSION_SECRET|SHARE_ENCRYPTION_KEY|AI_API_ENCRYPTION_KEY|PUBLIC_APP_ORIGIN|MODEL_GATEWAY_|SANJIE_)/.test(n)).map(([n,v])=>`${n}=${JSON.stringify(v)}`).join('\n')+'\n',{mode:0o600});
const log=createWriteStream(path.join(out,'server.log'));
const app=spawn(path.join(source,'node_modules/.bin/next'),['dev','--hostname','127.0.0.1','--port',String(port)],{cwd:source,env,stdio:['ignore','pipe','pipe']});app.stdout.pipe(log);app.stderr.pipe(log);
let stopping=false;
async function stop(){if(stopping)return;stopping=true;app.kill('SIGTERM');await client.$disconnect();await db.cleanup();process.exit();}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
const checks=[];
function check(name,value){checks.push({name,passed:!!value});if(!value)throw new Error(name);}
async function call(route,cookie='',data,method=data?'POST':'GET'){
 const response=await fetch(origin+route,{method,headers:{...(cookie?{cookie}:{}),...(data?{'content-type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{}),redirect:'manual'});
 const raw=await response.text();let body;try{body=JSON.parse(raw);}catch{body=raw;}
 return {response,body,cookie:response.headers.getSetCookie().map(x=>x.split(';')[0]).filter(x=>x.includes('sanjie_session_creative_uat=')).join('; ')};
}
try{
 for(let i=0;i<90;i++){try{if((await fetch(origin+'/login')).status===200)break;}catch{}await new Promise(r=>setTimeout(r,500));}
 check('anonymous API is denied',(await call('/api/creative/proxy','',{})).response.status===401);
 const admin=await call('/api/auth/login','',{username:'19900000001',password});check('administrator login',admin.response.status===200&&!!admin.cookie);
 const createdInvite=await call('/api/invite-codes',admin.cookie,{note:'UAT受邀客户',maxUses:2});check('create invite',createdInvite.response.status===201||createdInvite.response.status===200);
 const invite=createdInvite.body.data.invite ?? createdInvite.body.data;
 const self=await call('/api/auth/register','',{username:'19900000002',password,name:'测试自主客户'});check('self registration',self.response.status===200&&!!self.cookie);
 const invited=await call('/api/auth/register','',{username:'19900000003',password,name:'测试受邀客户',inviteCode:invite.code});check('invite registration',invited.response.status===200&&!!invited.cookie);
 const other=await call('/api/auth/register','',{username:'19900000004',password,name:'另一自主客户'});check('second independent customer',other.response.status===200);
 check('self starts without studio access',!(await call('/api/auth/creative-access',self.cookie)).body.data.access.allowed);
 check('invited opens studio',(await call('/api/auth/creative-access',invited.cookie)).body.data.access.allowed);
 check('direct creative HTML cannot bypass payment',(await call('/creative/labs/image-prompt-lab/promptlab.html',self.cookie)).response.status===402);
 check('unpaid proxy cannot call upstream',(await call('/api/creative/proxy',self.cookie,{url:'https://sub.shaozhuangai.com/v1/images/generations',method:'POST',bodyText:'{}'})).response.status===402);
 const orderResult=await call('/api/model-gateway/orders',self.cookie,{planCode:'starter'});const order=orderResult.body.data.order;
 check('AUTO_PAY cannot bypass manual payment',orderResult.response.status===201&&order.status==='pending');
 check('foreign order is hidden',(await call(`/api/model-gateway/orders/${order.id}`,other.cookie)).response.status===404);
 check('customer cannot confirm own payment',(await call(`/api/model-gateway/orders/${order.id}/mark-paid`,self.cookie,{receipt:'UAT-OWN',receivedAmountCents:9900})).response.status===403);
 check('wrong received amount is denied',(await call(`/api/model-gateway/orders/${order.id}/mark-paid`,admin.cookie,{receipt:'UAT-AMOUNT',receivedAmountCents:1})).response.status===409);
 const confirmed=await call(`/api/model-gateway/orders/${order.id}/mark-paid`,admin.cookie,{receipt:'UAT-PAID-'+randomBytes(8).toString('hex'),receivedAmountCents:9900,note:'独立测试库模拟流水，不是真实收款'});
 check('admin confirmation settles order',confirmed.response.status===200&&confirmed.body.data.order.status==='paid');
 check('paid customer gains 30-day access',(await call('/api/auth/creative-access',self.cookie)).body.data.access.reason==='paid');
 check('paid customer opens direct image HTML',(await call('/creative/labs/image-prompt-lab/promptlab.html',self.cookie)).response.status===200);
 check('invited opens video HTML',(await call('/creative/labs/ecommerce-video-studio/video-studio.html',invited.cookie)).response.status===200);
 const repeat=await call(`/api/model-gateway/orders/${order.id}/mark-paid`,admin.cookie,{receipt:confirmed.body.data.order.paymentReceipt,receivedAmountCents:9900});check('repeated confirmation is idempotent',repeat.response.status===200);
 const owner=await client.user.findUnique({where:{username:'19900000002'}});const wallet=await client.gatewayWallet.findUnique({where:{userId:owner.id}});check('wallet credited once',wallet.balanceCents===12000);
 check('management is forbidden to customer',(await call('/api/management/creative-orders',self.cookie)).response.status===403);
 check('administrator sees pending and paid orders',(await call('/api/management/creative-orders',admin.cookie)).body.data.orders.length>0);
 await client.user.update({where:{username:'19900000003'},data:{status:'disabled'}});
 check('disabled signed customer is denied',(await call('/api/auth/creative-access',invited.cookie)).body.data.access.allowed===false);
 await client.user.update({where:{username:'19900000003'},data:{status:'active'}});
 writeFileSync(path.join(out,'http-acceptance.json'),JSON.stringify({origin,schema:db.schemaName,checks,passed:checks.filter(x=>x.passed).length,realPayment:false,realProvider:false},null,2));
 console.log(JSON.stringify({ready:true,origin,checks:checks.length,passed:checks.filter(x=>x.passed).length,accountsFile:path.join(out,'local-test-accounts.json')}));
 await new Promise(()=>{});
}catch(error){writeFileSync(path.join(out,'http-acceptance.json'),JSON.stringify({checks,error:error.message},null,2));console.log(JSON.stringify({failed:true,check:error.message}));await stop();}
