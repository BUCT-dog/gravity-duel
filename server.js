const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const W = 1200, H = 700, PR = 38, GR = 230, GS = 1200;
const PLAYER_SPEED = 4.5, MAX_AST = 20, MAX_HP = 5, ROUND = 180;
const PHYS_TICK = 33, CAST_TICK = 50; // 物理30fps, 广播20fps

const MIME = {'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon'};
const server = http.createServer((req, res) => {
  const fp = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  fs.readFile(fp, (e, d) => {
    if (e) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, {'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream'});
    res.end(d);
  });
});

const wss = new WebSocket.Server({ server });
const rooms = new Map();
const $ = Math; // shorthand

function rid() { const c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s=''; for(let i=0;i<4;i++)s+=c[$.floor($.random()*c.length)]; return s; }

function spawn(room) {
  const side = $.floor($.random()*4); let x, y;
  const tx = 180+$.random()*(W-360), ty = 100+$.random()*(H-200);
  if(side===0){x=-30;y=$.random()*H}else if(side===1){x=W+30;y=$.random()*H}else if(side===2){x=$.random()*W;y=-30}else{x=$.random()*W;y=H+30}
  const a = $.atan2(ty-y,tx-x)+($.random()-.5)*.8, sp = 2+$.random()*3;
  room.asteroids.push({x,y,vx:$.cos(a)*sp,vy:$.sin(a)*sp,r:7+$.random()*7});
}

function tick(room) {
  for (const p of room.players) {
    if(!p.keys) continue;
    let dx=0,dy=0;
    if(p.keys.up)dy-=1; if(p.keys.down)dy+=1; if(p.keys.left)dx-=1; if(p.keys.right)dx+=1;
    if(dx&&dy){dx*=.7071;dy*=.7071}
    p.x = p.x+dx*PLAYER_SPEED; if(p.x<PR)p.x=PR; if(p.x>W-PR)p.x=W-PR;
    p.y = p.y+dy*PLAYER_SPEED; if(p.y<PR)p.y=PR; if(p.y>H-PR)p.y=H-PR;
  }
  for (const a of room.asteroids) {
    for (const p of room.players) {
      const d = $.hypot(a.x-p.x, a.y-p.y);
      if(d<GR&&d>8){const f=GS/(d*d); a.vx+=((p.x-a.x)/d)*f; a.vy+=((p.y-a.y)/d)*f;}
    }
    const s=$.hypot(a.vx,a.vy); if(s>9){a.vx=a.vx/s*9; a.vy=a.vy/s*9;}
    a.x+=a.vx; a.y+=a.vy;
  }
  for (let i=room.asteroids.length-1;i>=0;i--) {
    for (const p of room.players) {
      if($.hypot(room.asteroids[i].x-p.x,room.asteroids[i].y-p.y)<PR+room.asteroids[i].r){
        p.hp--; bc(room,{type:'hit',player:p.number,x:room.asteroids[i].x,y:room.asteroids[i].y});
        room.asteroids.splice(i,1); break;
      }
    }
  }
  room.asteroids=room.asteroids.filter(a=>a.x>-120&&a.x<W+120&&a.y>-120&&a.y<H+120);
  room.spawnTimer-=PHYS_TICK;
  if(room.spawnTimer<=0&&room.asteroids.length<MAX_AST){spawn(room); room.spawnTimer=800+$.random()*800;}
  room.gameTimer-=PHYS_TICK/1000;
  const dead=room.players.filter(p=>p.hp<=0);
  if(dead.length>0){room.state='ended'; room.winner=room.players.find(p=>p.hp>0)?.number||0;}
  else if(room.gameTimer<=0){room.state='ended'; const[a,b]=room.players; room.winner=a.hp>b.hp?a.number:b.hp>a.hp?b.number:0;}
}

function state(room) {
  return {type:'game_state',ts:Date.now(),
    players:room.players.map(p=>({n:p.number,x:p.x,y:p.y,hp:p.hp})),
    asteroids:room.asteroids.map(a=>({x:a.x,y:a.y,vx:a.vx,vy:a.vy,r:a.r})),
    time:$.max(0,$.ceil(room.gameTimer)), state:room.state, winner:room.winner};
}

function bc(room,msg){const d=JSON.stringify(msg); for(const p of room.players) if(p.ws.readyState===WebSocket.OPEN)p.ws.send(d);}

let started=false;
function loop(){
  if(started)return; started=true;
  setInterval(()=>{
    const now=Date.now();
    for(const room of rooms.values()){
      if(room.state!=='playing')continue;
      const dt=now-room.lastPhys; room.lastPhys=now;
      for(let i=0;i<$.min($.round(dt/PHYS_TICK),4);i++)tick(room);
      if(now-room.lastCast>=CAST_TICK){room.lastCast=now; bc(room,state(room)); if(room.state==='ended')bc(room,{type:'game_over',winner:room.winner});}
    }
    for(const[id,room]of rooms) if(room.players.every(p=>p.ws.readyState>1))rooms.delete(id);
  },PHYS_TICK);
}

wss.on('connection',ws=>{
  ws.isAlive=true; let room=null, player=null;
  ws.on('pong',()=>{ws.isAlive=true});
  ws.on('message',raw=>{
    let m; try{m=JSON.parse(raw)}catch{return}
    switch(m.type){
      case'create_room':{
        room={id:rid(),players:[],asteroids:[],state:'waiting',spawnTimer:0,gameTimer:ROUND,winner:null,lastPhys:0,lastCast:0};
        while(rooms.has(room.id))room.id=rid(); rooms.set(room.id,room);
        player={ws,number:1,hp:MAX_HP,x:180,y:H/2,keys:{}}; room.players.push(player);
        ws.send(JSON.stringify({type:'room_created',roomId:room.id,player:1})); break;
      }
      case'join_room':{
        const code=(m.roomId||'').toUpperCase(); room=rooms.get(code);
        if(!room){ws.send(JSON.stringify({type:'error',message:'房间不存在'}));return}
        if(room.players.length>=2){ws.send(JSON.stringify({type:'error',message:'房间已满'}));return}
        player={ws,number:2,hp:MAX_HP,x:W-180,y:H/2,keys:{}}; room.players.push(player);
        ws.send(JSON.stringify({type:'joined',roomId:room.id,player:2}));
        room.state='playing'; room.lastPhys=Date.now(); room.lastCast=0; room.spawnTimer=300;
        for(let i=0;i<8;i++)spawn(room); bc(room,{type:'game_start'}); loop(); break;
      }
      case'input':{if(player&&room?.state==='playing')player.keys=m.keys||{}; break;}
      case'rematch':{
        if(!room||room.state!=='ended')break;
        if(!room.rv)room.rv=new Set(); room.rv.add(player?.number);
        const o=room.players.find(p=>p!==player);
        if(o?.ws.readyState===WebSocket.OPEN)o.ws.send(JSON.stringify({type:'rematch_requested'}));
        if(room.rv.size>=2){room.rv.clear(); room.asteroids=[]; room.gameTimer=ROUND; room.winner=null;
          room.state='playing'; room.lastPhys=Date.now(); room.lastCast=0; room.spawnTimer=300;
          for(const p of room.players){p.hp=MAX_HP; p.keys={}; p.x=p.number===1?180:W-180; p.y=H/2;}
          for(let i=0;i<8;i++)spawn(room); bc(room,{type:'game_start'});} break;
      }
    }
  });
  ws.on('close',()=>{
    if(!room)return;
    const o=room.players.find(p=>p!==player);
    if(o?.ws.readyState===WebSocket.OPEN)o.ws.send(JSON.stringify({type:'opponent_disconnected'}));
    if(room.players.every(p=>p===player||p.ws.readyState>1))rooms.delete(room.id);
  });
});

setInterval(()=>{wss.clients.forEach(ws=>{if(!ws.isAlive)return ws.terminate(); ws.isAlive=false; ws.ping();})},15000);

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`\n  🪐 引力对决 http://localhost:${PORT}\n`));
