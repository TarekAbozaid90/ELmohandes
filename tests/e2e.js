/* E2E test: storefront order → database → professional dashboard */
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://localhost:3000';
const SHOTS = process.env.SHOTS || '/home/user/shots';
const PASS = [];
const FAIL = [];
const step = (name, ok, extra = '') => {
  (ok ? PASS : FAIL).push(name + (extra ? ' — ' + extra : ''));
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (extra ? ' — ' + extra : ''));
};

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const jsErrors = [];
  page.on('pageerror', e => jsErrors.push(String(e.message).slice(0, 200)));

  const uniq = 'عميل الاختبار الآلي ' + Date.now().toString().slice(-5);
  const phone = '010' + String(Date.now()).slice(-8);

  /* ---------- 1. STOREFRONT ---------- */
  console.log('\n[1] المتجر (index.html)');
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1200);
  step('الصفحة الرئيسية تفتح', (await page.title()).length > 0, await page.title());
  const prodButtons = await page.locator('button:has-text("طلب الشراء الآن")').count();
  step('المنتجات معروضة بأزرار الطلب', prodButtons >= 9, prodButtons + ' منتج');

  /* ---------- 2. NEW ORDER FROM STOREFRONT ---------- */
  console.log('\n[2] إرسال طلب جديد من الموقع');
  await page.evaluate(() => openOrderModal(
    (typeof products !== 'undefined' && products[0]) ? products[0].id : 1
  ));
  await page.waitForTimeout(300);
  await page.fill('#order-name', uniq);
  await page.fill('#order-phone', phone);
  await page.fill('#order-address', 'القاهرة الجديدة - شارع الاختبار 42');
  await page.click('#order-modal button[type="submit"]');
  await page.waitForTimeout(1800); // wait for API sync
  const toastTxt = await page.locator('#toast, [id*="toast"]').first().textContent().catch(() => '');
  step('رسالة نجاح ظهرت للعميل', /تم إرسال|تم استلام/.test(await page.content()), (toastTxt || '').slice(0, 60));

  // verify the order reached the API/database directly
  const login = await page.evaluate(async () =>
    (await (await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'admin12345' })
    })).json()));
  const token = login.ok ? login.data.token : '';
  step('تسجيل دخول API ناجح', !!token);

  const listRes = await page.evaluate(async (t) =>
    (await (await fetch('/api/orders?limit=500', { headers: { 'Authorization': 'Bearer ' + t } })).json()), token);
  const found = (listRes.data?.items || []).find(o => o.customer_name === uniq);
  step('الطلب وصل لقاعدة البيانات ✅', !!found, found ? `ref=${found.ref} status=${found.status}` : 'غير موجود!');

  /* ---------- 3. DASHBOARD LOGIN ---------- */
  console.log('\n[3] لوحة التحكم — تسجيل الدخول');
  await page.goto(BASE + '/admin', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  await page.fill('#loginPass', 'wrong-pass');
  await page.click('#loginBtn');
  await page.waitForTimeout(700);
  const errShown = await page.locator('#loginErr.show').count();
  step('كلمة المرور الخاطئة مرفوضة', errShown === 1);
  await page.screenshot({ path: SHOTS + '/1-login.png' });

  await page.fill('#loginPass', 'admin12345');
  await page.click('#loginBtn');
  await page.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
  step('الدخول للوحة ناجح', true);
  await page.waitForTimeout(1500);

  /* ---------- 4. OVERVIEW KPIs ---------- */
  console.log('\n[4] نظرة عامة — الإحصائيات');
  const arNum = s => parseInt(String(s).replace(/[\u0660-\u0669]/g, d => '\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669'.indexOf(d)).replace(/[^\d]/g, '')) || 0;
  const kpiOrders = await page.textContent('#kpiOrders');
  const kpiMaint = await page.textContent('#kpiMaint');
  const kpiVisits = await page.textContent('#kpiVisits');
  const kpiRevenue = await page.textContent('#kpiRevenue');
  step('KPI إجمالي الطلبات > 0', arNum(kpiOrders) >= 9, kpiOrders);
  step('KPI الصيانة > 0', arNum(kpiMaint) >= 3, kpiMaint);
  step('KPI الزيارات > 0', arNum(kpiVisits) > 0, kpiVisits);
  step('KPI الإيراد محسوب', arNum(kpiRevenue) > 0, kpiRevenue.trim());
  const canvasPainted = await page.evaluate(() => {
    const c = document.getElementById('chartActivity');
    if (!c) return false;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
    return false;
  });
  step('الرسم البياني مرسوم فعلاً', canvasPainted);
  const statusBars = await page.locator('#statusBars .bar-row').count();
  step('شريط حالات الطلبات', statusBars >= 2, statusBars + ' حالة');
  const recentRows = await page.locator('#recentOrdersTable tbody tr').count();
  step('أحدث الطلبات في النظرة العامة', recentRows >= 3, recentRows + ' صف');
  await page.screenshot({ path: SHOTS + '/2-overview.png', fullPage: true });

  /* ---------- 5. ORDERS VIEW: THE KEY TEST ---------- */
  console.log('\n[5] ★ طلبات الشراء — الطلب الجديد يظهر من موقع آخر؟');
  await page.click('.nav-btn[data-view="orders"]');
  await page.waitForTimeout(700);
  let rows = await page.locator('#ordersBody tr').count();
  step('جدول الطلبات فيه بيانات', rows > 0, rows + ' صف');
  await page.fill('#ordersSearch', uniq);
  await page.waitForTimeout(500);
  rows = await page.locator('#ordersBody tr').count();
  const rowText = rows ? await page.locator('#ordersBody tr').first().textContent() : '';
  step('★ الطلب المرسل من الموقع ظهر في اللوحة', rows === 1 && rowText.includes(uniq), rows + ' نتيجة');
  step('رقم الطلب (Ref) ظاهر', /ORD-/.test(rowText), (rowText.match(/ORD-[0-9-]+/) || [''])[0]);
  await page.screenshot({ path: SHOTS + '/3-orders-new-order.png', fullPage: true });

  // status change (PATCH)
  await page.locator('#ordersBody tr').first().locator('select').selectOption('تم التواصل');
  await page.waitForTimeout(1200);
  const afterStatus = await page.evaluate(async ({ t, name }) => {
    const r = await (await fetch('/api/orders?limit=500', { headers: { 'Authorization': 'Bearer ' + t } })).json();
    return r.data.items.find(o => o.customer_name === name)?.status;
  }, { t: token, name: uniq });
  step('تغيير الحالة اتحفظ في قاعدة البيانات', afterStatus === 'تم التواصل', 'status=' + afterStatus);

  // detail modal
  await page.fill('#ordersSearch', uniq);
  await page.waitForTimeout(400);
  await page.locator('#ordersBody tr').first().click();
  await page.waitForTimeout(400);
  const modalOpen = await page.locator('#detailModal:not(.hidden)').count();
  step('نافذة التفاصيل تفتح', modalOpen === 1);
  await page.screenshot({ path: SHOTS + '/4-order-detail.png' });
  await page.keyboard.press('Escape');
  await page.fill('#ordersSearch', '');

  /* ---------- 6. MAINTENANCE ---------- */
  console.log('\n[6] طلبات الصيانة');
  await page.click('.nav-btn[data-view="maint"]');
  await page.waitForTimeout(600);
  rows = await page.locator('#maintBody tr').count();
  step('طلبات الصيانة معروضة', rows >= 3, rows + ' طلب');
  await page.screenshot({ path: SHOTS + '/5-maintenance.png', fullPage: true });

  /* ---------- 7. PRODUCTS ---------- */
  console.log('\n[7] المنتجات');
  await page.click('.nav-btn[data-view="products"]');
  await page.waitForTimeout(800);
  const cards = await page.locator('.prod-card').count();
  step('كتالوج المنتجات محمّل (من قاعدة البيانات)', cards >= 9, cards + ' منتج');
  const imgOk = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('.prod-card img')];
    return imgs.filter(i => i.complete && i.naturalWidth > 0).length;
  });
  step('صور المنتجات بتتحمل', imgOk >= 8, imgOk + '/' + cards);
  await page.screenshot({ path: SHOTS + '/6-products.png', fullPage: true });

  // add product through the UI
  await page.click('button:has-text("منتج جديد")');
  await page.waitForTimeout(300);
  await page.fill('#pTitle', 'منتج تجريبي من الاختبار الآلي');
  await page.fill('#pPrice', '123 جنيه');
  await page.fill('#pCat', 'اختبار');
  await page.click('button:has-text("حفظ ونشر")');
  await page.waitForTimeout(1200);
  const prodCount = await page.locator('.prod-card').count();
  step('إضافة منتج من اللوحة نجحت', prodCount === cards + 1, cards + ' → ' + prodCount);

  /* ---------- 8. SETTINGS ---------- */
  console.log('\n[8] الإعدادات وحالة النظام');
  await page.click('.nav-btn[data-view="settings"]');
  await page.waitForTimeout(500);
  const conn = await page.textContent('#sysConn');
  step('حالة النظام: متصل', /متصل/.test(conn), conn.trim());
  const counts = await page.textContent('#sysCounts');
  step('إحصائيات النظام', /\d+ \/ \d+ \/ \d+/.test(counts), counts.trim());
  await page.screenshot({ path: SHOTS + '/7-settings.png', fullPage: true });

  /* ---------- 9. LIVE POLLING: order from "another device" ---------- */
  console.log('\n[9] ★ المزامنة اللحظية — طلب من جهاز آخر واللوحة مفتوحة');
  await page.click('.nav-btn[data-view="orders"]');
  await page.waitForTimeout(400);
  const before = await page.locator('#ordersBody tr').count();
  // simulate another device via direct API call
  const otherDevice = await page.evaluate(async () => {
    const r = await (await fetch('/api/orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerName: 'زبون من جهاز آخر', phone: '01199887766',
        address: 'الجيزة - موقع الاختبار', productTitle: 'طلب من موبايل آخر', price: '777 جنيه'
      })
    })).json();
    return r.ok;
  });
  step('إرسال طلب من "جهاز آخر"', otherDevice);
  await page.waitForTimeout(5500); // > poll interval
  const after = await page.locator('#ordersBody tr').count();
  const liveText = await page.textContent('#livePill');
  step('★ اللوحة جابت الطلب الجديد تلقائياً (بدون refresh)', after > before, `${before} → ${after} صف | ${liveText.trim()}`);
  let newVisible = 0;
  for (let i = 0; i < 8 && !newVisible; i++) {
    await page.waitForTimeout(400);
    newVisible = await page.locator('#ordersBody tr:has-text("زبون من جهاز آخر")').count();
    }
  step('صف الطلب الجديد ظاهر', newVisible >= 1, newVisible + ' صف مطابق');
  await page.screenshot({ path: SHOTS + '/8-live-sync.png', fullPage: true });

  /* ---------- 10. MOBILE RESPONSIVENESS ---------- */
  console.log('\n[10] الموبايل');
  const mobile = await ctx.newPage();
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.goto(BASE + '/admin', { waitUntil: 'domcontentloaded' });
  await mobile.waitForTimeout(500);
  if (await mobile.locator('#app.hidden').count()) {
    await mobile.fill('#loginPass', 'admin12345');
    await mobile.click('#loginBtn');
    await mobile.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
  }
  await mobile.waitForTimeout(1200);
  const mobileNav = await mobile.locator('.mobilenav').isVisible();
  const sidebarHidden = !(await mobile.locator('.sidebar').isVisible());
  step('شريط سفلي في الموبايل', mobileNav && sidebarHidden);
  await mobile.screenshot({ path: SHOTS + '/9-mobile.png', fullPage: true });
  await mobile.close();

  /* ---------- summary ---------- */
  const benign = jsErrors.filter(e => !/fonts\.gstatic|net::ERR|favicon/.test(e));
  step('بدون أخطاء JavaScript', benign.length === 0, benign.slice(0, 3).join(' | ') || 'نظيف ✓');

  console.log('\n══════════════════════════════');
  console.log(`  النتيجة: ${PASS.length} نجاح / ${FAIL.length} فشل`);
  if (FAIL.length) { console.log('  الفشل:'); FAIL.forEach(f => console.log('   - ' + f)); }
  console.log('══════════════════════════════\n');

  await browser.close();
  process.exit(FAIL.length ? 1 : 0);
})().catch(e => { console.error('E2E CRASH:', e); process.exit(2); });
