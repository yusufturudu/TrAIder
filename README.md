# ⚡ TrAIder Terminal

Tr**AI**der Terminal; finansal piyasalardaki karmaşık verileri, yapay zeka ve canlı grafik entegrasyonuyla tek ekranda, yalın ve net bir şekilde sunan modern bir finansal analiz platformudur.

![TrAIder Terminal Banner](https://img.shields.io/badge/Status-Active-brightgreen) ![License](https://img.shields.io/badge/License-MIT-blue) ![TailwindCSS](https://img.shields.io/badge/TailwindCSS-3.x-38bdf8) ![Gemini AI](https://img.shields.io/badge/AI-Gemini%20API-4285f4)

---

## 🚀 Özellikler

* **📊 Canlı TradingView Entegrasyonu:** BIST, Kripto, Emtia ve Dünya Borsaları için gelişmiş, gerçek zamanlı fiyat grafiği.
* **🤖 Yapay Zeka Destekli Piyasa Asistanı:** Gemini API ile entegre çalışan, uzatmadan net, doğrudan destek/direnç ve yön tahmini sunan sohbet terminali.
* **🎯 Tek Ekran & Sıfır Karmaşa:** Tüm analizi ve sorularınızı sayfalar arasında kaybolmadan tek bir arayüzden yönetme imkanı.
* **📄 Raporlama (PDF İndir):** Analiz terminalindeki aktif verileri ve grafiği tek tıkla PDF formatında bilgisayarınıza indirme.
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

Projeyi yerel bilgisayarınızda çalıştırmak oldukça basittir:

1. **Depoyu klonlayın veya indirin:**
   ```bash
   git clone https://github.com/kullanici-adi/traider-terminal.git
   ```

2. **Dizine gidin:**
   ```bash
   cd traider-terminal
   ```

3. **Çalıştırın:**
   `index.html` dosyasını VS Code **Live Server** eklentisiyle veya yerel bir web sunucusu (örneğin Python `python -m http.server`) üzerinden çalıştırabilirsiniz.

> ⚠️ **Not:** Yapay Zeka API isteklerinin tarayıcı güvenlik engellerine (*CORS*) takılmaması için projeyi doğrudan çift tıklayıp `file://` protokolüyle açmak yerine yerel bir sunucu (Live Server vb.) üzerinden açmanız önerilir.

---

## 💡 Kullanım

1. **Sorunuzu Yazın:** Arayüzün sağ alt kısmındaki "Piyasa Asistanı" kutusuna merak ettiğiniz varlığı sorun *(Örn: "Altın ne olur?", "THYAO destek direnç neresi?", "Bitcoin kaç oldu?")*.
2. **Grafiği İnceleyin:** Üst kısımdaki TradingView aracı üzerinden canlı mum hareketlerini ve hacimleri takip edin.
3. **PDF Alın:** Sağ üst köşede bulunan **PDF İndir** butonuna basarak anlık piyasa raporunuzu kaydedin.

---

## 📝 Lisans

Bu proje [MIT Lisansı](LICENSE) ile lisanslanmıştır. Dilediğiniz gibi geliştirebilir ve kullanabilirsiniz.
