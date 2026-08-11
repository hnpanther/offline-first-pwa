const fa = {
  app: {
    name: 'ثبت داده‌های میدانی',
    shortName: 'ثبت داده‌های میدانی'
  },
  nav: {
    dashboard: 'داشبورد',
    settings: 'تنظیمات',
    logSheets: 'Log Sheet ها',
    logSheetActive: 'لاگ شیت‌های باز',
    logSheetHistory: 'سوابق لاگ شیت‌ها',
    nfcInspect: 'بازرسی تگ NFC'
  },
  auth: {
    loginTitle: 'ورود به سیستم',
    loginSubtitle: 'با نام کاربری و رمز عبور وارد شوید',
    username: 'نام کاربری',
    password: 'رمز عبور',
    login: 'ورود',
    loggingIn: 'در حال ورود...',
    logout: 'خروج',
    bindingPending:
      'شناسه کاربری شما هنوز از سرور دریافت نشده است. کارهای ذخیره‌شده روی دستگاه کاملاً قابل استفاده‌اند، اما ارسال به سرور و به‌روزرسانی کارتابل تا برقراری ارتباط متوقف است. با اتصال مجدد، خودکار ادامه پیدا می‌کند.',
    sessionEnded:
      'نشست شما به پایان رسیده است. ممکن است زمان آن منقضی شده باشد یا از پنل ادمین ابطال شده باشد یا روی دستگاه دیگری وارد شده باشید. دوباره وارد شوید.'
  },
  inbox: {
    myWork: 'کارهای من',
    pickupPool: 'قابل پیک‌آپ',
    teamWork: 'کارهای واحد (سرپرست)',
    claim: 'پیک‌آپ',
    claiming: 'در حال پیک‌آپ...',
    release: 'برگرداندن',
    releasing: 'در حال برگرداندن...',
    open: 'شروع کار',
    refresh: 'بروزرسانی کارتابل',
    lastSync: 'آخرین بروزرسانی',
    assignee: 'مسئول فعلی',
    noAssigned: 'کار باز اختصاص‌یافته‌ای ندارید',
    noAvailable: 'کار قابل پیک‌آپی در واحد شما نیست',
    pickupRequiresOnline: 'این عمل فقط در حالت آنلاین امکان‌پذیر است',
    claimFailed: 'پیک‌آپ ناموفق بود',
    releaseFailed: 'برگرداندن کار ناموفق بود',
    assignTitle: 'انتساب به اپراتور',
    reassignTitle: 'بازانتساب به اپراتور',
    assign: 'انتساب',
    assigning: 'در حال انتساب...',
    assignConfirm: 'تأیید انتساب',
    assignFailed: 'انتساب ناموفق بود',
    selectOperator: 'انتخاب اپراتور',
    offlineDraft: 'پیش‌نویس محلی — برای کارتابل به‌روز آنلاین شوید',
    completedPendingSync: 'تکمیل شده — در انتظار ارسال',
    offlineHint:
      'اتصال به سرور برقرار نیست (شبکه قطع یا سرور در دسترس نیست). فقط کارهای ذخیره‌شده روی دستگاه قابل ادامه است.',
    serverUnavailableCached:
      'سرور در دسترس نیست — آخرین کارتابل ذخیره‌شده و کارهای محلی نمایش داده می‌شوند.',
    serverUnavailableNoCache:
      'سرور در دسترس نیست. کارهای محلی روی دستگاه قابل ادامه است.',
    fetchFailed: 'خطا در دریافت کارتابل'
  },
  nfc: {
    title: 'شناسایی Asset',
    startScan: 'شروع اسکن NFC',
    stopScan: 'توقف اسکن',
    scanning: 'در حال اسکن...',
    waitingForTag: 'تگ NFC را نزدیک کنید',
    tagDetected: 'تگ شناسایی شد',
    notSupported: 'NFC در این دستگاه پشتیبانی نمی‌شود',
    permissionDenied: 'دسترسی به NFC رد شد',
    error: 'خطا در خواندن تگ NFC',
    serialNumber: 'شناسه تگ',
    manualEntry: 'ورود دستی شناسه',
    manualEntryDisabled: 'ورود دستی در تنظیمات غیرفعال است',
    continueWithTag: 'ادامه با این تگ',
    tagNotRegistered: 'این تگ در سیستم ثبت نشده است. ابتدا آن را در بخش مدیریت ثبت کنید.',
    tagLookupError: 'خطا در بارگذاری اطلاعات Asset'
  },
  form: {
    cancel: 'انصراف',
    required: 'این فیلد الزامی است',
    notes: 'یادداشت',
    operatorName: 'نام اپراتور',
    location: 'محل',
    success: 'اطلاعات با موفقیت ذخیره شد',
    draftSaved: 'پیش‌نویس ذخیره شد',
    approvedAndQueued: 'تأیید شد و در صف ارسال قرار گرفت',
    error: 'خطا در ذخیره اطلاعات',
    saving: 'در حال ذخیره...'
  },
  logSheet: {
    templates: 'قالب‌های Log Sheet',
    template: 'قالب Log Sheet',
    addTemplate: 'ایجاد قالب',
    editTemplate: 'ویرایش قالب',
    templateName: 'نام قالب',
    templateDesc: 'توضیحات (اختیاری)',
    scopeType: 'محدوده',
    scopeLocation: 'مکان',
    scopeSystem: 'سیستم',
    scopeMainFunction: 'فانکشن اصلی',
    selectScope: 'انتخاب محدوده',
    noTemplates: 'هیچ قالبی تعریف نشده',
    createFromTemplate: 'ایجاد Log Sheet',
    list: 'Log Sheet ها',
    fill: 'تکمیل Log Sheet',
    draft: 'پیش‌نویس',
    submitted: 'ارسال شده',
    submit: 'ثبت نهایی Log Sheet',
    revertToDraft: 'بازگشت به پیش‌نویس',
    revertToDraftHint: 'کار از صف ارسال خارج می‌شود و می‌توانید دوباره ویرایش کنید.',
    correctAndResubmit: 'اصلاح مقادیر و ارسال مجدد',
    correctAndResubmitHint:
      'سرور این ثبت را به دلیل ناقص بودن مقادیر نپذیرفت. با زدن این دکمه کار دوباره قابل ویرایش می‌شود؛ فیلدهای گفته‌شده در پیام بالا را تکمیل کنید و دوباره ثبت نهایی بزنید. ارسال دوباره بدون تغییر مقادیر فایده‌ای ندارد و همان پاسخ را می‌گیرد.',
    revertToDraftSuccess: 'کار به حالت پیش‌نویس برگشت.',
    recheckAssignment: 'بررسی مجدد انتساب',
    recheckAssignmentRestored: 'کار دوباره به شما انتساب داده شد. می‌توانید ادامه دهید.',
    recheckAssignmentSynced: 'کار با موفقیت به سرور ارسال شد.',
    recheckAssignmentSyncFailed: 'انتساب برگشت، اما ارسال به سرور ناموفق بود.',
    recheckAssignmentStillRevoked: 'این کار هنوز در کارتابل شما نیست.',
    revokedAssignmentHint:
      'این کار از شما گرفته شده است. داده‌های واردشده روی دستگاه حفظ شده‌اند. در صورت انتساب مجدد، «بررسی مجدد انتساب» را بزنید.',
    saveDraft: 'ذخیره پیش‌نویس',
    noAssets: 'هیچ Asset ای در این محدوده یافت نشد',
    noLogSheets: 'هیچ Log Sheet ای ثبت نشده',
    deleteConfirm: 'آیا از حذف این Log Sheet مطمئن هستید؟',
    assetValues: 'مقادیر Asset',
    scopeSummary: 'محدوده',
    producedAt: 'تاریخ تولید',
    serverId: 'شناسه لاگ شیت',
    nfcTag: 'شناسه NFC',
    reportNfcFault: 'اعلام خرابی NFC',
    reportNfcFaultHint:
      'اگر تگ NFC این Asset خراب، کنده‌شده یا اصلاً نصب نشده — یا NFC خود دستگاه کار نمی‌کند — این گزارش را ثبت کنید تا بتوانید بدون اسکن، اطلاعات را به‌صورت دستی وارد کنید.',
    nfcFaultReasonLabel: 'توضیحات (اختیاری)',
    nfcFaultSubmit: 'ثبت گزارش',
    nfcFaultSubmitted: 'گزارش خرابی NFC ثبت شد. اکنون می‌توانید این Asset را به‌صورت دستی تکمیل کنید.',
    manualEntryUnlocked: 'ثبت دستی',
    manualEntryUnlockedHint: 'برای این Asset گزارش خرابی NFC ثبت شده و ثبت دستی (بدون اسکن) باز است.',
    /*
     * One message for every way a scan can fail verification: unreadable Record 1, a serial
     * that does not match, or an asset with no serial recorded.
     *
     * Deliberately says nothing about WHICH check failed. The old messages named the
     * mechanism — "the chip serial does not match", "no serial is recorded for this asset" —
     * which is a map of how verification works, handed to whoever is holding the tag. Someone
     * who knows the serial is what fails knows to look for a tag whose serial does match.
     * The operator's next step is identical in all three cases (tell an administrator), so
     * there is nothing they lose by not being told.
     *
     * The one failure that stays specific is a *valid* tag that simply is not on this sheet:
     * that is a routing mistake the operator can act on themselves, and it reveals nothing.
     */
    nfcVerificationFailed:
      'اطلاعات این تگ صحیح نیست. در صورت مشکل با مدیر سامانه تماس بگیرید.',
    entryCreatedAt: 'تاریخ ثبت',
    entryUpdatedAt: 'آخرین ویرایش'
  },
  sync: {
    pending: 'در انتظار ارسال',
    syncing: 'در حال همگام‌سازی...',
    synced: 'همگام‌سازی شد',
    failed: 'خطا در همگام‌سازی',
    lastSync: 'آخرین همگام‌سازی',
    pendingCount: '{{count}} رکورد در انتظار',
    manualSync: 'همگام‌سازی دستی',
    online: 'آنلاین',
    offline: 'آفلاین',
    serverUnreachable: 'سرور در دسترس نیست',
    expired: 'مهلت تکمیل گذشته — سینک ممکن نیست',
    superseded: 'ثبت‌شده توسط دیگری — سینک ممکن نیست'
  },
  settings: {
    title: 'تنظیمات',
    connection: 'اتصال به سرور',
    nfcSection: 'تنظیمات NFC',
    serverUrl: 'آدرس سرور',
    syncInterval: 'فاصله همگام‌سازی (ثانیه)',
    allowManualEntry: 'اجازه ورود دستی شناسه تگ',
    allowManualEntryHint:
      'اگر فعال باشد، همه کاربران می‌توانند شناسه را بدون اسکن NFC وارد کنند. سرپرست و اپراتور ارشد همیشه این امکان را دارند.',
    strictSerialMatch: 'بررسی سریال تراشه هنگام اسکن لاگ شیت',
    strictSerialMatchHint:
      'به‌صورت پیش‌فرض فعال است: علاوه بر محتوای Record 1، سریال سخت‌افزاری تراشه هم باید با سریال ثبت‌شده روی دارایی یکسان باشد. محتوای Record 1 قابل کپی روی هر تگ خامی است، پس بررسی سریال همان چیزی است که به «تگ درست را اسکن کردم» معنا می‌دهد. اگر برای دارایی سریالی ثبت نشده باشد، اسکن پذیرفته نمی‌شود؛ در آن صورت این گزینه را غیرفعال کنید تا فقط Record 1 بررسی شود.',
    strictSerialMatchAdminOnly: 'تغییر این گزینه فقط برای مدیر سامانه امکان‌پذیر است.',
    displaySection: 'نمایش و چرخش صفحه',
    screenOrientation: 'جهت صفحه',
    screenOrientationAuto: 'خودکار (بر اساس چرخش دستگاه)',
    screenOrientationPortrait: 'عمودی (قفل‌شده)',
    screenOrientationLandscape: 'افقی (قفل‌شده)',
    screenOrientationHint:
      'این تنظیم روی همین دستگاه ذخیره می‌شود و با حساب کاربری همگام نمی‌شود؛ چون به نحوه نصب همان تبلت یا گوشی بستگی دارد. پس از بستن و باز کردن برنامه هم باقی می‌ماند.',
    screenOrientationUnsupported:
      'این مرورگر قفل جهت صفحه را پشتیبانی نمی‌کند. قفل کردن معمولاً فقط در نسخه نصب‌شده (PWA) روی اندروید کار می‌کند؛ در غیر این صورت صفحه آزادانه می‌چرخد.',
    save: 'ذخیره',
    saved: 'تنظیمات ذخیره شد'
  },
  dashboard: {
    title: 'داشبورد',
    welcome: 'خوش آمدید',
    username: 'نام کاربری',
    fullName: 'نام کامل',
    openLogSheets: 'لاگ‌شیت‌های باز',
    pendingSync: 'در انتظار ارسال',
    todaySubmitted: 'ارسال‌شده امروز',
    syncedCount: 'همگام‌سازی‌شده',
    ownStatsHint: 'این آمار فقط مربوط به کارهای خود شماست.',
    quickCollect: 'جمع‌آوری داده',
    drafts: 'پیش‌نویس'
  },
  attachments: {
    takePhoto: 'گرفتن عکس',
    recordAudio: 'ضبط صدا',
    stopRecording: 'پایان ضبط',
    none: 'هنوز موردی ثبت نشده است.',
    pending: 'در انتظار ارسال',
    synced: 'ارسال شد',
    uploadFailed: 'ارسال ناموفق',
    captureFailed: 'خطا در ثبت فایل.',
    pendingCount: '{{done}} از {{total}} پیوست ارسال شد',
    lowStorage: 'حافظه دستگاه پر است. لطفاً پس از اتصال به سرور و ارسال پیوست‌های در انتظار، دوباره تلاش کنید.',
    rejected: 'رد شد توسط سرور',
    retry: 'تلاش مجدد',
    micBlocked: 'دسترسی به میکروفون برای این برنامه مسدود شده است.',
    micHowToFix: 'راهنمای فعال‌سازی میکروفون',
    micHowToFixSteps: [
      'روی آیکون قفل 🔒 کنار آدرس سایت (یا «تنظیمات سایت» در منوی مرورگر) بزنید.',
      'گزینه «میکروفون» را پیدا کنید و آن را روی «اجازه دادن» بگذارید.',
      'اگر برنامه را روی صفحه اصلی نصب کرده‌اید: تنظیمات اندروید ← برنامه‌ها ← این برنامه ← مجوزها ← میکروفون ← اجازه دادن.',
      'سپس صفحه را ببندید و دوباره باز کنید و روی «ضبط صدا» بزنید.'
    ],
    recordVideo: 'ضبط ویدئو',
    stopVideo: 'پایان ضبط ویدئو',
    limitReached: 'حداکثر {{max}} مورد برای این فیلد مجاز است.',
    truncatedBySize: 'ضبط به دلیل رسیدن به حداکثر حجم مجاز، زودتر متوقف شد. بخش ضبط‌شده ذخیره شد.',
    limitsTitle: 'محدودیت پیوست‌ها',
    limitsHint: 'این مقادیر توسط مدیر در پنل وب تعیین می‌شوند و در این دستگاه قابل تغییر نیستند. با هر بار اتصال به سرور به‌روزرسانی می‌شوند.',
    limitImages: 'حداکثر تعداد تصویر در هر فیلد',
    limitAudios: 'حداکثر تعداد صوت در هر فیلد',
    limitVideos: 'حداکثر تعداد ویدئو در هر فیلد',
    limitAudioSeconds: 'حداکثر مدت صوت (ثانیه)',
    limitVideoSeconds: 'حداکثر مدت ویدئو (ثانیه)',
    micNoteVsPhoto:
      'گرفتن عکس به مجوز جداگانه نیاز ندارد، چون دوربین دستگاه را باز می‌کند؛ ولی ضبط صدا حتماً به مجوز میکروفون در مرورگر نیاز دارد.'
  },
  nfcInspect: {
    title: 'بازرسی تگ NFC',
    subtitle: 'محتوای خام تگ را می‌خواند و در صورت ثبت‌شدن، اطلاعات دارایی را از سرور می‌گیرد',
    adminOnly: 'این ابزار فقط برای مدیران سامانه در دسترس است.',
    onlineOnly: 'این ابزار نیاز به اتصال آنلاین به سرور دارد. لطفاً اتصال دستگاه را بررسی کنید.',
    unsupported: 'این مرورگر از Web NFC پشتیبانی نمی‌کند. از کروم روی اندروید استفاده کنید.',
    startScan: 'شروع اسکن',
    stopScan: 'توقف اسکن',
    scanning: 'تگ را نزدیک دستگاه نگه دارید…',
    clear: 'پاک کردن',
    rawTitle: 'داده خام تگ',
    rawHint: 'خروجی کامل به‌صورت JSON',
    copy: 'کپی JSON',
    copied: 'کپی شد',
    resolvedTagId: 'شناسه استخراج‌شده از تگ (همان روشی که اسکن لاگ‌شیت استفاده می‌کند)',
    assetTitle: 'دارایی متناظر',
    assetLoading: 'در حال دریافت اطلاعات دارایی…',
    assetNotFound: 'هیچ دارایی‌ای با این شناسه در سرور ثبت نشده است.',
    assetError: 'دریافت اطلاعات دارایی از سرور ناموفق بود.',
    noTagId: 'از رکورد اول این تگ شناسه‌ای قابل استخراج نبود، بنابراین جستجوی دارایی انجام نشد.',
    assetCode: 'کد دارایی',
    assetName: 'نام دارایی',
    assetNameFa: 'نام فارسی',
    nfcTagId: 'شناسه تگ NFC',
    nfcSerial: 'سریال تراشه',
    assetClass: 'کلاس دارایی',
    active: 'وضعیت',
    activeYes: 'فعال',
    activeNo: 'غیرفعال',
    description: 'توضیحات',
    bindTitle: 'اتصال این تراشه به دارایی',
    bindScanned: 'سریال اسکن‌شده:',
    bindSave: 'ذخیره سریال روی این دارایی',
    bindReplace: 'جایگزینی سریال این دارایی',
    bindSaving: 'در حال ذخیره…',
    bindSaved: 'سریال تراشه روی این دارایی ذخیره شد.',
    bindAlready: 'این تراشه هم‌اکنون به همین دارایی متصل است.',
    bindReplaceWarning: 'این دارایی در حال حاضر سریال دیگری دارد و جایگزین می‌شود:',
    bindNoSerial: 'این تگ سریال سخت‌افزاری قابل خواندنی ندارد، بنابراین قابل اتصال نیست.',
    saveError: 'ذخیره سریال ناموفق بود.',
    saveForbidden: 'برای ثبت سریال روی دارایی دسترسی ندارید.'
  },
} as const

export default fa
export type Translations = typeof fa
