// Tavla Online — bagimsiz sunucu
// Basit bir Express + WebSocket sunucusu: statik dosyalari sunar ve
// iki oyuncu arasinda oda durumunu (game state) gercek zamanli olarak iletir.
// Ayrica genel odalar (public lobby) icin bekleme listesi ve meydan okuma
// (challenge) akisini yonetir.

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// code -> { state: <object|null>, clients: Set<ws> }
const rooms = new Map();

// channelId (1-6) -> Map<connId, {ws, name}>
const CHANNEL_IDS = ['1', '2', '3', '4', '5', '6'];
const CHANNEL_CAPACITY = 50;
const channels = new Map(CHANNEL_IDS.map(id => [id, new Map()]));

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(code, msg, exceptWs) {
  const room = rooms.get(code);
  if (!room) return;
  for (const client of room.clients) {
    if (client !== exceptWs) send(client, msg);
  }
}

// Auto-expire empty rooms after a while to avoid unbounded memory growth.
function scheduleCleanup(code) {
  setTimeout(() => {
    const room = rooms.get(code);
    if (room && room.clients.size === 0) rooms.delete(code);
  }, 1000 * 60 * 30); // 30 dakika
}

function channelCounts() {
  const counts = {};
  for (const id of CHANNEL_IDS) counts[id] = channels.get(id).size;
  return counts;
}

function broadcastChannelCounts() {
  const counts = channelCounts();
  for (const client of wss.clients) send(client, { type: 'channelCounts', counts });
}

function channelWaitingList(channelId, exceptConnId) {
  const map = channels.get(channelId);
  if (!map) return [];
  const list = [];
  for (const [connId, entry] of map) {
    if (connId === exceptConnId) continue;
    list.push({ id: connId, name: entry.name });
  }
  return list;
}

function broadcastChannelList(channelId) {
  const map = channels.get(channelId);
  if (!map) return;
  for (const [connId, entry] of map) {
    send(entry.ws, { type: 'channelList', channel: channelId, players: channelWaitingList(channelId, connId) });
  }
}

function leaveChannel(ws) {
  if (!ws.channelId) return;
  const map = channels.get(ws.channelId);
  if (map) {
    map.delete(ws.connId);
    broadcastChannelList(ws.channelId);
    broadcastChannelCounts();
  }
  ws.channelId = null;
}

wss.on('connection', (ws) => {
  ws.roomCode = null;
  ws.channelId = null;
  ws.connId = crypto.randomBytes(6).toString('hex');
  ws.publicName = 'Oyuncu';

  send(ws, { type: 'channelCounts', counts: channelCounts() });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }

    if (msg.type === 'create') {
      const code = genCode();
      const room = { clients: new Set([ws]), state: msg.state || null };
      rooms.set(code, room);
      ws.roomCode = code;
      send(ws, { type: 'created', code, state: room.state });
      return;
    }

    if (msg.type === 'join') {
      const code = (msg.code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) {
        send(ws, { type: 'error', message: 'not_found' });
        return;
      }
      room.clients.add(ws);
      ws.roomCode = code;
      // Tell the joiner the current state, then let the client-side
      // logic mark the guest seat filled and push the updated state back.
      send(ws, { type: 'joined', code, state: room.state });
      return;
    }

    if (msg.type === 'state') {
      const code = ws.roomCode;
      if (!code || !rooms.has(code)) return;
      const room = rooms.get(code);
      room.state = msg.state;
      broadcast(code, { type: 'state', state: room.state }, ws);
      return;
    }

    // ---- Genel odalar (public lobby) ----

    if (msg.type === 'joinChannel') {
      const channelId = String(msg.channel);
      const map = channels.get(channelId);
      if (!map) return;
      if (map.size >= CHANNEL_CAPACITY) {
        send(ws, { type: 'channelFull', channel: channelId });
        return;
      }
      leaveChannel(ws); // bir onceki odadan cik (varsa)
      ws.publicName = (msg.name || 'Oyuncu').slice(0, 20);
      ws.channelId = channelId;
      map.set(ws.connId, { ws, name: ws.publicName });
      send(ws, { type: 'channelJoined', channel: channelId, yourId: ws.connId, players: channelWaitingList(channelId, ws.connId) });
      broadcastChannelList(channelId);
      broadcastChannelCounts();
      return;
    }

    if (msg.type === 'leaveChannel') {
      leaveChannel(ws);
      return;
    }

    if (msg.type === 'challenge') {
      if (!ws.channelId) return;
      const map = channels.get(ws.channelId);
      const target = map && map.get(msg.targetId);
      if (!target) {
        send(ws, { type: 'challengeFailed', reason: 'left' });
        return;
      }
      send(target.ws, { type: 'challengeReceived', fromId: ws.connId, fromName: ws.publicName, channel: ws.channelId });
      return;
    }

    if (msg.type === 'challengeResponse') {
      const channelId = ws.channelId;
      const map = channelId && channels.get(channelId);
      const challenger = map && map.get(msg.challengerId);
      if (!msg.accept || !challenger) {
        if (challenger) send(challenger.ws, { type: 'challengeDeclined', byName: ws.publicName });
        return;
      }
      // Ikisini de odadan cikar, ozel bir oyun odasi olustur.
      const code = genCode();
      const state = {
        points: null, // client freshState() ile dolduracak; sadece iskelet gonderiyoruz
      };
      const room = { clients: new Set([challenger.ws, ws]), state: null };
      rooms.set(code, room);
      challenger.ws.roomCode = code;
      ws.roomCode = code;
      leaveChannel(challenger.ws);
      leaveChannel(ws);
      // Beyaz: meydan okuyan (challenger), Siyah: kabul eden.
      send(challenger.ws, { type: 'matched', code, youAre: 'w', opponentName: ws.publicName });
      send(ws, { type: 'matched', code, youAre: 'b', opponentName: challenger.name });
      return;
    }
  });

  ws.on('close', () => {
    leaveChannel(ws);
    const code = ws.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    room.clients.delete(ws);
    broadcast(code, { type: 'peer-left' });
    if (room.clients.size === 0) scheduleCleanup(code);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Tavla Online http://localhost:${PORT} adresinde calisiyor`);
});
