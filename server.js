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
  for (const id of CHANNEL_IDS) counts[id] = channels.get(id).size + ghostCount(id);
  return counts;
}

function broadcastChannelCounts() {
  const counts = channelCounts();
  for (const client of wss.clients) send(client, { type: 'channelCounts', counts });
}

function channelWaitingList(channelId, exceptConnId) {
  const map = channels.get(channelId);
  const list = [];
  if (map) {
    for (const [connId, entry] of map) {
      if (connId === exceptConnId) continue;
      list.push({ id: connId, name: entry.name });
    }
  }
  const gmap = ghostPlayers.get(channelId);
  if (gmap) {
    for (const [ghostId, entry] of gmap) {
      list.push({ id: ghostId, name: entry.name });
    }
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

// ---- Hayalet (görünüm için) oyuncular ----
// Genel odaların bomboş görünmemesi için gerçek oyunculara ek olarak
// rastgele isimli "hayalet" oyuncular gösteriyoruz. Bunlar gerçek bir
// bağlantı değil, sadece listede görünürler. Birine meydan okunursa,
// gerçek bir oyuncuymuş gibi kısa bir süre sonra nazikçe "meşgul" ya da
// "reddetti" cevabı döner — sistemde hiçbir yerde çökme/kilitlenme olmaz.
const GHOST_NAMES = [
  'Ahmet', 'Mehmet', 'Mustafa', 'Ali', 'Hüseyin', 'Hasan', 'İbrahim', 'Yusuf', 'Emre', 'Burak',
  'Kerem', 'Onur', 'Deniz', 'Serkan', 'Cem', 'Barış', 'Kaan', 'Eren', 'Berk', 'Umut',
  'Ayşe', 'Fatma', 'Zeynep', 'Elif', 'Emine', 'Hatice', 'Merve', 'Selin', 'Ece', 'Buse',
  'Aslı', 'Gizem', 'İrem', 'Melis', 'Sude', 'Yasemin', 'Pınar', 'Nazlı', 'Ceren', 'Duygu'
];
function randomGhostName() {
  const base = GHOST_NAMES[Math.floor(Math.random() * GHOST_NAMES.length)];
  return Math.random() < 0.35 ? base + (10 + Math.floor(Math.random() * 89)) : base;
}

// channelId -> Map<ghostId, { name }>
const ghostPlayers = new Map(CHANNEL_IDS.map(id => [id, new Map()]));
let ghostSeq = 1;
const GHOST_RANGE = { min: 1, max: 3 }; // her kanalda bulunmasını istediğimiz aralık

function ghostCount(channelId) {
  return ghostPlayers.get(channelId).size;
}

function addGhost(channelId) {
  const id = 'ghost_' + (ghostSeq++);
  ghostPlayers.get(channelId).set(id, { name: randomGhostName() });
}

function removeRandomGhost(channelId) {
  const map = ghostPlayers.get(channelId);
  const keys = [...map.keys()];
  if (keys.length === 0) return;
  map.delete(keys[Math.floor(Math.random() * keys.length)]);
}

// Kanallardaki hayalet sayısını hafifçe dalgalandırır (biri gidip biri
// gelir gibi), böylece liste zaman içinde canlı görünür.
function tickGhosts() {
  for (const channelId of CHANNEL_IDS) {
    const target = GHOST_RANGE.min + Math.floor(Math.random() * (GHOST_RANGE.max - GHOST_RANGE.min + 1));
    const current = ghostCount(channelId);
    if (current < target) addGhost(channelId);
    else if (current > target && Math.random() < 0.5) removeRandomGhost(channelId);
    else if (Math.random() < 0.15) { removeRandomGhost(channelId); addGhost(channelId); }
  }
  broadcastChannelCounts();
  for (const channelId of CHANNEL_IDS) broadcastChannelList(channelId);
}

// Sunucu ayağa kalkar kalkmaz odalar bomboş görünmesin diye hemen doldur.
for (const channelId of CHANNEL_IDS) {
  const initial = GHOST_RANGE.min + Math.floor(Math.random() * (GHOST_RANGE.max - GHOST_RANGE.min + 1));
  for (let i = 0; i < initial; i++) addGhost(channelId);
}
setInterval(tickGhosts, 20000); // 20 saniyede bir hafifçe değişsin

// ---- Rekabetci (siralanmis) esleştirme kuyrugu ----
// Basit "en yakin puanli rakibi bul" mantigi: biri kuyruga girince,
// kuyrukta bekleyen herkes arasindan puani en yakin olani aranir.
// Eslesme bulunursa ikisi de kuyruktan cikarilip ozel bir oyun odasi acilir.
let rankedQueue = []; // { ws, connId, name, rating, userId, joinedAt }
const RATING_MATCH_THRESHOLD = 150; // bu araliktaki en yakin rakip hemen eslesir

function leaveRanked(ws) {
  const idx = rankedQueue.findIndex(e => e.ws === ws);
  if (idx !== -1) rankedQueue.splice(idx, 1);
}

function findClosestRankedMatch(rating, exceptWs) {
  let best = null;
  let bestDiff = Infinity;
  for (const entry of rankedQueue) {
    if (entry.ws === exceptWs) continue;
    const diff = Math.abs(entry.rating - rating);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = entry;
    }
  }
  if (best && bestDiff <= RATING_MATCH_THRESHOLD) return best;
  return null;
}

// entryA once kuyruga girmisti (beyaz), entryB yeni eslesen (siyah).
function createRankedMatch(entryA, entryB) {
  leaveRanked(entryA);
  leaveRanked(entryB);
  const code = genCode();
  const room = { clients: new Set([entryA.ws, entryB.ws]), state: null };
  rooms.set(code, room);
  entryA.ws.roomCode = code;
  entryB.ws.roomCode = code;
  send(entryA.ws, {
    type: 'rekabetciEslesti', code, youAre: 'w',
    opponentName: entryB.name, opponentRating: entryB.rating, opponentUserId: entryB.userId,
    yourRating: entryA.rating
  });
  send(entryB.ws, {
    type: 'rekabetciEslesti', code, youAre: 'b',
    opponentName: entryA.name, opponentRating: entryA.rating, opponentUserId: entryA.userId,
    yourRating: entryB.rating
  });
}

// Kuyrukta uzun suredir bekleyenler icin puan toleransini kademeli genisletir,
// boylece kimse sonsuza kadar beklemez. Her 4 saniyede bir calisir.
setInterval(() => {
  if (rankedQueue.length < 2) return;
  const now = Date.now();
  const sorted = [...rankedQueue].sort((a, b) => a.rating - b.rating);
  const matched = new Set();
  for (let i = 0; i < sorted.length - 1; i++) {
    const e1 = sorted[i];
    if (matched.has(e1)) continue;
    const e2 = sorted[i + 1];
    if (matched.has(e2)) continue;
    const diff = Math.abs(e1.rating - e2.rating);
    const waitedSec = Math.min(now - e1.joinedAt, now - e2.joinedAt) / 1000;
    const threshold = RATING_MATCH_THRESHOLD + Math.floor(waitedSec / 10) * 50;
    if (diff <= threshold) {
      matched.add(e1);
      matched.add(e2);
      createRankedMatch(e1, e2);
    }
  }
}, 4000);

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

    // ---- Rekabetci (siralanmis) mod ----

    if (msg.type === 'rekabetciyeKatil') {
      leaveRanked(ws); // onceki bekleyisi varsa temizle
      const rating = Number.isFinite(msg.rating) ? msg.rating : 1000;
      const name = (msg.name || 'Oyuncu').slice(0, 20);
      const userId = msg.userId || null;
      const myEntry = { ws, connId: ws.connId, name, rating, userId, joinedAt: Date.now() };

      const opponent = findClosestRankedMatch(rating, ws);

      if (opponent) {
        createRankedMatch(opponent, myEntry);
      } else {
        rankedQueue.push(myEntry);
        send(ws, { type: 'rekabetciBekleniyor', queueSize: rankedQueue.length });
      }
      return;
    }

    if (msg.type === 'rekabetcidenAyril') {
      leaveRanked(ws);
      send(ws, { type: 'rekabetcidenAyrildi' });
      return;
    }

    // ---- Mac ici rovans (rematch) istegi / cevabi ----
    // Bu mesajlar sadece odadaki diger oyuncuya iletilir, sunucu
    // skor veya oyun durumu hakkinda hicbir sey bilmez/saklamaz.
    if (msg.type === 'rematchRequest') {
      const code = ws.roomCode;
      if (!code) return;
      broadcast(code, { type: 'rematchRequest', fromName: msg.fromName || 'Rakibin' }, ws);
      return;
    }

    if (msg.type === 'rematchResponse') {
      const code = ws.roomCode;
      if (!code) return;
      broadcast(code, { type: 'rematchResponse', accept: !!msg.accept, fromName: msg.fromName || 'Rakibin' }, ws);
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
      const channelId = ws.channelId;
      const map = channels.get(channelId);
      const target = map && map.get(msg.targetId);
      if (target) {
        send(target.ws, { type: 'challengeReceived', fromId: ws.connId, fromName: ws.publicName, channel: channelId });
        return;
      }
      // Hedef gercek bir oyuncu degil, hayalet olabilir mi diye bak.
      const gmap = ghostPlayers.get(channelId);
      const ghost = gmap && gmap.get(msg.targetId);
      if (ghost) {
        const delay = 1200 + Math.random() * 2500; // gercekci bir bekleme
        setTimeout(() => {
          // istek sahibi hala bagliysa ve ayni kanaldaysa cevap gonder
          if (ws.readyState !== ws.OPEN || ws.channelId !== channelId) return;
          if (Math.random() < 0.5) {
            send(ws, { type: 'challengeDeclined', byName: ghost.name });
          } else {
            send(ws, { type: 'challengeFailed', reason: 'left' });
          }
        }, delay);
        return;
      }
      send(ws, { type: 'challengeFailed', reason: 'left' });
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
    leaveRanked(ws);
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
