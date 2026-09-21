// 신시 협동 서버 — 권위 시뮬레이션 + 정적 페이지 서빙(같은 포트).
// 01-design-bible.md / sinsi-mudang-v5.html의 무당 단일 플레이 로직을 다인용으로 이식.
// 범위: 이동·저주·적 6종+보스·전투·원혼·레벨업까지. 장비/아이템(가방·희귀도·전설)은 다음 단계로 미룬다.
// 로컬(LAN)이든 Render 같은 클라우드든 이 파일 하나(정적 파일 + WebSocket)만 띄우면 된다 — 클라이언트는 location 기준으로 접속 주소를 스스로 계산한다.
const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8765;
const PUBLIC_DIR = path.join(__dirname, '..', 'docs');
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css', '.json':'application/json' };
const TICK_MS = 50;
const DT = TICK_MS / 1000;
const WS_SIZE = 1700, TS = 68, TN = Math.round(WS_SIZE / TS);
const MAX_PLAYERS = 8;
const COLORS = ['#e8c15a', '#5ac0e8', '#e85a7a', '#7ae85a', '#b05ae8', '#e8935a', '#5ae8c1', '#e85ae8'];

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
function mulberry(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

const ET = {
  ghoul:  { r:11, hp:22, spd:60, dmg:8,  oil:[.5,1], xp:1, col:'#c9c6b2' },
  charger:{ r:13, hp:34, spd:70, dmg:14, oil:[.7,1], xp:2, col:'#d96a4a' },
  spitter:{ r:12, hp:28, spd:58, dmg:6,  oil:[.7,1], xp:2, col:'#9a74c4' },
  mutant: { r:15, hp:48, spd:92, dmg:12, oil:[.8,2], xp:2, col:'#5fa596' },
  bomber: { r:16, hp:30, spd:80, dmg:6,  oil:[.6,1], xp:2, col:'#a3b24c' },
  husk:   { r:20, hp:95, spd:46, dmg:18, oil:[1,3],  xp:4, col:'#b07a3a' },
  boss:   { r:42, hp:1500, spd:62, dmg:24, oil:[1,25], xp:0, col:'#c48a3c' }
};
const SPAWN = [
  [['ghoul',.72],['charger',.28]],
  [['ghoul',.38],['charger',.22],['spitter',.2],['mutant',.2]],
  [['ghoul',.25],['charger',.15],['spitter',.15],['mutant',.15],['bomber',.15],['husk',.15]],
  [['ghoul',.2],['charger',.15],['spitter',.15],['mutant',.15],['bomber',.15],['husk',.2]],
  [['ghoul',.2],['charger',.15],['spitter',.15],['mutant',.15],['bomber',.15],['husk',.2]]
];
function pickType(lvl) { let r = Math.random(); for (const [t, w] of SPAWN[lvl]) { if ((r -= w) <= 0) return t; } return 'ghoul'; }

const UP = [
  { id:'split', name:'갈래 방울', max:3, desc:l=>`방울 소리가 ${l+2}갈래로 퍼진다` },
  { id:'tempo', name:'빠른 장단', max:4, desc:()=>'방울을 20% 더 빨리 흔든다' },
  { id:'echo',  name:'울림',     max:3, desc:()=>'방울 피해 +25%, 한 명 더 꿰뚫는다' },
  { id:'vessel',name:'넋 그릇',   max:3, desc:()=>'넋을 3개 더 담고, 원혼 피해 +25%' },
  { id:'burst', name:'원혼 폭발', max:3, desc:()=>'원혼이 흩어질 때 터져 주변을 태운다' },
  { id:'linger',name:'머무는 넋', max:2, desc:()=>'원혼이 8초 더 머문다' },
  { id:'auto',  name:'부르지 않아도', max:1, desc:()=>'넋이 가득 차면 저절로 초혼한다' },
  { id:'fan',   name:'넓은 부채', max:3, desc:()=>'살풀이 범위 +30%, 대기 시간 −1.5초' },
  { id:'ember', name:'넋 불씨',   max:1, desc:()=>'저주 걸린 적을 쓰러뜨리면 넋이 하나 더' },
  { id:'leech', name:'넋 흡혈',   max:2, desc:()=>'원혼이 때릴 때 가끔 체력을 되찾는다' },
  { id:'vital', name:'신령의 가호', max:3, desc:()=>'최대 체력 +25, 체력을 모두 되찾는다' },
  { id:'sense', name:'신수 감각', max:2, desc:()=>'신수를 더 멀리서 끌어오고 더 자주 줍는다' },
  { id:'swift', name:'날랜 발',   max:2, desc:()=>'이동 속도 +12%' }
];
const UP_BY = {}; UP.forEach(u => UP_BY[u.id] = u);

/* ───────── 아이템 ───────── */
const SLOT_NAME = { bell:'방울', fan:'부채', robe:'무복', trinket:'노리개' };
const SLOT_KEYS = ['bell','fan','robe','trinket'];
const BAG_MAX = 12;
const RAR = [
  { n:'일반', c:'#d8d2c2', aff:[0,0], salv:1 },
  { n:'마법', c:'#6fa8ff', aff:[1,2], salv:2 },
  { n:'희귀', c:'#f0d25a', aff:[3,4], salv:4 },
  { n:'전설', c:'#ff8a3a', aff:[2,3], salv:8 }
];
const AFF = {
  bellDmg:{l:'방울 피해',u:'%',min:8,max:20,w:1,pre:'날선'},
  atkSpd:{l:'방울 속도',u:'%',min:5,max:12,w:1.5,pre:'재빠른'},
  spDmg:{l:'원혼 피해',u:'%',min:10,max:25,w:.9,pre:'원한 서린'},
  spLife:{l:'원혼 지속',u:'초',min:2,max:5,w:2,pre:'오래가는'},
  hp:{l:'최대 체력',u:'',min:10,max:25,w:.6,pre:'든든한'},
  crit:{l:'치명타 확률',u:'%',min:2,max:5,w:3,pre:'예리한'},
  critDmg:{l:'치명타 피해',u:'%',min:15,max:40,w:.5,pre:'잔혹한'},
  speed:{l:'이동 속도',u:'%',min:3,max:8,w:1.5,pre:'날랜'},
  souls:{l:'넋 최대치',u:'',min:1,max:2,w:5,pre:'넋 담긴'},
  salCd:{l:'살풀이 대기 감소',u:'%',min:6,max:15,w:1,pre:'바람 든'},
  oil:{l:'신수 획득',u:'%',min:10,max:25,w:.4,pre:'신수 머금은'},
  regen:{l:'초당 체력 회복',u:'',min:.5,max:1.5,w:8,dec:1,pre:'숨 고르는'},
  fanR:{l:'살풀이 범위',u:'%',min:8,max:18,w:.6,pre:'넓은'}
};
const BASE = {
  bell:{names:['낡은 방울','놋쇠 방울','청동 방울','신령 방울'],imp:'bellDmg'},
  fan:{names:['종이 부채','비단 부채','오방 부채','신령 부채'],imp:'fanR'},
  robe:{names:['삼베 무복','무명 무복','비단 무복','신령 무복'],imp:'hp'},
  trinket:{names:['나무 노리개','옥 노리개','산호 노리개','신령 노리개'],imp:'crit'}
};
const LEG = [
  {id:'thunder',slot:'bell',name:'천둥 방울',desc:'방울이 적중하면 20% 확률로 번개가 세 명에게 튄다'},
  {id:'soulbell',slot:'bell',name:'넋부름 방울',desc:'방울로 쓰러뜨린 적은 넋을 하나 더 남긴다'},
  {id:'maple',slot:'fan',name:'핏빛 단풍 부채',desc:'살풀이에 걸린 적은 저주가 끝날 때까지 불탄다'},
  {id:'wind',slot:'fan',name:'풍백의 부채',desc:'살풀이가 적을 멀리 날려 보내고, 대기 시간 −30%'},
  {id:'obang',slot:'robe',name:'오방신장 무복',desc:'피해를 받으면 원혼 둘이 곁에 나타난다 (3초마다)'},
  {id:'tiger',slot:'robe',name:'범가죽 무복',desc:'체력이 30% 이하일 때 모든 피해 +60%'},
  {id:'shackle',slot:'trinket',name:'찢긴 족쇄',desc:'저주 걸린 적이 쓰러지면 터져 주변을 태운다'},
  {id:'brow',slot:'trinket',name:'동두의 이마쇠',desc:'원혼 수가 절반이 되는 대신 거대해져 피해 +120%'}
];
const LEG_BY = {}; LEG.forEach(l => LEG_BY[l.id] = l);
const RARE_A = ['저승','단풍','청동','안개','탁록','범','곰','신단','족쇄','구리','무쇠','달'];
const RARE_B = ['울음','속삭임','한','불씨','맹세','눈물','숨결','그림자'];
let itemUid = 1;
const fmtV = (k,v) => AFF[k].dec ? (Math.round(v*10)/10) : Math.round(v);
function rollVal(k,ilvl){ const a=AFF[k]; const v=lerp(a.min,a.max,Math.random())*(1+ilvl*.25); return a.dec?Math.round(v*10)/10:Math.max(1,Math.round(v)); }
function rollRarity(stage,trans){ const st=trans?4:stage; const r=Math.random();
  if(r<.03+st*.01+(trans?.02:0))return 3; if(r<.17+st*.03)return 2; if(r<.5)return 1; return 0; }
function genItem(stage,trans,forceR){
  const ilvl=trans?4:stage; const r=forceR!=null?forceR:rollRarity(stage,trans);
  let slot,leg=null;
  if(r===3){leg=LEG[Math.random()*LEG.length|0];slot=leg.slot;} else slot=SLOT_KEYS[Math.random()*4|0];
  const tier=Math.min(3,Math.floor(ilvl*.8)); const base=BASE[slot];
  const mods=[{k:base.imp,v:rollVal(base.imp,ilvl),imp:true}];
  const [a,b]=RAR[r].aff; const n=a+Math.floor(Math.random()*(b-a+1));
  Object.keys(AFF).filter(k=>k!==base.imp).sort(()=>Math.random()-.5).slice(0,n).forEach(k=>mods.push({k,v:rollVal(k,ilvl)}));
  let name;
  if(leg)name=leg.name;
  else if(r===0)name=base.names[tier];
  else if(r===1)name=AFF[mods[1].k].pre+' '+base.names[tier];
  else name=RARE_A[Math.random()*RARE_A.length|0]+'의 '+RARE_B[Math.random()*RARE_B.length|0];
  return {id:itemUid++,slot,r,name,base:base.names[tier],mods,leg:leg?leg.id:null};
}
function itemScore(it){ if(!it)return 0; let s=0; for(const m of it.mods)s+=m.v*AFF[m.k].w; return s+(it.leg?45:0); }
function isUpgrade(pl,it){ return itemScore(it) > itemScore(pl.eq[it.slot]) + .5; }
function sumMods(it){ const o={}; if(it)for(const m of it.mods)o[m.k]=(o[m.k]||0)+m.v; return o; }
function recalc(pl){
  const G={}; for(const k in AFF)G[k]=0; pl.leg=new Set();
  for(const sl of SLOT_KEYS){ const it=pl.eq[sl]; if(!it)continue; for(const m of it.mods)G[m.k]+=m.v; if(it.leg)pl.leg.add(it.leg); }
  pl.G=G;
  const ratio = pl.max ? pl.hp/pl.max : 1;
  pl.max = stat.maxHp(pl); pl.hp = Math.min(pl.max, Math.max(1, Math.round(pl.max*ratio)));
}
const HAS = (pl,id) => pl.leg.has(id);

const STAGE_NAME = ['평온','징후','침식','전화 임박','저주에 삼켜짐'];
const STAGE_MSG = [null,'징후 — 족쇄의 저주가 번진다. 돌진귀와 저주 뱉는 자가 나타난다','침식 — 땅이 뒤틀린다. 부푼 자는 가까이 오면 터진다','전화 임박 — 정화하지 않으면 이 구역은 저주에 삼켜진다'];
const stageOf = c => c >= 100 ? 4 : c > 85 ? 3 : c > 50 ? 2 : c > 25 ? 1 : 0;

const L = (pl, id) => pl.up[id] || 0;
const G0 = {}; // 장비가 아직 없는 순간(신규 접속 직후)을 위한 기본값
const stat = {
  atkCd: pl => .38 / (1 + .2 * L(pl,'tempo') + (pl.G.atkSpd||0)/100),
  bellDmg: pl => 13 * (1 + .25 * L(pl,'echo') + (pl.G.bellDmg||0)/100),
  pierce: pl => 2 + L(pl,'echo'),
  maxSouls: pl => 8 + 3 * L(pl,'vessel') + (pl.G.souls||0),
  maxSpirits: pl => Math.ceil((8 + 2 * L(pl,'vessel')) * (HAS(pl,'brow')?.5:1)),
  spDmg: pl => 9 * (1 + .25 * L(pl,'vessel') + (pl.G.spDmg||0)/100) * (HAS(pl,'brow')?2.2:1),
  spLife: pl => 20 + 8 * L(pl,'linger') + (pl.G.spLife||0),
  fanR: pl => 190 * (1 + .3 * L(pl,'fan') + (pl.G.fanR||0)/100),
  salCd: pl => (8 - 1.5 * L(pl,'fan')) * (1 - (pl.G.salCd||0)/100) * (HAS(pl,'wind')?.7:1),
  magnet: pl => 95 * (1 + .6 * L(pl,'sense')),
  dropMul: pl => (1 + .3 * L(pl,'sense')) * (1 + (pl.G.oil||0)/100),
  speed: pl => 185 * (1 + .12 * L(pl,'swift') + (pl.G.speed||0)/100),
  crit: pl => .15 + (pl.G.crit||0)/100, critMul: pl => 2 + (pl.G.critDmg||0)/100,
  maxHp: pl => Math.round(100 + 25 * L(pl,'vital') + (pl.G.hp||0))
};
const xpNeed = pl => 9 + (pl.lv - 1) * 6;

let room = null;
const players = new Map();
let nextId = 1;

function newRoom() {
  room = {
    t: 0, c: 0, stage: 0, maxStage: 0, trans: false, collapsed: false,
    obs: [], en: [], proj: [], eproj: [], sp: [], drops: [], loot: [],
    spawn: 1.2, boss: null, bossT: -1,
    seed: (Math.random() * 1e9) | 0,
    events: [], over: null
  };
  genMap(room.seed, false);
}
function anyoneNear(x, y, r) {
  for (const pl of players.values()) if (pl.alive && Math.hypot(pl.x - x, pl.y - y) < r) return true;
  return false;
}
function genMap(seed, trans) {
  const R = mulberry(seed);
  room.obs = [];
  const n = trans ? 30 : 18;
  for (let k = 0; k < n; k++) {
    let x, y, t = 0;
    do { x = 120 + R() * (WS_SIZE - 240); y = 120 + R() * (WS_SIZE - 240); t++; }
    while (anyoneNear(x, y, 220) && t < 30);
    room.obs.push({ x, y, r: trans ? 20 + R() * 26 : 22 + R() * 26, kind: trans ? 'maple' : 'bone', rise: trans ? 0 : 1 });
  }
}
function collideObs(ent, r) {
  for (const o of room.obs) {
    const rr = o.r * o.rise + r;
    const dx = ent.x - o.x, dy = ent.y - o.y, d = Math.hypot(dx, dy);
    if (d < rr && d > 0.01) { ent.x = o.x + dx / d * rr; ent.y = o.y + dy / d * rr; }
  }
}
function nearestPlayer(x, y) {
  let best = null, bd = Infinity;
  for (const pl of players.values()) { if (!pl.alive) continue; const d = Math.hypot(pl.x - x, pl.y - y); if (d < bd) { bd = d; best = pl; } }
  return best;
}
function alivePlayers() { return [...players.values()].filter(p => p.alive); }

function newPlayer(id, ws) {
  const color = COLORS[(id - 1) % COLORS.length];
  const spawnPt = alivePlayers()[0] || { x: WS_SIZE/2, y: WS_SIZE/2 };
  const pl = {
    id, ws, name: `무당${id}`, color,
    x: clamp(spawnPt.x + (Math.random()*80-40), 20, WS_SIZE-20),
    y: clamp(spawnPt.y + (Math.random()*80-40), 20, WS_SIZE-20),
    hp: 100, max: 100, face: 0, mv: 0,
    lv: 1, xp: 0, up: {}, pendingLv: 0, choosing: null,
    atkCd: 0, sumCd: 0, salCd: 0, invCd: 0, obangCd: 0,
    oil: 0, oilTotal: 0, souls: 0, kills: 0, legends: 0, alive: true,
    eq: { bell:null, fan:null, robe:null, trinket:null }, bag: [], G: {}, leg: new Set(),
    input: { dx: 0, dy: 0, atk: false }
  };
  pl.eq.bell = { id: itemUid++, slot:'bell', r:0, name:'낡은 방울', base:'낡은 방울', mods:[{k:'bellDmg',v:5,imp:true}], leg:null };
  recalc(pl); pl.hp = pl.max;
  return pl;
}

function ev(type, data) { room.events.push({ type, ...data }); }

function gainXp(pl, n) {
  pl.xp += n;
  while (pl.xp >= xpNeed(pl)) { pl.xp -= xpNeed(pl); pl.lv++; pl.pendingLv++; }
  if (pl.pendingLv > 0 && !pl.choosing) offerLevelUp(pl);
}
function offerLevelUp(pl) {
  const pool = UP.filter(u => L(pl, u.id) < u.max).sort(() => Math.random() - .5).slice(0, 3);
  const list = pool.length ? pool : [{ id:'_heal', name:'숨 고르기', desc:()=>'체력을 모두 되찾는다' }];
  pl.choosing = list.map(u => ({ id: u.id, name: u.name, desc: u.desc(u.id === '_heal' ? 0 : L(pl, u.id)), lv: u.id === '_heal' ? null : L(pl, u.id), max: u.max || null }));
  sendTo(pl, { type: 'levelup', lvNow: pl.lv - pl.pendingLv + 1, choices: pl.choosing });
}
function chooseUp(pl, id) {
  if (!pl.choosing || !pl.choosing.some(c => c.id === id)) return;
  if (id === '_heal') pl.hp = stat.maxHp(pl);
  else { pl.up[id] = L(pl, id) + 1; if (id === 'vital') { pl.max = stat.maxHp(pl); pl.hp = pl.max; } }
  pl.pendingLv--; pl.choosing = null;
  if (pl.pendingLv > 0) offerLevelUp(pl);
  else sendTo(pl, { type: 'levelup_done' });
}

function hitEnemy(e, amt, kx, ky, canCrit, srcId, ability) {
  if (e.curse > 0) amt *= 1.5;
  const owner = srcId ? players.get(srcId) : null;
  if (owner && HAS(owner,'tiger') && owner.hp/owner.max < .3) amt *= 1.6;
  if (srcId) { e.lastSrc = srcId; if (ability) e.lastAbility = ability; }
  let crit = false;
  const critChance = owner ? stat.crit(owner) : .15, critMulV = owner ? stat.critMul(owner) : 2;
  if (canCrit !== false && Math.random() < critChance) { crit = true; amt *= critMulV; }
  e.hp -= amt; e.flash = .1;
  const k = e.type === 'boss' ? .12 : 1;
  e.kx += kx * k * (crit ? 1.8 : 1); e.ky += ky * k * (crit ? 1.8 : 1);
  ev('hit', { x: e.x, y: e.y, r: e.r, amt: Math.round(amt), crit, curse: e.curse > 0 });
  if (ability === 'bell' && owner && HAS(owner,'thunder') && Math.random() < .2) chain(e, owner);
}
function chain(from, owner) {
  let cur = from; const hit = new Set([from]); const dmg = stat.bellDmg(owner) * .8;
  ev('zap', {});
  for (let i = 0; i < 3; i++) {
    let best = null, bd = 170;
    for (const e of room.en) { if (e.hp<=0 || hit.has(e)) continue; const d=Math.hypot(e.x-cur.x,e.y-cur.y); if (d<bd) { bd=d; best=e; } }
    if (!best) break;
    ev('bolt', { x1: cur.x, y1: cur.y, x2: best.x, y2: best.y });
    hitEnemy(best, dmg, 0, 0, true, owner.id, null);
    hit.add(best); cur = best;
  }
}
function explode(x, y, r, dmgE) {
  ev('boom', { x, y, r });
  for (const pl of alivePlayers()) if (pl.invCd <= 0 && Math.hypot(pl.x - x, pl.y - y) < r + 14) hurt(pl, 22);
  for (const e of room.en) { if (e.hp <= 0) continue; const dx = e.x - x, dy = e.y - y, d = Math.hypot(dx, dy) || 1; if (d < r + e.r) hitEnemy(e, dmgE, dx/d*300, dy/d*300, false); }
}
function dropLoot(e) {
  if (e.type === 'boss') { dropItem(e.x, e.y, 3); dropItem(e.x+34, e.y+10, 2); dropItem(e.x-34, e.y+10, 2); return; }
  const ch = { ghoul:.03, charger:.07, spitter:.07, mutant:.07, bomber:.06, husk:.18 }[e.type] * (room.trans ? 1.5 : 1);
  if (Math.random() < ch) dropItem(e.x, e.y);
}
function dropItem(x, y, forceR) {
  const it = genItem(room.stage, room.trans, forceR);
  room.loot.push({ x, y, it, t: 0 });
  if (it.r === 3) ev('legend', { name: it.name });
  else if (it.r === 2) ev('rare', {});
}
function killEnemy(e) {
  ev('kill', { x: e.x, y: e.y, etype: e.type, boss: e.type === 'boss' });
  if (e.type === 'bomber' && !e.fused) explode(e.x, e.y, 80, 40);
  const owner = e.lastSrc ? players.get(e.lastSrc) : null;
  if (owner && HAS(owner,'shackle') && e.curse > 0) explode(e.x, e.y, 65, 20*(1+room.t/240));
  if (owner) owner.kills++;
  if (e.noReward) return;
  if (e.type !== 'boss' && owner && owner.alive) {
    const add = 1 + (e.curse > 0 && L(owner,'ember') ? 1 : 0) + (e.lastAbility === 'bell' && HAS(owner,'soulbell') ? 1 : 0);
    if (owner.souls < stat.maxSouls(owner)) owner.souls = Math.min(stat.maxSouls(owner), owner.souls + add);
    gainXp(owner, ET[e.type].xp);
  }
  const [ch, amt] = ET[e.type].oil;
  const dm = owner ? stat.dropMul(owner) : 1;
  if (Math.random() < ch * dm) { const n = amt * (room.trans ? 2 : 1); for (let i = 0; i < Math.min(n, 12); i++) room.drops.push({ x: e.x + (Math.random()-.5)*e.r*2, y: e.y + (Math.random()-.5)*e.r*2, kind:'oil', v: n>12?Math.ceil(n/12):1, t:0 }); }
  if (Math.random() < .06) room.drops.push({ x: e.x, y: e.y, kind:'heal', v: 20, t: 0 });
  dropLoot(e);
  if (e.type === 'boss') {
    room.boss = null; ev('gong', {});
    room.over = 'won';
  }
}
function spawnEnemy(type, x, y) {
  const d = ET[type];
  const scale = type === 'boss' ? 1 : (1 + room.t / 240) * (room.trans ? 1.3 : 1);
  const hp = d.hp * scale;
  const e = { type, x, y, r: d.r, hp, max: hp, spd: d.spd, dmg: d.dmg, hitCd: 0, flash: 0, kx: 0, ky: 0, wob: Math.random()*6, wave:3, summonT:6,
    curse: 0, cd: 1 + Math.random()*1.2, st: 0, state: 'chase', side: Math.random()<.5?-1:1, charge: 0, fuse: 0, dx:0, dy:0 };
  room.en.push(e);
  if (type === 'boss') room.boss = e;
  return e;
}
function hurt(pl, d) {
  if (!pl.alive) return;
  pl.hp -= d; pl.invCd = .4;
  ev('hurt', { id: pl.id, x: pl.x, y: pl.y, amt: d });
  if (HAS(pl,'obang') && pl.obangCd <= 0 && pl.hp > 0) {
    pl.obangCd = 3;
    for (let i = 0; i < 2; i++) { const a = Math.random()*6.28; room.sp.push({ owner: pl.id, x: pl.x+Math.cos(a)*30, y: pl.y+Math.sin(a)*30, t:0, life:8, cd:0, idx: Math.random()*6.28 }); }
  }
  if (pl.hp <= 0) { pl.hp = 0; pl.alive = false; ev('down', { id: pl.id, x: pl.x, y: pl.y });
    if (alivePlayers().length === 0) room.over = 'lost'; }
}
function fireBell(pl) {
  const n = 1 + L(pl,'split');
  ev('bell', { x: pl.x, y: pl.y });
  for (let i = 0; i < n; i++) {
    const a = pl.face + (i - (n-1)/2) * .22;
    room.proj.push({ x: pl.x+Math.cos(a)*16, y: pl.y+Math.sin(a)*16, vx: Math.cos(a)*450, vy: Math.sin(a)*450, t:0, life:.85, hits: new Set(), pierce: stat.pierce(pl), owner: pl.id });
  }
}
function summon(pl) {
  if (pl.sumCd > 0) return;
  if (pl.souls <= 0) return;
  const alive = room.sp.filter(s => s.owner === pl.id).length;
  const n = Math.min(pl.souls, stat.maxSpirits(pl) - alive);
  if (n <= 0) return;
  pl.souls -= n; pl.sumCd = 1.5;
  ev('summon', { x: pl.x, y: pl.y });
  for (let i = 0; i < n; i++) { const a = Math.random()*6.28; room.sp.push({ owner: pl.id, x: pl.x+Math.cos(a)*30, y: pl.y+Math.sin(a)*30, t:0, life: stat.spLife(pl), cd:0, idx: Math.random()*6.28 }); }
}
function salpuri(pl) {
  if (pl.salCd > 0) return;
  pl.salCd = stat.salCd(pl);
  const R = stat.fanR(pl);
  ev('sal', { x: pl.x, y: pl.y, r: R });
  const kb = HAS(pl,'wind') ? 3 : 1;
  for (const e of room.en) { if (e.hp<=0) continue; const dx=e.x-pl.x, dy=e.y-pl.y, d=Math.hypot(dx,dy)||1; if (d<R+e.r) { e.curse=5; if (HAS(pl,'maple')) e.burn=5; hitEnemy(e,10,dx/d*200*kb,dy/d*200*kb,false,pl.id,'sal'); } }
}
function purify(pl) {
  const cost = 4 + Math.floor(room.t / 30);
  if (room.trans || pl.oil < cost) return;
  pl.oil -= cost; room.c = Math.max(0, room.c - 18);
  ev('pur', { x: pl.x, y: pl.y });
}
function collapse() { room.collapsed = true; room.obs.forEach(o => { if (Math.random()<.4) o.dying = true; }); }
function transform() {
  room.trans = true; room.c = 100; room.stage = 4;
  genMap((Math.random()*1e9)|0, true);
  ev('transform', {});
  room.bossT = 3.2;
}

function tickPlayer(pl) {
  if (!pl.alive) return;
  let mx = pl.input.dx, my = pl.input.dy;
  const mm = Math.hypot(mx, my); if (mm > 1) { mx /= mm; my /= mm; }
  const spd = stat.speed(pl);
  pl.x += mx*spd*DT; pl.y += my*spd*DT;
  if (mm > .15) pl.mv = Math.atan2(my, mx);
  collideObs(pl, 14);
  pl.x = clamp(pl.x, 20, WS_SIZE-20); pl.y = clamp(pl.y, 20, WS_SIZE-20);

  let near = null, nd = 400;
  for (const e of room.en) { const d = Math.hypot(e.x-pl.x, e.y-pl.y)-e.r; if (d<nd) { nd=d; near=e; } }
  pl.face = near ? Math.atan2(near.y-pl.y, near.x-pl.x) : pl.mv;

  pl.atkCd -= DT; pl.sumCd -= DT; pl.salCd -= DT; pl.invCd -= DT; pl.obangCd -= DT;
  if (pl.input.atk && pl.atkCd <= 0) { pl.atkCd = stat.atkCd(pl); fireBell(pl); }
  if (L(pl,'auto') && pl.souls >= stat.maxSouls(pl) && pl.sumCd <= 0) summon(pl);
}

function tick() {
  if (!room || players.size === 0) return;
  room.events = [];
  if (room.over) { broadcastState(); return; }
  room.t += DT;

  if (!room.trans) {
    room.c = Math.min(100, room.c + (0.55 + 0.25*Math.min(room.stage,3))*DT);
    const ns = stageOf(room.c);
    if (ns !== room.stage) {
      if (ns === 4) transform();
      else { if (ns > room.maxStage) { ev('stage', { msg: STAGE_MSG[ns] }); room.maxStage = ns; } if (ns === 2 && !room.collapsed) collapse(); room.stage = ns; }
    }
  }
  if (room.bossT > 0) {
    room.bossT -= DT;
    if (room.bossT <= 0) {
      const ref = alivePlayers()[0];
      if (ref) { const a = Math.random()*6.28;
        spawnEnemy('boss', clamp(ref.x+Math.cos(a)*380,80,WS_SIZE-80), clamp(ref.y+Math.sin(a)*380,80,WS_SIZE-80));
        ev('bossSpawn', {});
      }
    }
  }

  for (const o of room.obs) { if (o.dying) o.rise -= DT*.8; else if (o.rise<1) o.rise = Math.min(1, o.rise+DT*.8); }
  room.obs = room.obs.filter(o => !(o.dying && o.rise <= 0));

  for (const pl of players.values()) tickPlayer(pl);

  // 적 생성
  room.spawn -= DT;
  const cap = room.trans ? 50 : 38;
  if (room.spawn <= 0 && alivePlayers().length) {
    const lvl = room.trans ? 4 : room.stage;
    room.spawn = Math.max(.28, 1.4 - lvl*.26 - room.t/600);
    if (room.en.length < cap) {
      const ref = alivePlayers()[(Math.random()*alivePlayers().length)|0];
      const type = room.t < 15 ? 'ghoul' : pickType(lvl);
      const a = Math.random()*6.28, dist = 700;
      const x = clamp(ref.x+Math.cos(a)*dist, 30, WS_SIZE-30), y = clamp(ref.y+Math.sin(a)*dist, 30, WS_SIZE-30);
      if (Math.hypot(x-ref.x, y-ref.y) > 260) {
        spawnEnemy(type, x, y);
        if (type === 'ghoul' && Math.random()<.35) for (let k=0;k<3;k++) spawnEnemy('ghoul', x+(Math.random()-.5)*60, y+(Math.random()-.5)*60);
      }
    }
  }

  // 방울 투사체
  for (const pr of room.proj) {
    pr.t += DT; pr.x += pr.vx*DT; pr.y += pr.vy*DT;
    for (const e of room.en) { if (e.hp<=0 || pr.hits.has(e)) continue;
      if (Math.hypot(e.x-pr.x, e.y-pr.y) < e.r+9) { const owner=players.get(pr.owner); hitEnemy(e, stat.bellDmg(owner||{up:{},G:{}}), pr.vx*.25, pr.vy*.25, true, pr.owner, 'bell'); pr.hits.add(e); pr.pierce--; if (pr.pierce<=0) { pr.dead=true; break; } } }
    for (const o of room.obs) { if (o.rise>.5 && Math.hypot(o.x-pr.x,o.y-pr.y)<o.r*o.rise) { pr.dead=true; break; } }
  }
  room.proj = room.proj.filter(pr => !pr.dead && pr.t < pr.life);

  // 적 투사체
  for (const q of room.eproj) {
    q.t += DT; q.x += q.vx*DT; q.y += q.vy*DT;
    for (const o of room.obs) { if (o.rise>.5 && Math.hypot(o.x-q.x,o.y-q.y)<o.r*o.rise) { q.dead=true; break; } }
    if (!q.dead) for (const pl of alivePlayers()) { if (pl.invCd<=0 && Math.hypot(pl.x-q.x,pl.y-q.y)<q.r+13) { q.dead=true; hurt(pl,q.dmg); break; } }
  }
  room.eproj = room.eproj.filter(q => !q.dead && q.t < q.life);

  // 원혼
  for (const s of room.sp) {
    s.t += DT; s.cd -= DT;
    const owner = players.get(s.owner);
    let tgt=null, td=Infinity;
    if (owner) for (const e of room.en) { if (e.hp<=0 || Math.hypot(e.x-owner.x,e.y-owner.y)>460) continue; const d=Math.hypot(e.x-s.x,e.y-s.y); if (d<td) { td=d; tgt=e; } }
    let tx,ty;
    if (tgt) { tx=tgt.x; ty=tgt.y;
      if (td < tgt.r+10 && s.cd<=0) { const dx=tgt.x-s.x, dy=tgt.y-s.y, d=td||1;
        hitEnemy(tgt, owner?stat.spDmg(owner):9, dx/d*90, dy/d*90, true, s.owner); s.cd=.5;
        if (owner && L(owner,'leech') && Math.random()<.15*L(owner,'leech') && owner.hp<owner.max) owner.hp=Math.min(owner.max,owner.hp+2); }
    } else if (owner) { const a=room.t*1.6+s.idx; tx=owner.x+Math.cos(a)*42; ty=owner.y+Math.sin(a)*42; }
    else { tx=s.x; ty=s.y; }
    const dx=tx-s.x, dy=ty-s.y, d=Math.hypot(dx,dy);
    if (d>2) { const m=Math.min(d,185*DT); s.x+=dx/d*m; s.y+=dy/d*m; }
    if (s.t>=s.life && owner && L(owner,'burst')) explode(s.x,s.y,70,25*L(owner,'burst'));
  }
  room.sp = room.sp.filter(s => s.t < s.life);

  // 적 AI
  const damp = Math.pow(.02, DT);
  for (const e of room.en) {
    if (e.hp<=0) continue;
    const tgt = nearestPlayer(e.x,e.y);
    const dx = tgt?tgt.x-e.x:0, dy = tgt?tgt.y-e.y:0, d = Math.hypot(dx,dy)||1, ux=dx/d, uy=dy/d;
    const slow = e.curse>0?.5:1; let vx=0,vy=0;
    e.cd-=DT; e.st-=DT;
    if (e.type==='charger') {
      if (e.state==='aim') { if (e.st<=0) { e.state='dash'; e.st=.42; } }
      else if (e.state==='dash') { vx=e.dx*540*slow; vy=e.dy*540*slow; if (e.st<=0) { e.state='rest'; e.st=.5; } }
      else if (e.state==='rest') { if (e.st<=0) e.state='chase'; }
      else { vx=ux*e.spd*slow; vy=uy*e.spd*slow; if (d<250 && e.cd<=0) { e.state='aim'; e.st=.62/slow; e.dx=ux; e.dy=uy; e.cd=2.8; } }
    } else if (e.type==='spitter') {
      const m = d>300?1:d<210?-1:0;
      vx=(ux*m+(-uy)*e.side*(m===0?.7:0))*e.spd*slow; vy=(uy*m+ux*e.side*(m===0?.7:0))*e.spd*slow;
      if (e.cd<=0 && d<440 && tgt) { e.charge+=DT; vx*=.2; vy*=.2; if (e.charge>=.45) { e.charge=0; e.cd=2.4;
        room.eproj.push({ x:e.x, y:e.y, vx:ux*190, vy:uy*190, r:7, dmg:10, t:0, life:3.2 }); } }
    } else if (e.type==='bomber') {
      if (e.fuse>0) { e.fuse-=DT; if (e.fuse<=0) { e.fused=true; e.noReward=true; e.hp=0; explode(e.x,e.y,90,40); } }
      else { vx=ux*e.spd*slow; vy=uy*e.spd*slow; if (d<50) e.fuse=.7; }
    } else { vx=ux*e.spd*slow; vy=uy*e.spd*slow; }
    e.x+=(vx+e.kx)*DT; e.y+=(vy+e.ky)*DT; e.kx*=damp; e.ky*=damp; e.wob+=DT*6;
    collideObs(e,e.r); e.x=clamp(e.x,e.r,WS_SIZE-e.r); e.y=clamp(e.y,e.r,WS_SIZE-e.r);
    e.hitCd-=DT; e.flash-=DT; e.curse-=DT;
    if (e.burn>0) { e.burn-=DT; e.burnT=(e.burnT||0)+DT; if (e.burnT>=.5) { e.burnT=0; const bOwner=e.lastSrc?players.get(e.lastSrc):null; hitEnemy(e, bOwner?stat.bellDmg(bOwner)*.45:6, 0, 0, false, e.lastSrc, 'burn'); } }
    if (tgt && d<e.r+14 && e.hitCd<=0 && tgt.invCd<=0) { hurt(tgt, e.state==='dash'?Math.round(e.dmg*1.3):e.dmg); e.hitCd=.8; }
    if (e.type==='boss') {
      e.wave-=DT; if (e.wave<=0) { e.wave=3.2; ev('shockwave', {x:e.x,y:e.y}); for (const pl of alivePlayers()) if (pl.invCd<=0 && Math.abs(Math.hypot(pl.x-e.x,pl.y-e.y)-360)<40) hurt(pl,16); }
      e.summonT-=DT; if (e.summonT<=0) { e.summonT=7; for (let k=0;k<4;k++) { const a=k/4*6.28; spawnEnemy(k%2?'ghoul':'charger', e.x+Math.cos(a)*70, e.y+Math.sin(a)*70); } }
    }
  }
  for (let i=0;i<room.en.length;i++) for (let j=i+1;j<room.en.length;j++) {
    const a=room.en[i], b=room.en[j], dx=b.x-a.x, dy=b.y-a.y, d=Math.hypot(dx,dy), rr=a.r+b.r;
    if (d<rr && d>0.01) { const push=(rr-d)/2, ux=dx/d, uy=dy/d; const wa=a.type==='boss'?.1:1, wb=b.type==='boss'?.1:1; a.x-=ux*push*wa; a.y-=uy*push*wa; b.x+=ux*push*wb; b.y+=uy*push*wb; }
  }
  const dead = room.en.filter(e => e.hp<=0); room.en = room.en.filter(e => e.hp>0); dead.forEach(killEnemy);

  for (const pl of alivePlayers()) {
    const mg = stat.magnet(pl);
    for (const d of room.drops) {
      if (d.got) continue;
      const dx=pl.x-d.x, dy=pl.y-d.y, dd=Math.hypot(dx,dy);
      if (dd<mg) { const s=(1-dd/mg)*420+80; d.x+=dx/dd*s*DT; d.y+=dy/dd*s*DT; }
      if (dd<18) { d.got=true; if (d.kind==='oil') { pl.oil+=d.v; pl.oilTotal+=d.v; } else { pl.hp=Math.min(pl.max,pl.hp+d.v); } }
    }
    for (const l of room.loot) {
      if (l.got) continue;
      if (Math.hypot(pl.x-l.x, pl.y-l.y) < 26) {
        if (pl.bag.length >= BAG_MAX) { if (!l.warned) { ev('bagFull', { id: pl.id }); l.warned = true; } continue; }
        pl.bag.push(l.it); l.got = true; if (l.it.r === 3) pl.legends++;
        ev('pick', { id: pl.id, x: pl.x, y: pl.y, name: l.it.name, color: RAR[l.it.r].c, big: l.it.r >= 2 });
        pushInventory(pl);
      }
    }
  }
  for (const d of room.drops) d.t += DT;
  room.drops = room.drops.filter(d => !d.got && d.t < 40);
  for (const l of room.loot) l.t += DT;
  room.loot = room.loot.filter(l => !l.got);

  broadcastState();
}

function playerView(pl) {
  return { id: pl.id, name: pl.name, color: pl.color, x: Math.round(pl.x), y: Math.round(pl.y), face: Math.round(pl.face*100)/100,
    hp: Math.round(pl.hp), max: pl.max, lv: pl.lv, xp: Math.round(pl.xp), xpNeed: xpNeed(pl), oil: pl.oil, souls: pl.souls,
    maxSouls: stat.maxSouls(pl), kills: pl.kills, alive: pl.alive, invFlicker: pl.invCd>0 };
}
function broadcastState() {
  const state = {
    type: 'state', t: room.t, c: Math.round(room.c*10)/10, stage: room.stage, trans: room.trans, over: room.over,
    obs: room.obs.map(o => ({ x:Math.round(o.x), y:Math.round(o.y), r:Math.round(o.r*o.rise), kind:o.kind })),
    en: room.en.map(e => ({ type:e.type, x:Math.round(e.x), y:Math.round(e.y), r:e.r, hp:Math.round(e.hp), max:Math.round(e.max),
      flash:e.flash>0, curse:e.curse>0, state:e.state, dx:e.dx, dy:e.dy, st:e.st, wob:e.wob, charge:e.charge, fuse:e.fuse, burn:e.burn>0 })),
    proj: room.proj.map(p => ({ x:Math.round(p.x), y:Math.round(p.y), vx:p.vx, vy:p.vy })),
    eproj: room.eproj.map(q => ({ x:Math.round(q.x), y:Math.round(q.y), r:q.r })),
    sp: room.sp.map(s => ({ owner:s.owner, x:Math.round(s.x), y:Math.round(s.y), idx:s.idx, life:s.life, t:s.t })),
    drops: room.drops.filter(d=>!d.got).map(d => ({ x:Math.round(d.x), y:Math.round(d.y), kind:d.kind })),
    loot: room.loot.filter(l=>!l.got).map(l => ({ x:Math.round(l.x), y:Math.round(l.y), name:l.it.name, r:l.it.r, col:RAR[l.it.r].c })),
    boss: room.boss ? { x:Math.round(room.boss.x), y:Math.round(room.boss.y), hp:Math.round(room.boss.hp), max:room.boss.max } : null,
    players: [...players.values()].map(playerView),
    events: room.events
  };
  const msg = JSON.stringify(state);
  for (const pl of players.values()) if (pl.ws.readyState === 1) pl.ws.send(msg);
}
function sendTo(pl, obj) { if (pl.ws.readyState === 1) pl.ws.send(JSON.stringify(obj)); }
function pushInventory(pl) {
  sendTo(pl, { type:'inventory', eq: pl.eq, bag: pl.bag, G: pl.G, legends: pl.legends, oilTotal: pl.oilTotal });
}

newRoom();

const httpServer = http.createServer((req, res) => {
  let reqPath = decodeURIComponent(req.url.split('?')[0]);
  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, reqPath);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});
const wss = new WebSocketServer({ server: httpServer });
wss.on('connection', ws => {
  if (players.size >= MAX_PLAYERS) { ws.send(JSON.stringify({type:'full'})); ws.close(); return; }
  const id = nextId++;
  const pl = newPlayer(id, ws);
  players.set(id, pl);
  console.log(`[join] #${id} (현재 ${players.size}명)`);
  sendTo(pl, { type:'welcome', id, color: pl.color, world:{w:WS_SIZE,h:WS_SIZE,ts:TS,tn:TN}, seed: room.seed, trans: room.trans });
  pushInventory(pl);

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'input') {
      let dx=Number(msg.dx)||0, dy=Number(msg.dy)||0; const len=Math.hypot(dx,dy); if (len>1) { dx/=len; dy/=len; }
      pl.input.dx=dx; pl.input.dy=dy; pl.input.atk=!!msg.atk;
    } else if (msg.type === 'action') {
      if (!pl.alive) return;
      if (msg.which==='sum') summon(pl); else if (msg.which==='sal') salpuri(pl); else if (msg.which==='pur') purify(pl);
    } else if (msg.type === 'choose') {
      chooseUp(pl, msg.id);
    } else if (msg.type === 'name' && typeof msg.name === 'string') {
      pl.name = msg.name.slice(0,12) || pl.name;
    } else if (msg.type === 'restart') {
      // 캐릭터(레벨·장비·가방)는 파티가 전멸해도 그대로 이어간다 — 구역(맵·저주·적)만 새로 만든다.
      if (room.over) { newRoom(); for (const p2 of players.values()) { p2.hp=stat.maxHp(p2);p2.max=stat.maxHp(p2);p2.oil=0;p2.souls=0;p2.kills=0;p2.alive=true;p2.pendingLv=0;p2.choosing=null;
        p2.x=clamp(WS_SIZE/2+(Math.random()*80-40),20,WS_SIZE-20); p2.y=clamp(WS_SIZE/2+(Math.random()*80-40),20,WS_SIZE-20);
        sendTo(p2, { type:'welcome', id:p2.id, color:p2.color, world:{w:WS_SIZE,h:WS_SIZE,ts:TS,tn:TN}, seed: room.seed, trans:false }); } }
    } else if (msg.type === 'equip') {
      const it = pl.bag[msg.i]; if (!it) return;
      const old = pl.eq[it.slot]; pl.eq[it.slot] = it; pl.bag.splice(msg.i,1); if (old) pl.bag.push(old);
      recalc(pl); pushInventory(pl);
    } else if (msg.type === 'unequip') {
      if (!SLOT_KEYS.includes(msg.slot) || pl.bag.length >= BAG_MAX) return;
      const it = pl.eq[msg.slot]; if (!it) return;
      pl.eq[msg.slot] = null; pl.bag.push(it); recalc(pl); pushInventory(pl);
    } else if (msg.type === 'salvage') {
      let it;
      if (msg.from === 'bag' && pl.bag[msg.i]) it = pl.bag.splice(msg.i,1)[0];
      else if (msg.from === 'eq' && SLOT_KEYS.includes(msg.slot) && pl.eq[msg.slot]) { it = pl.eq[msg.slot]; pl.eq[msg.slot] = null; recalc(pl); }
      if (it) { pl.oil += RAR[it.r].salv; pl.oilTotal += RAR[it.r].salv; pushInventory(pl); }
    } else if (msg.type === 'salvageAll') {
      let n = 0;
      pl.bag = pl.bag.filter(it => { if (it.r <= 1) { n += RAR[it.r].salv; return false; } return true; });
      if (n) { pl.oil += n; pl.oilTotal += n; }
      pushInventory(pl);
    } else if (msg.type === 'rejoin') {
      // 파티 전멸은 아니고 혼자 쓰러진 경우 — 같은 구역에 바로 되돌아온다 (레벨·장비 그대로, 체력만 회복)
      if (!room.over && !pl.alive) {
        const anchor = alivePlayers()[0];
        pl.x = clamp((anchor?anchor.x:WS_SIZE/2) + (Math.random()*80-40), 20, WS_SIZE-20);
        pl.y = clamp((anchor?anchor.y:WS_SIZE/2) + (Math.random()*80-40), 20, WS_SIZE-20);
        pl.hp = stat.maxHp(pl); pl.max = stat.maxHp(pl); pl.alive = true; pl.invCd = 1.2;
        ev('rejoin', { id: pl.id, x: pl.x, y: pl.y });
      }
    }
  });
  ws.on('close', () => { players.delete(id); console.log(`[leave] #${id} (현재 ${players.size}명)`); });
});

setInterval(tick, TICK_MS);
httpServer.listen(PORT, () => console.log(`신시 협동 서버 — 포트 ${PORT} (정적 파일 + WebSocket 통합)`));
