# Tavla Online

Bağımsız çalışan, arkadaşını oda koduyla davet edebildiğin, gerçek zamanlı (WebSocket) çok oyunculu tavla oyunu.

## İçindekiler
- `server.js` — küçük bir Node.js sunucusu: web sayfasını sunar ve iki oyuncu arasında oyun durumunu WebSocket ile iletir.
- `public/index.html` — oyunun tamamı (arayüz + oyun kuralları) tek dosyada.
- `package.json` — bağımlılıklar (`express`, `ws`).

## Yerelde çalıştırma

Bilgisayarında [Node.js](https://nodejs.org) kurulu olmalı (18 veya üzeri önerilir).

```bash
cd tavla-server
npm install
npm start
```

Sunucu `http://localhost:3000` adresinde açılır. Tarayıcıda bu adresi aç, "Oda Kur" ile bir oda oluştur.

**Not:** Arkadaşının aynı oyunu oynayabilmesi için senin bilgisayarındaki `localhost:3000` adresine ulaşabilmesi gerekir — bu adres sadece kendi bilgisayarında çalışır, internetten erişilemez. Arkadaşınla oynamak için aşağıdaki seçeneklerden birini kullanman gerekiyor.

## Arkadaşınla oynamak için: internete açma seçenekleri

### 1) En kolay yol — ücretsiz bir hosting servisine yükle
Aşağıdaki servislerin hepsi Node.js + WebSocket destekler ve ücretsiz katmanları var:
- **Render.com** → "New Web Service", bu klasörü GitHub'a push edip bağla, build komutu `npm install`, start komutu `npm start`.
- **Railway.app** → benzer şekilde, repoyu bağla, otomatik algılar.
- **Fly.io** veya **Glitch.com** de alternatif olarak kullanılabilir.

Bu servislerden biri sana `https://senin-oyunun.onrender.com` gibi herkesin erişebileceği bir adres verir. O adresi arkadaşınla paylaşman yeterli.

### 2) Hızlı geçici paylaşım — ngrok
Sunucuyu kendi bilgisayarında çalıştırıp geçici olarak internete açmak istersen:

```bash
npm start
# başka bir terminalde:
ngrok http 3000
```

ngrok sana `https://xxxx.ngrok-free.app` gibi geçici bir link verir, bunu arkadaşına gönder. Bilgisayarın kapanınca veya ngrok'u durdurunca link çalışmayı keser.

### 3) Kendi sunucun / VPS'in varsa
Dosyaları sunucuna kopyala, `npm install && npm start` çalıştır (arkaplanda kalması için `pm2` gibi bir process manager önerilir), 3000 portunu (veya `PORT` ortam değişkeniyle belirlediğin portu) dışarıya aç.

## Nasıl oynanır
1. Bir oyuncu "Oda Kur"a basar, 4 haneli bir kod alır.
2. Bu kodu arkadaşına gönderir (ve elbette sitenin linkini).
3. Arkadaşı siteyi açıp "Odaya Katıl" kısmına kodu girer.
4. İkisi de aynı tahtayı gerçek zamanlı görür; sırasıyla zar atıp taş oynarlar.

## Kurallar hakkında not
Standart tavla (backgammon) kuralları uygulanmıştır: başlangıç dizilişi, zar (çift gelirse 4 hamle), taş vurma/bar'a gönderme, bar'dan giriş, ve toplama (bear-off). Oyun mantığı istemci tarafında (tarayıcıda) çalışır; sunucu sadece iki oyuncu arasında durumu ileten basit bir aracıdır — yani oyun kurallarını değiştirmek istersen `public/index.html` içindeki JavaScript'i düzenlemen yeterli.
