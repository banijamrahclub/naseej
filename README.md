# نظام حجز - نِسيج

تشغيل محلي:

1. افتح موجه الأوامر في مجلد المشروع.
2. `npm install` (سيثبت express, sqlite3, bcrypt, express-session)
3. `npm start`
4. افتح المتصفح إلى `http://localhost:3000/index.html` لواجهة الحجز.
5. افتح `http://localhost:3000/admin.html` للوصول إلى لوحة الإدارة.

معلومات مهمة:
- كلمة مرور الإدارة الافتراضية: **admin123** (يمكن تغييرها من لوحة الإدارة بعد تسجيل الدخول).
- قاعدة البيانات: `data.db` في مجلد المشروع (SQLite).
- API:
  - `GET /api/slots?date=YYYY-MM-DD` — جلب الأوقات المتاحة لهذا التاريخ
  - `POST /api/bookings` — إنشاء حجز
  - `GET /api/bookings` — (لوحة الإدارة) جلب الحجوزات
  - `DELETE /api/bookings/:id` — إلغاء حجز
  - `POST /api/admin/login` — تسجيل دخول المدير
  - `POST /api/admin/change-password` — تغيير كلمة المرور
  - `GET /api/reports?from=YYYY-MM-DD&to=YYYY-MM-DD` — تقرير أرباح

إذا تريد حماية أقوى أو نشر على سيرفر حقيقي سأساعد بإعدادات إضافية (HTTPS، env vars، حماية الجلسات).