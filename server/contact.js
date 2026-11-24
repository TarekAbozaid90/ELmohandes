'use strict';

const QR_TARGET = 'https://elmohandes.onrender.com/qr';
const DEFAULT_CONTACT = Object.freeze({
  brandName: 'مركز المهندس الشامل',
  tagline: 'كل وسائل التواصل والخدمات في مكان واحد',
  websiteUrl: 'https://elmohandes.onrender.com/',
  whatsappNumber: '01007889396',
  whatsappGroupUrl: 'https://chat.whatsapp.com/ITxbrqZBRlf4zSCMM3gzEW',
  whatsappChannelUrl: 'https://whatsapp.com/channel/0029VbDoSDp1t90WXUmbYS1Z',
  facebookUrl: 'https://www.facebook.com/share/1DNizdqLQ1/',
  mapsUrl: 'https://maps.app.goo.gl/HJb7DX5j6TaDyxpK8',
});

const LINKS = {
  websiteUrl: 'الموقع الإلكتروني', whatsappGroupUrl: 'مجموعة واتساب',
  whatsappChannelUrl: 'قناة واتساب', facebookUrl: 'صفحة فيسبوك', mapsUrl: 'موقع المركز على الخريطة',
};
const text = v => typeof v === 'string' ? v.trim() : '';
function normalizeEgyptianMobile(value) {
  let number = text(value).replace(/[٠-٩۰-۹]/g, c => String(c.charCodeAt(0) % 16)).replace(/[\s()-]/g, '');
  if (/^(?:\+20|0020|20)1\d{9}$/.test(number)) number = '0' + number.slice(-10);
  return /^01[0125]\d{8}$/.test(number) ? number : '';
}

function validateContact(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('بيانات التواصل غير صالحة.');
  const brandName = text(input.brandName), tagline = text(input.tagline);
  if (!brandName || brandName.length > 72) throw new Error('اكتب اسم المركز في حدود ٧٢ حرفًا.');
  if (!tagline || tagline.length > 150) throw new Error('اكتب الوصف في حدود ١٥٠ حرفًا.');
  const whatsappNumber = normalizeEgyptianMobile(input.whatsappNumber);
  if (!whatsappNumber) throw new Error('اكتب رقم موبايل مصري صحيح للواتساب، مثل 01007889396.');
  const result = { brandName, tagline, whatsappNumber };
  for (const [key, label] of Object.entries(LINKS)) {
    try {
      const value = text(input[key]);
      if (!/^https:\/\//i.test(value) || /[\s\\]/u.test(value) || value.length > 1000) throw new Error();
      const url = new URL(value);
      if (!url.hostname || url.username || url.password) throw new Error();
      result[key] = url.href;
    } catch { throw new Error(`أدخل رابط HTTPS صحيح في خانة «${label}».`); }
  }
  return result;
}

function readContact(saved) {
  if (saved) {
    try { return validateContact(JSON.parse(saved)); } catch (error) { console.warn(`Invalid saved contact settings: ${error.message}`); }
  }
  return { ...DEFAULT_CONTACT };
}

const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const mark = '/assets/logo-circle-400.jpg';
const icons = {
  globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3.5 12h17"/>',
  chat: '<path d="M20.5 11.9a8.5 8.5 0 0 1-12.7 7.5l-4.4 1.2 1.2-4.3a8.5 8.5 0 1 1 15.9-4.4Z"/><path d="M8.2 9c.3 3 2 4.9 5.2 6.2 1.1.4 2.1-.3 2.5-1.3l-2.4-1.3-.8.9a5.5 5.5 0 0 1-2.6-2.5l.7-.8-.9-2.3c-1 .1-1.9.4-1.7 1.1Z"/>',
  people: '<circle cx="9" cy="8" r="3.2"/><path d="M2.8 19v-1.1a3.8 3.8 0 0 1 3.8-3.8h4.8a3.8 3.8 0 0 1 3.8 3.8V19M16.3 5a3.2 3.2 0 0 1 0 6.2m1.2 3.1a3.8 3.8 0 0 1 3.5 3.7V19"/>',
  channel: '<path d="M4 9h4l9-5v13l-9-4H4a2 2 0 1 1 0-4Zm2 4 2 6h3l-2-5m11-5 2-1m-2 5 2 1"/>',
  facebook: '<path fill="currentColor" stroke="none" d="M14.6 21v-8h2.7l.5-3.1h-3.2v-2c0-.9.3-1.7 1.9-1.7H18V3.4c-.3 0-1.4-.2-2.6-.2-2.7 0-4.5 1.7-4.5 4.5v2.2H8V13h2.9v8h3.7Z"/>',
  pin: '<path d="M19.5 10c0 5.7-7.5 10-7.5 10s-7.5-4.3-7.5-10a7.5 7.5 0 0 1 15 0Z"/><circle cx="12" cy="10" r="2.4"/>',
  call: '<path d="M7 3H4.8C3.8 3 3 3.7 3 5c0 8.5 7.5 16 16 16 1.3 0 2-.8 2-1.8V17l-5-2-1.4 2c-3.2-1.3-6.3-4.4-7.6-7.6L9 8 7 3Z"/>',
  arrow: '<path d="M16 12H5m5-5-5 5 5 5"/>',
  external: '<path d="M7 17 17 7M7 7h10v10"/>',
};
function icon(key, css = '') {
  return `<svg class="${css}" aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${icons[key]}</svg>`;
}
function card(key, color, symbol, url, label, sub, ltr = false) {
  return `<li class="${color}">
    <a class="contact-link" data-channel="${key}" href="${esc(url)}" rel="noopener noreferrer">
      <span class="contact-icon">${icon(symbol)}</span>
      <span class="contact-copy"><strong>${esc(label)}</strong><span${ltr ? ' dir="ltr" class="ltr"' : ''}>${esc(sub)}</span></span>
      ${icon('arrow', 'link-arrow')}
    </a>
  </li>`;
}

function renderContact(contact) {
  const brand = esc(contact.brandName);
  const phone = '20' + contact.whatsappNumber.slice(1);
  const host = new URL(contact.websiteUrl).hostname;
  const cards = [
    card('website', 'tone-web', 'globe', contact.websiteUrl, LINKS.websiteUrl, host, true),
    card('whatsapp', 'tone-whatsapp', 'chat', `https://wa.me/${phone}`, 'راسلنا على واتساب', contact.whatsappNumber, true),
    card('wa-group', 'tone-group', 'people', contact.whatsappGroupUrl, LINKS.whatsappGroupUrl, 'انضم لمجموعة العملاء'),
    card('wa-channel', 'tone-channel', 'channel', contact.whatsappChannelUrl, LINKS.whatsappChannelUrl, 'تابع أحدث العروض والأخبار'),
    card('facebook', 'tone-facebook', 'facebook', contact.facebookUrl, LINKS.facebookUrl, 'تابع مركز المهندس على فيسبوك'),
    card('location', 'tone-location', 'pin', contact.mapsUrl, LINKS.mapsUrl, 'افتح الاتجاهات في خرائط جوجل'),
  ];
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="format-detection" content="telephone=no">
<meta name="theme-color" content="#0a1e3a">
<meta name="description" content="${esc(contact.tagline)}">
<title>${brand} | دليل التواصل</title>
<link rel="icon" href="${mark}">
<link rel="stylesheet" href="/assets/contact.css">
</head>
<body>
  <div class="shell">
    <header class="masthead">
      <a class="wordmark" href="${esc(contact.websiteUrl)}" rel="noopener noreferrer">
        <img src="${mark}" alt="" width="40" height="40">
        <span><strong>${brand}</strong><small>صيانة وبيع الأجهزة المنزلية</small></span>
      </a>
      <a class="shop-link" href="${esc(contact.websiteUrl)}" rel="noopener noreferrer">المتجر ${icon('external')}</a>
    </header>
    <main>
      <section class="hero" aria-labelledby="brand-title">
        <div class="hero-copy">
          <span class="eyebrow">دليل التواصل</span>
          <h1 id="brand-title">${brand}</h1>
          <p>${esc(contact.tagline)}</p>
        </div>
        <div class="hero-mark">
          <span class="orbit" aria-hidden="true"><i></i><i></i></span>
          <img src="${mark}" width="128" height="128" alt="شعار ${brand}">
        </div>
      </section>
      <nav class="channels" aria-labelledby="channels-title">
        <div class="section-head"><h2 id="channels-title">تواصل معنا</h2><span>الروابط الرسمية</span></div>
        <ul class="contact-grid">${cards.join('\n')}</ul>
      </nav>
    </main>
    <footer class="contact-footer">
      <span>مركزك لصيانة وبيع الأجهزة المنزلية</span>
      <a href="tel:+${phone}" class="call-link">${icon('call')} اتصال مباشر <bdi>${esc(contact.whatsappNumber)}</bdi></a>
    </footer>
  </div>
</body>
</html>`;
}

module.exports = { QR_TARGET, DEFAULT_CONTACT, normalizeEgyptianMobile, validateContact, readContact, renderContact };
