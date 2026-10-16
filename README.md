# ⚡ TrAIder Terminal

Tr**AI**der Terminal; finansal piyasalardaki karmaşık verileri, yapay zeka ve canlı grafik entegrasyonuyla tek ekranda, yalın ve net bir şekilde sunan modern bir finansal analiz platformudur.

![TrAIder Terminal Banner](https://img.shields.io/badge/Status-Active-brightgreen) ![License](https://img.shields.io/badge/License-MIT-blue) ![TailwindCSS](https://img.shields.io/badge/TailwindCSS-3.x-38bdf8) ![Gemini AI](https://img.shields.io/badge/AI-Gemini%20API-4285f4)

---

## 🚀 Özellikler

* **📊 Canlı TradingView Entegrasyonu:** BIST, Kripto, Emtia ve Dünya Borsaları için gelişmiş, gerçek zamanlı fiyat grafiği.
* **🤖 Yapay Zeka Destekli Piyasa Asistanı:** Gemini API ile entegre çalışan, uzatmadan net, doğrudan destek/direnç ve yön tahmini sunan sohbet terminali.
* **📰 Haberler Sekmesi:** İnternette aranan günün piyasa haberleri; kategori filtreleri ve kaynak linkleriyle.
* **📈 Teknik Analiz Sekmesi:** BTC, ETH, SOL, XRP, DOGE, ADA, Altın ve USD/TRY için RSI, MACD, hareketli ortalamalar, Bollinger bantları, pivot destek/direnç ve yapay zeka yorumu.
* **🔁 Çevirici Sekmesi:** TL, döviz, gram/çeyrek altın ve kripto paralar arasında anlık çeviri.
* **💼 Portföy & Alarmlar:** Hesap aç, varlıklarını ve kâr/zararını takip et, fiyat alarmı kur.
* **🧠 Sohbet Hafızası:** Giriş yapınca sohbetler PostgreSQL'de saklanır; uzun sohbetler özetlenerek asistanın bağlamı korunur.
* **⚙️ n8n Otomasyonları:** Saatlik fiyat kaydı, 5 dakikada bir alarm kontrolü ve her sabah Telegram'dan günlük rapor.
* **🎯 Tek Ekran & Sıfır Karmaşa:** Tüm analizi ve sorularınızı sayfalar arasında kaybolmadan tek bir arayüzden yönetme imkanı.
* **📄 Günlük Piyasa Raporu (PDF):** Giriş yapılmışsa Telegram'a da gönderilir; her sabah 09:00'da n8n grafikli PDF raporu otomatik yollar. Tek tıkla günün döviz, altın ve kripto fiyatlarını, Google'da aranan piyasayı etkileyen haberleri ve yapay zeka özetini içeren PDF rapor.
* **🌙 Dark Mode & Modern Arayüz:** Tailwind CSS ve cam efekti (*glassmorphism*) kullanılarak tasarlanmış göz yormayan, premium karanlık tema.

---

## 🛠️ Teknolojiler

Proje herhangi bir karmaşık derleme adımı gerektirmeden doğrudan tarayıcı üzerinde çalışacak şekilde geliştirilmiştir:

* **HTML5 & JavaScript (ES6+):** Temel yapı ve dinamik mantık.
* **[Tailwind CSS](https://tailwindcss.com/):** Stil ve responsive (mobil uyumlu) tasarım.
* **[TradingView Widget](https://www.tradingview.com/):** Gelişmiş canlı grafik altyapısı.
* **[Google Gemini API](https://ai.google.dev/):** Yapay zeka analiz motoru.
* **[Lucide Icons](https://lucide.dev/):** Modern vektörel ikon seti.
* **[html2pdf.js](https://ereyes.github.io/html2pdf.js/):** Ekran görünümünü PDF belgesine dönüştürme kütüphanesi.

---

## 📦 Kurulum ve Çalıştırma

> 🗄️ **Veritabanı ve n8n kurulumu** için adım adım rehber: [KURULUM.md](KURULUM.md). Kısaca: Docker Desktop'ı kur, `.env` dosyasını doldur, `baslat.bat`'a çift tıkla, sonra `n8n-yukle.bat`'ı çalıştır.


Projeyi yerel bilgisayarınızda çalıştırmak oldukça basittir:

1. **Depoyu klonlayın veya indirin:**
   ```bash
   git clone https://github.com/kullanici-adi/traider-terminal.git
   ```

2. **Dizine gidin:**
   ```bash
   cd traider-terminal
   ```

3. **API anahtarını ekleyin:**
   `.env.example` dosyasını kopyalayıp adını `.env` yapın, içine Gemini anahtarınızı yazın:
   ```
   GEMINI_API_KEY=anahtarınız
   ```
   (`.env` dosyası `.gitignore`'da, GitHub'a gönderilmez.)

4. **Çalıştırın** (Node.js 18+ gerekir, ek paket kurulumu yok):
   ```bash
   node server.js
   ```
   Tarayıcıda `http://localhost:3000` adresini açın.

> ⚠️ **Not:** API anahtarı tarayıcıya hiç gönderilmez; `server.js` okur ve Gemini'ye kendisi istek atar. Bu yüzden sayfayı çift tıklayarak veya Live Server ile değil, `node server.js` ile açın.

---

## 💡 Kullanım

1. **Sorunuzu Yazın:** Arayüzün sağ alt kısmındaki "Piyasa Asistanı" kutusuna merak ettiğiniz varlığı sorun *(Örn: "Altın ne olur?", "THYAO destek direnç neresi?", "Bitcoin kaç oldu?")*.
2. **Grafiği İnceleyin:** Üst kısımdaki TradingView aracı üzerinden canlı mum hareketlerini ve hacimleri takip edin.
3. **Rapor Alın:** Sağ üst köşedeki **Günlük Rapor (PDF)** butonuna basın; fiyatlar, haberler ve özet PDF olarak iner.

---

## 📝 Lisans

Bu proje [MIT Lisansı](LICENSE) ile lisanslanmıştır. Dilediğiniz gibi geliştirebilir ve kullanabilirsiniz.
