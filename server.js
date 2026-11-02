'use strict';
require('dotenv').config();
const express=require('express');
const app=express();app.use(express.json());app.use(express.static('public'));
const HOST='https://demo-api.ig.com/gateway/deal';
if((process.env.IG_ACCOUNT_TYPE||'').toUpperCase()!=='DEMO')throw Error('DEMO only: set IG_ACCOUNT_TYPE=DEMO');
const cfg={riskPct:0.5,maxPositions:2,maxDailyLossPct:2,minScore:70,rr:1.5};
const executionConfigured=process.env.ENABLE_DEMO_ORDERS==='YES_I_ACCEPT_DEMO_RISK';
const adminToken=process.env.ADMIN_TOKEN||'';
const executed=new Set();
function requireAdmin(q,r,next){if(!adminToken)return r.status(503).json({error:'Set ADMIN_TOKEN in Render before enabling control endpoints'});if(q.get('X-Admin-Token')!==adminToken)return r.status(403).json({error:'Admin token required'});next()}

let session=null,auto=false,busy=false,signals=[],activity=[],positions=[],balance=null,baseline=null,baselineDate='',lastScan=null;
const log=(message)=>{activity.unshift({time:new Date().toISOString(),message});activity=activity.slice(0,100)};
const day=()=>new Date().toISOString().slice(0,10);
async function req(path,method='GET',body=null,version='1'){
 const h={'X-IG-API-KEY':process.env.IG_API_KEY,'VERSION':version,'Accept':'application/json'};
 if(body!==null)h['Content-Type']='application/json';
 if(session){h.CST=session.cst;h['X-SECURITY-TOKEN']=session.xst;}
 const res=await fetch(HOST+path,{method,headers:h,body:body===null?undefined:JSON.stringify(body)});
 const raw=await res.text();let data;try{data=JSON.parse(raw)}catch{data={raw:raw.slice(0,300)}};
 if(!res.ok||data.errorCode)throw Error(`${res.status}: ${data.errorCode||data.raw||'IG error'}`);
 return {data,headers:res.headers};
}
async function login(){
 if(!process.env.IG_API_KEY||!process.env.IG_USERNAME||!process.env.IG_PASSWORD)throw Error('Missing IG demo credentials');
 const r=await req('/session','POST',{identifier:process.env.IG_USERNAME,password:process.env.IG_PASSWORD},'2');
 const cst=r.headers.get('cst'),xst=r.headers.get('x-security-token');if(!cst||!xst)throw Error('Missing IG session tokens');
 session={cst,xst};return r.data;
}
async function api(path,method='GET',body=null,version='1'){
 if(!session)await login();try{return (await req(path,method,body,version)).data}catch(e){if(String(e.message).includes('401')||String(e.message).includes('403')){session=null;await login();return (await req(path,method,body,version)).data}throw e}
}
const ema=(a,n)=>{let e=a[0],k=2/(n+1);return a.map(x=>(e=x*k+e*(1-k)))};
function rsi(a,n=14){if(a.length<n+1)return 50;let gain=0,loss=0;for(let i=a.length-n;i<a.length;i++){let d=a[i]-a[i-1];gain+=Math.max(0,d);loss+=Math.max(0,-d)}return loss===0?100:100-100/(1+gain/loss)}
function analyse(epic,prices){const candles=(prices||[]).map(p=>({t:p.snapshotTimeUTC||p.snapshotTime,close:(Number(p.closePrice?.bid)+Number(p.closePrice?.ask))/2,high:Number(p.highPrice?.bid),low:Number(p.lowPrice?.bid)})).filter(p=>[p.close,p.high,p.low].every(Number.isFinite));
 if(candles.length<30)return {epic,direction:'WAIT',score:0,reason:'Insufficient candles'};
 const closes=candles.map(x=>x.close),e9=ema(closes,9).at(-1),e21=ema(closes,21).at(-1),r=rsi(closes),entry=closes.at(-1);
 const direction=e9>e21&&r>=52&&r<=68?'LONG':e9<e21&&r>=32&&r<=48?'SHORT':'WAIT';
 const spread=Math.abs(e9-e21)/entry*10000;const score=direction==='WAIT'?0:Math.min(90,Math.round(55+Math.min(20,spread*2)+Math.max(0,15-Math.abs(r-(direction==='LONG'?60:40)))));
 const recent=candles.slice(-15),range=Math.max(...recent.map(x=>x.high))-Math.min(...recent.map(x=>x.low));const stopDistance=Math.max(range*0.5,entry*0.0005);
 return {epic,direction,score,entry,stopDistance,stop:direction==='LONG'?entry-stopDistance:entry+stopDistance,target:direction==='LONG'?entry+stopDistance*cfg.rr:entry-stopDistance*cfg.rr,rsi:r,ema9:e9,ema21:e21,candle:candles.at(-1).t,reason:'Experimental EMA/RSI heuristic; not a probability'};
}
async function refreshAccount(){const [ac,ps]=await Promise.all([api('/accounts'),api('/positions','GET',null,'2')]);const accounts=ac.accounts||[];const a=accounts.find(x=>x.preferred&&x.accountType==='CFD')||accounts.find(x=>x.accountType==='CFD');if(!a)throw Error('No CFD demo account');balance=Number(a.balance?.balance);positions=ps.positions||[];
 if(baselineDate!==day()){baselineDate=day();baseline=balance;log('New UTC day: balance baseline captured (not an equity drawdown guard)')}
 return a;
}
const epics=()=>String(process.env.IG_EPICS||'CS.D.EURUSD.CFD.IP').split(',').map(x=>x.trim()).filter(Boolean).slice(0,10);
function numberOrNull(x){const n=Number(x);return Number.isFinite(n)?n:null}
function sizePrecision(n){return String(n).includes('.')?String(n).split('.')[1].length:0}
async function executeDemo(signal,account){
 if(!executionConfigured)throw Error('Demo order execution not enabled in Render');
 if(signal.direction==='WAIT'||signal.score<cfg.minScore) return;
 if(!Number.isFinite(balance)||balance<=0||!Number.isFinite(baseline)||baseline<=0)throw Error('Account balance unavailable');
 if(balance<=baseline*(1-cfg.maxDailyLossPct/100)){auto=false;throw Error('Daily balance guard reached; monitoring paused');}
 if(positions.length>=cfg.maxPositions)throw Error('Maximum open positions reached');
 if(positions.some(x=>x.market?.epic===signal.epic))throw Error('Position already open for EPIC');
 const key=[signal.epic,signal.direction,signal.candle].join('|');if(executed.has(key))return;
 const m=await api('/markets/'+encodeURIComponent(signal.epic));
 const ins=m.instrument||{}, rules=m.dealingRules||{}, snap=m.snapshot||{};
 const accountCurrency=String(account.currency||'').toUpperCase();
 const instrumentCurrency=String(ins.currencies?.find(x=>x.isDefault)?.code||ins.currencies?.[0]?.code||'').toUpperCase();
 if(!accountCurrency||!instrumentCurrency||accountCurrency!==instrumentCurrency)throw Error('Currency mismatch/unknown; sizing requires validated conversion');
 const pointValue=numberOrNull(ins.valueOfOnePoint);
 const minSize=numberOrNull(rules.minDealSize?.value), increment=numberOrNull(rules.minDealSize?.value);
 if(!pointValue||pointValue<=0||!minSize||minSize<=0)throw Error('IG point value or minimum deal size missing; skip trade');
 // IG valueOfOnePoint is not sufficient by itself to establish cash risk across every market.
 // Require explicit operator-verified point size and monetary point value for this EPIC.
 const verifiedEpic=String(process.env.VERIFIED_EPIC||'');
 const verifiedPointValue=numberOrNull(process.env.VERIFIED_CASH_PER_POINT_PER_CONTRACT);
 const verifiedPointSize=numberOrNull(process.env.VERIFIED_PRICE_POINT_SIZE);
 if(signal.epic!==verifiedEpic||!verifiedPointValue||verifiedPointValue<=0||!verifiedPointSize||verifiedPointSize<=0)throw Error('Verified contract cash-per-point and price-point size not configured');
 const relative=Math.abs(pointValue-verifiedPointValue)/verifiedPointValue;
 if(relative>0.00001)throw Error('IG point value differs from operator verified value');
 const minStop=numberOrNull(rules.minNormalStopOrLimitDistance?.value);
 if(!minStop||minStop<=0||rules.minNormalStopOrLimitDistance?.unit!=='POINTS')throw Error('Minimum stop distance rule not verified as POINTS');
 const decimals=numberOrNull(snap.decimalPlacesFactor);
 if(!decimals||decimals<1||decimals>1000000)throw Error('Unknown price decimal precision');
 const tick=1/decimals;
 const dist=Math.ceil(Math.max(signal.stopDistance,minStop*verifiedPointSize+2*tick)/tick)*tick;
 const bid=numberOrNull(snap.bid),ask=numberOrNull(snap.offer);
 if(!bid||!ask||ask<=bid)throw Error('Invalid market bid/offer');
 const buy=signal.direction==='LONG',entry=buy?ask:bid;
 const stop=Math.round((entry+(buy?-dist:dist))*decimals)/decimals;
 const target=Math.round((entry+(buy?dist*cfg.rr:-dist*cfg.rr))*decimals)/decimals;
 const riskPerContract=dist/verifiedPointSize*verifiedPointValue;
 const rawSize=balance*(cfg.riskPct/100)/riskPerContract;
 // Only trade if the size can be expressed as whole multiples of the documented minimum.
 const size=Math.floor(rawSize/minSize)*minSize;
 if(!Number.isFinite(size)||size<minSize)throw Error('Risk budget below minimum IG position size');
 if(size*riskPerContract>balance*cfg.riskPct/100+0.000001)throw Error('Risk calculation failed');
 if(ins.expiry!=='DFB')throw Error('Only DFB markets supported in this prototype');
 // Reserve the signal before submission; never retry an ambiguous POST.
 executed.add(key);
 const body={epic:signal.epic,expiry:'DFB',direction:buy?'BUY':'SELL',size:Number(size.toFixed(sizePrecision(minSize))),orderType:'MARKET',currencyCode:accountCurrency,forceOpen:true,guaranteedStop:false,stopLevel:stop,limitLevel:target};
 log(`Submitting IG DEMO ${body.direction} ${body.epic} size ${body.size} with attached stop/limit`);
 try{
   const result=await api('/positions/otc','POST',body,'2');
   if(!result.dealReference)throw Error('No dealReference; inspect IG demo before retrying');
   const confirmation=await api('/confirms/'+encodeURIComponent(result.dealReference));
   log('IG demo confirmation: '+JSON.stringify({dealReference:result.dealReference,dealStatus:confirmation.dealStatus,reason:confirmation.reason,dealId:confirmation.dealId}));
   if(confirmation.dealStatus!=='ACCEPTED'){auto=false;log('Auto trading paused after rejected or uncertain confirmation')}
   await refreshAccount();
 }catch(e){auto=false;log('ORDER STATUS UNCERTAIN: '+e.message+'; auto paused, inspect IG positions before restarting');throw e}
}
async function scan(){if(busy)return;busy=true;try{await refreshAccount();const results=[];for(const epic of epics()){try{const p=await api(`/prices/${encodeURIComponent(epic)}/MINUTE_5/100`,'GET',null,'2');results.push(analyse(epic,p.prices))}catch(e){results.push({epic,direction:'ERROR',score:0,reason:e.message});log(`Scan ${epic}: ${e.message}`)}}signals=results;lastScan=new Date().toISOString();if(auto){for(const sig of results){if(!auto)break;if(sig.direction==='LONG'||sig.direction==='SHORT'){try{const a=await refreshAccount();await executeDemo(sig,a)}catch(e){log('Skipped/paused '+sig.epic+': '+e.message)}}}}}catch(e){log('Scan failed: '+e.message)}finally{busy=false}}
app.get('/api/health',(q,s)=>s.json({ok:true,version:'3.1.0',accountType:'DEMO',orderExecutionEnabled:executionConfigured}));
app.get('/api/state',(q,s)=>s.json({version:'3.1.0',auto,orderExecutionEnabled:executionConfigured,cfg,signals,activity,positions,balance,baseline,baselineDate,lastScan,busy}));
app.get('/api/ig/test',async(q,s)=>{try{await login();const a=await api('/accounts');s.json({ok:true,authenticated:true,accountsReturned:a.accounts?.length||0,note:'No orders placed'})}catch(e){s.status(502).json({ok:false,error:e.message})}});
app.get('/api/ig/search',async(q,s)=>{try{const term=String(q.query.term||'EUR/USD').slice(0,60);s.json(await api('/markets?searchTerm='+encodeURIComponent(term)))}catch(e){s.status(502).json({error:e.message})}});
app.post('/api/scan',requireAdmin,async(q,s)=>{await scan();s.json({ok:true,signals,lastScan})});
app.post('/api/auto',requireAdmin,async(q,s)=>{if(q.body?.enabled&&!executionConfigured)return s.status(409).json({error:'Demo order execution locked; see README'});auto=q.body?.enabled===true;log(auto?'IG DEMO automatic orders ARMED':'IG DEMO automatic orders PAUSED (existing positions remain open)');s.json({ok:true,auto,orderExecutionEnabled:executionConfigured})});
app.get('*',(q,s)=>s.sendFile(require('path').join(__dirname,'public','index.html')));
const port=process.env.PORT||3000;app.listen(port,()=>{log('V3.1 started: '+(executionConfigured?'DEMO orders configured; starts PAUSED':'DEMO orders LOCKED'));console.log('MarketPulse V3 on',port)});
setInterval(()=>scan().catch(e=>log(e.message)),Math.max(30,Number(process.env.POLL_SECONDS)||60)*1000);setTimeout(()=>scan().catch(e=>log(e.message)),3000);
