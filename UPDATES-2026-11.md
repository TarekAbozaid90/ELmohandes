## Render Free + private stock (2026-11-24)

- The current setup uses **Render Free Web Service + external PostgreSQL (Neon Free)**, with no ephemeral-disk fallback. The old mounted-disk option is still supported explicitly.
- Products, stock, uploaded image bytes, orders, visitor statistics and QR settings persist in PostgreSQL. The authenticated catalog and backups include stock; the storefront API never does.
- Follow [the current deployment guide](README-DEPLOY.md) before deploying and make a backup first. The notes below describe earlier versions, not the current Render Free configuration.

---

## Storage and editable QR (2026-11-24)

- See [README-DEPLOY.md](README-DEPLOY.md) for the current deployment and backup workflow. Export the existing data before changing any Render setting.
- The Render Blueprint is valid YAML and production startup verifies the disk mount. The same volume holds SQLite and uploaded images.
- The dashboard can change the contact page at `/qr` without replacing the printed QR code. Full and products-only backups can now include available uploads.

---

# تحديث لوحة تحكم مركز المهندس الشامل

## ما تم تعديله
- إضافة سجل زوار محمي داخل لوحة التحكم يعرض IP ووقت الزيارة والصفحة ونوع الجهاز وبيانات المتصفح.
- توسيع `/api/visits/track` لتسجيل بيانات الزيارة من جهة السيرفر؛ عنوان IP يُقرأ من اتصال الطلب، وليس من قيمة يرسلها المتصفح.
- إضافة `/api/visitors` ويتطلب تسجيل دخول المدير.
- ربط سجل الزوار بتحديث اللوحة كل 4 ثوانٍ أثناء فتح تبويب الزوار.
- الإبقاء على تغيير كلمة المرور الموجود مسبقاً في الإعدادات؛ كلمة المرور تُخزن باستخدام scrypt، وتغييرها يبطل الجلسات القديمة.
- إضافة بيانات الزوار إلى النسخ الاحتياطي والاستيراد.
- ضبط Render Blueprint لاستخدام قرص دائم في `/var/data` حتى لا تضيع قاعدة SQLite مع إعادة التشغيل/النشر.

## قبل النشر
1. افتح لوحة التحكم الحالية.
2. من الإعدادات صدّر نسخة احتياطية JSON واحفظها خارج الموقع.
3. تأكد من حفظ أي صور مرفوعة تحتاجها؛ النسخة الاحتياطية الحالية تنقل بيانات قاعدة البيانات ومسارات الصور، وليس ملفات الصور الثنائية نفسها.
4. عند استخدام Render، يلزم تفعيل خطة تدعم Persistent Disk. ملف `render.yaml` يطلب خطة Starter وقرصاً دائماً 1GB.
5. بعد النشر، سجّل الدخول ثم استورد النسخة الاحتياطية من الإعدادات لاستعادة الطلبات والصيانة والمنتجات والزيارات السابقة.

## توضيحات
- مزامنة لوحة التحكم الحالية تعتمد على polling كل 4 ثوانٍ، أي تحديث شبه لحظي وليس WebSocket لحظياً بالمللي ثانية.
- سجل IP يبدأ من وقت نشر هذا التحديث؛ لا يمكن استرجاع عناوين IP للزيارات القديمة لأن النظام السابق لم يكن يحفظها.
- IP قد يكون بيانات شخصية؛ أضف إشعاراً واضحاً في سياسة الخصوصية وحدد مدة الاحتفاظ المناسبة.

## التحقق الفني
- `node --check` نجح لملف السيرفر وJavaScript لوحة التحكم.
- اختبار تكاملي محلي نجح في تسجيل زيارة، وعرض IP بعد تسجيل دخول المدير، وتصدير سجل الزوار واستيراده.
- اختبار Playwright الكامل لم يُشغّل في بيئة البناء لأن حزمة `playwright` غير مثبتة.

## Product editor and discounts (2026-11-22)
- Fixed the product management workflow in `/admin`: existing products can be edited, including their current selling price.
- Added `old_price` and `discount_percent` fields with a safe SQLite migration for existing databases.
- Product create/update API now persists the old price and discount percentage.
- The storefront fetches the central product catalog on load, so product price/discount changes made in `/admin` appear to visitors across devices.
- Product cards and the product detail view display the crossed-out previous price; cards also show the discount percentage when supplied.
- For an existing deployment, publish the updated project; the server automatically adds the new database columns without deleting existing products.
