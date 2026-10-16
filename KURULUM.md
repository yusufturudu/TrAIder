# TrAIder Kurulum Rehberi (Veritabanı + n8n)

Bu rehber bir kez yapılır. Sonrasında her gün sadece `baslat.bat` dosyasına çift tıklaman yeterli.

## 0) Gerekenler

- **Docker Desktop**: https://www.docker.com/products/docker-desktop/ adresinden indirip kur. Kurulumdan sonra bilgisayarı yeniden başlat ve Docker Desktop'ı aç (sağ altta balina simgesi yeşil olmalı).
- **Node.js 18+**: Zaten kurulu (`node server.js` çalışıyordu).

## 1) `.env` dosyasına yeni satırları ekle

`.env` dosyanın sonuna şunları ekle (API key satırına dokunma):

```
DATABASE_URL=postgres://traider:traider@localhost:5433/traider
N8N_SECRET=buraya-kafandan-uzun-rastgele-bir-sey-yaz-ornek-x7k2p9q4
TELEGRAM_BOT_TOKEN=
```

`N8N_SECRET`: n8n ile TrAIder'ın birbirini tanıması için bir şifre. Rastgele, uzun bir şey yaz.

## 2) Telegram botu oluştur (2 dakika)

1. Telegram'da **@BotFather**'ı aç, `/newbot` yaz.
2. Bota bir isim ver (ör. `TrAIder Erdem`), sonra sonu `bot` ile biten bir kullanıcı adı ver (ör. `traider_erdem_bot`).
3. BotFather sana bir **token** verir (`123456789:AAH...` gibi). Bunu `.env` içindeki `TELEGRAM_BOT_TOKEN=` satırının sonuna yapıştır.
4. Yeni botunu Telegram'da aç ve **/start** yaz. (Bunu yapmazsan bot sana mesaj atamaz.)

## 3) Her şeyi başlat

TrAIder klasöründe `baslat.bat` dosyasına çift tıkla. Bu dosya sırayla:
1. Docker'da PostgreSQL ve n8n'i başlatır (ilk seferde indirme 2-5 dakika sürebilir),
2. İlk seferde `npm install` yapar,
3. TrAIder sunucusunu açar.

Terminalde şunu görmelisin:
```
🗄️  Veritabanı bağlandı ve tablolar hazır.
✅ TrAIder çalışıyor: http://localhost:3000
```

## 4) n8n iş akışlarını yükle

1. Tarayıcıda **http://localhost:5678** adresini aç, ilk açılışta bir n8n hesabı oluştur (sadece senin bilgisayarında, e-posta doğrulaması yok).
2. Yeni bir PowerShell penceresinde TrAIder klasöründe şunu çalıştır:
   ```
   .\n8n-yukle.bat
   ```
   Bu, 3 iş akışını n8n'e aktarır ve yayınlar (publish).
3. n8n sayfasını yenile. Şu 3 iş akışını görmelisin:
   - **TrAIder - Saatlik Fiyat Kaydı**: her saat fiyatları veritabanına yazar
   - **TrAIder - Fiyat Alarmı Kontrolü**: 5 dakikada bir alarmları kontrol eder
   - **TrAIder - Günlük Rapor (Telegram)**: her sabah 09:00'da rapor gönderir

Elle denemek için bir iş akışını aç ve **Execute workflow** butonuna bas.

## 5) Sitede hesabını kur

1. http://localhost:3000 → sağ üstte **Giriş Yap** → **Kayıt ol**.
2. **Portföy** sekmesine geç:
   - Varlıklarını ekle (maliyeti yazarsan kâr/zarar hesaplanır).
   - Telegram kutusuna **@userinfobot**'un sana verdiği Id numarasını yaz → **Kaydet** → **Test mesajı**.
   - Bir fiyat alarmı kur. 5 dakika içinde hedefe ulaşırsa Telegram'a mesaj gelir.

## Sık sorunlar

| Sorun | Çözüm |
|---|---|
| `Veritabanına bağlanılamadı` | Docker Desktop açık mı? `docker compose up -d` çalıştır. TrAIder 30 saniyede bir kendisi tekrar dener. |
| `"pg" paketi kurulu değil` | TrAIder klasöründe `npm install` çalıştır. |
| Telegram `chat not found` | Botuna Telegram'da `/start` yazmadın. |
| n8n `Geçersiz n8n şifresi` | `.env` içindeki `N8N_SECRET` değiştiyse `docker compose up -d` ile n8n'i yeniden başlat. |
| n8n TrAIder'a ulaşamıyor | TrAIder sunucusu (`node server.js`) açık olmalı. |
| Okul ağında veri gelmiyor | Okul ağı Binance vb. siteleri engelliyor; kendi internetini kullan. |

## Kapatma

- TrAIder: terminalde **Ctrl + C**
- Docker (PostgreSQL + n8n): `docker compose down` (veriler silinmez)
- Tüm verileri silip sıfırdan başlamak (dikkat!): `docker compose down -v`
