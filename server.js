/**
 * RemoteDesk 中继服务器（公网部署版）
 *
 * 职责：
 *  - 设备码配对：被控端用 4~10 位设备码注册，控制端用同一码申请接入
 *  - 强制鉴权门禁：控制端必须通过被控端的「授权页 + 人脸验证」，服务器才会
 *    把视频帧下发、把控制指令上送。未授权 = 看不到画面、发不出指令，
 *    且服务端静默丢弃，不给任何可探测的反馈。
 *  - 媒体转发：H.264 二进制帧原样透传（不解码、不落盘），带背压丢帧
 *
 * 合规设计：服务器不存储任何画面内容，中继过程全内存，连接断开即丢弃。
 *
 * 公网部署要点（相对于局域网版的三处改动）：
 *  1. 监听 PORT 环境变量并显式绑定 0.0.0.0
 *  2. 反代环境下用 X-Forwarded-For 取真实 IP，否则限流会把所有公网用户
 *     算成同一个 IP，20 次/分钟直接把服务打废
 *  3. 心跳保活：移动网络 + 反代都有空闲超时，不 ping 会被静默掐断
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;
const HOST = process.env.HOST || '0.0.0.0';
const WEB_DIR = path.join(__dirname, 'web');

// 单帧积压上限（字节）：超过就丢弃新帧，宁可掉帧也不要累积延迟。
//
// 重要：这个上限直接决定了"控制端卡死"还是"控制端降帧但还能看"。
// 公网/蜂窝网络下控制端下行速率会抖动，若上限设得过大（如 2MB），
// 一旦缓冲被瞬时打满就会一直顶在阈值之上 —— 此后每一帧都被丢弃，
// 控制端收不到任何新帧 → 表现为 0 kbps / 黑屏，且永远不恢复。
// 因此这里取一个与视频码率挂钩的小值：约 1 秒（1 Mbps ≈ 128 KB）的
// 余量即可吸收瞬时抖动，又能保证缓冲被打满后很快排空、恢复出帧。
// 实时视频的正确语义是"掉几帧继续播"，而不是"卡住等缓冲"。
const MAX_BUFFERED_BYTES = 512 * 1024;

// 背压丢帧计数 + 周期性告警，便于运维发现"公网控制端下行过慢"这类问题
let backpressureDrops = 0;
let lastBpWarn = 0;

// 心跳周期：必须小于常见反代（多为 60s）的空闲超时
const HEARTBEAT_MS = 25_000;

/** code -> { host, secret, name, meta, controllers: Map<cid, {ws, name, authorized}> } */
const rooms = new Map();

// 简易防暴破：同一 IP 每分钟 join 尝试上限
const joinAttempts = new Map();

function now() { return Date.now(); }

/**
 * 取客户端真实 IP。
 * 公网部署时前面一定有反代，req.socket.remoteAddress 永远是网关地址，
 * 直接拿它做限流 = 全世界共享 20 次/分钟的额度，服务等于不可用。
 */
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const first = String(xff).split(',')[0].trim();
    if (first) return first;
  }
  return req.socket.remoteAddress || 'unknown';
}

function allowJoin(ip) {
  const list = (joinAttempts.get(ip) || []).filter((t) => now() - t < 60_000);
  list.push(now());
  joinAttempts.set(ip, list);
  // 限流表本身也要清理，否则公网跑久了会无限膨胀
  if (joinAttempts.size > 5000) {
    for (const [k, v] of joinAttempts) {
      if (!v.some((t) => now() - t < 60_000)) joinAttempts.delete(k);
    }
  }
  return list.length <= 20;
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch (_) { }
  }
}

function sendBinary(ws, buf) {
  if (!ws || ws.readyState !== 1) return false;
  if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
    // 背压：下游（控制端）消费不过来。丢当前帧，让链路保持"实时掉帧"而非"卡死黑屏"。
    backpressureDrops++;
    const now = Date.now();
    if (now - lastBpWarn > 5000) {
      lastBpWarn = now;
      console.warn(`[relay] backpressure drop #${backpressureDrops}: controller bufferedAmount=${ws.bufferedAmount} > ${MAX_BUFFERED_BYTES} (下行过慢)`);
    }
    return false;
  }
  try { ws.send(buf, { binary: true }); return true; } catch (_) { return false; }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, ts: now() }));
    return;
  }

  // 网页版控制端（备用入口）：https://<域名>/ 直接打开
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const file = path.join(WEB_DIR, 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  res.writeHead(404); res.end('not found');
});

const wss = new WebSocketServer({
  server,
  maxPayload: 8 * 1024 * 1024,
  // 关键：显式关闭服务端 permessage-deflate 压缩。
  // 虽然 ws 的 WebSocketServer 默认已是 false，但 Android 端用的是 OkHttp
  // WebSocket 客户端（不支持 RFC 7692 解压）。显式关掉可彻底排除"服务端
  // 压缩 → 客户端解不出 → 0 kbps / 黑屏"这一整类兼容性问题，也防止未来
  // ws 版本改动默认值后重新引入该隐患。
  perMessageDeflate: false
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const ip = clientIp(req);

  // 心跳标记：pong 回来就续命
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  if (url.pathname === '/host') setupHost(ws, ip);
  else if (url.pathname === '/controller') setupController(ws, ip);
  else { ws.close(1008, 'unknown path'); }
});

// 心跳巡检：两轮没收到 pong 就判定死连接并强杀
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) { ws.terminate(); }
  }
}, HEARTBEAT_MS);
heartbeat.unref?.();

// ------------------------------------------------------------------ 被控端

function setupHost(ws, ip) {
  let room = null;

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      // 视频帧：只转发给已授权的控制器
      if (!room) return;
      for (const c of room.controllers.values()) {
        if (c.authorized) sendBinary(c.ws, data);
      }
      return;
    }

    let msg;
    try { msg = JSON.parse(data.toString()); } catch (_) { return; }

    switch (msg.t) {
      case 'register': {
        const code = String(msg.code || '').toUpperCase();
        if (!/^[A-Z0-9]{4,10}$/.test(code)) {
          send(ws, { t: 'error', msg: '设备码格式非法' });
          return;
        }
        let r = rooms.get(code);
        if (r && r.secret !== msg.secret && r.host && r.host.readyState === 1) {
          // 同一设备码已被另一台主机占用：拒绝，防止顶号劫持
          send(ws, { t: 'error', msg: '设备码已被占用' });
          ws.close(1008, 'code occupied');
          return;
        }
        if (!r) {
          r = { host: null, secret: msg.secret, name: msg.name || 'device', controllers: new Map() };
          rooms.set(code, r);
        }
        r.host = ws;
        r.secret = msg.secret;
        r.name = msg.name || r.name;
        room = r;
        room.code = code;
        console.log(`[host] registered code=${code} name=${r.name} from=${ip}`);
        send(ws, { t: 'registered', code });
        return;
      }

      case 'join_decision': {
        if (!room) return;
        const c = room.controllers.get(msg.cid);
        if (!c) return;
        if (msg.allow) {
          c.authorized = true;
          send(c.ws, { t: 'joined', cid: msg.cid, name: room.name });
          // 关键：给新接入的控制端补发一次画面分辨率。
          // 否则控制端的解码器拿不到宽高，无法完成 configure。
          if (room.meta) send(c.ws, { t: 'meta', ...room.meta });
          send(c.ws, { t: 'auth_state', state: 'ok' });
          console.log(`[host] approved cid=${msg.cid} code=${room.code} from=${c.ip}`);
        } else {
          send(c.ws, { t: 'error', msg: msg.reason || '机主拒绝接入' });
          room.controllers.delete(msg.cid);
          c.ws.close(1011, 'denied');
          console.log(`[host] denied cid=${msg.cid} reason=${msg.reason}`);
        }
        return;
      }

      case 'auth_result': {
        if (!room) return;
        const c = room.controllers.get(msg.cid);
        if (!c) return;
        c.authorized = !!msg.ok;
        send(c.ws, { t: 'auth_state', state: msg.ok ? 'ok' : 'fail' });
        if (!msg.ok) {
          room.controllers.delete(msg.cid);
          c.ws.close(1011, 'auth failed');
        }
        return;
      }

      case 'meta': {
        if (!room) return;
        room.meta = msg;
        for (const c of room.controllers.values()) {
          if (c.authorized) send(c.ws, { t: 'meta', ...msg });
        }
        return;
      }

      case 'event': {
        if (!room) return;
        for (const c of room.controllers.values()) {
          if (c.authorized) send(c.ws, msg);
        }
        return;
      }

      case 'stop': {
        if (!room) return;
        for (const c of room.controllers.values()) {
          send(c.ws, { t: 'peer_left', reason: 'host ended session' });
          c.ws.close(1000, 'host stopped');
        }
        room.controllers.clear();
        return;
      }
    }
  });

  ws.on('close', () => {
    if (room) {
      for (const c of room.controllers.values()) {
        send(c.ws, { t: 'peer_left', reason: 'host offline' });
        c.ws.close(1000, 'host offline');
      }
      room.controllers.clear();
      room.host = null;
      console.log(`[host] disconnected code=${room.code}`);
      // 保留房间 5 分钟，方便被控端断线重连
      setTimeout(() => {
        const r = rooms.get(room.code);
        if (r && (!r.host || r.host.readyState !== 1)) rooms.delete(room.code);
      }, 5 * 60_000).unref?.();
    }
  });
}

// ------------------------------------------------------------------ 控制端

function setupController(ws, ip) {
  let room = null;
  let cid = null;

  ws.on('message', (data, isBinary) => {
    if (isBinary) return; // 控制端不应上传视频

    let msg;
    try { msg = JSON.parse(data.toString()); } catch (_) { return; }

    switch (msg.t) {
      case 'join': {
        if (!allowJoin(ip)) {
          send(ws, { t: 'error', msg: '尝试过于频繁，请稍后再试' });
          ws.close(1008, 'rate limited');
          return;
        }
        const code = String(msg.code || '').toUpperCase();
        const r = rooms.get(code);
        if (!r || !r.host || r.host.readyState !== 1) {
          send(ws, { t: 'error', msg: '设备不在线或设备码不存在' });
          return;
        }
        room = r;
        cid = `${now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        room.controllers.set(cid, {
          ws, name: msg.name || '控制端', authorized: false, ip, joinedAt: now()
        });
        send(ws, { t: 'auth_required', cid, device: r.name });
        send(r.host, {
          t: 'join_request',
          cid,
          name: msg.name || '控制端',
          from: ip
        });
        console.log(`[ctrl] join request cid=${cid} code=${code} from=${ip}`);
        return;
      }

      case 'control': {
        if (!room || !cid) return;
        const c = room.controllers.get(cid);
        if (!c || !c.authorized) {
          // 未授权：静默丢弃，不给攻击者任何探测反馈
          return;
        }
        if (room.host && room.host.readyState === 1) {
          send(room.host, { t: 'control', ...msg });
        }
        return;
      }

      case 'leave': {
        if (room && cid) {
          room.controllers.delete(cid);
          if (room.host) send(room.host, { t: 'peer_left', cid });
        }
        return;
      }
    }
  });

  ws.on('close', () => {
    if (room && cid) {
      room.controllers.delete(cid);
      if (room.host && room.host.readyState === 1) {
        send(room.host, { t: 'peer_left', cid });
      }
      console.log(`[ctrl] left cid=${cid}`);
    }
  });
}

server.listen(PORT, HOST, () => {
  console.log(`RemoteDesk relay listening on http://${HOST}:${PORT}`);
  console.log(`  host endpoint:       ws(s)://<host>/host`);
  console.log(`  controller endpoint: ws(s)://<host>/controller`);
  console.log(`  web console:         http://localhost:${PORT}/`);
});

// 优雅退出：让被控端/控制端能立刻重连，而不是等 TCP 超时
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[relay] ${sig} received, closing`);
    clearInterval(heartbeat);
    for (const ws of wss.clients) { try { ws.close(1001, 'server restarting'); } catch (_) { } }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref?.();
  });
}
