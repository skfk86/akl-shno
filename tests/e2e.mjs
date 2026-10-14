// فحص شامل من البداية للنهاية لتطبيق أكل شنو؟
// يشغّل التطبيق الحقيقي (www) في Chromium مع محاكي Firebase Auth وFirestore،
// ويحاكي ثلاثة مستخدمين معاً: صاحب مطعم، والأدمن، وزبون.
// التشغيل: firebase emulators:exec --only auth,firestore "node e2e.mjs"

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync, cpSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

const PROJECT = "demo-akl-shno";
const AUTH = "127.0.0.1:9099", FS = "127.0.0.1:8080";
const WWW = "./e2e-www", SHOTS = "./shots";
const HOME = [15.6445, 32.4777];          // أمدرمان
const REST = [15.6500, 32.4800];          // موقع المطعم (~700 م)

// ───── نسخة من التطبيق موصولة بالمحاكي ─────
mkdirSync(SHOTS, { recursive: true });
cpSync("../www", WWW, { recursive: true });
let fb = readFileSync(join(WWW, "firebase.js"), "utf8");
fb = fb
  .replace('projectId: "whate-eate"', `projectId: "${PROJECT}"`)
  .replace("signInWithCredential, onAuthStateChanged, signOut",
           "signInWithCredential, onAuthStateChanged, signOut, connectAuthEmulator, signInWithEmailAndPassword, createUserWithEmailAndPassword")
  .replace("getFirestore, doc,", "getFirestore, connectFirestoreEmulator, doc,")
  .replace("export const db = getFirestore(app);",
    `export const db = getFirestore(app);
connectAuthEmulator(auth, "http://${AUTH}", { disableWarnings: true });
connectFirestoreEmulator(db, "127.0.0.1", 8080);`)
  .replace(/export async function signInGoogle\(\) \{[\s\S]*?\n\}/,
    `export async function signInGoogle() {
  const { email, pass } = window.__LOGIN;
  try { return await signInWithEmailAndPassword(auth, email, pass); }
  catch { return await createUserWithEmailAndPassword(auth, email, pass); }
}`);
if (!fb.includes("connectFirestoreEmulator(db")) throw new Error("patching firebase.js failed");
writeFileSync(join(WWW, "firebase.js"), fb);

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };
const server = createServer((req, res) => {
  const p = join(WWW, decodeURIComponent(req.url.split("?")[0]).replace(/^\/$/, "/index.html"));
  if (!existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": MIME[extname(p)] || "application/octet-stream" });
  res.end(readFileSync(p));
}).listen(5173);
const URL = "http://127.0.0.1:5173/index.html";

// ───── أدوات ─────
let pass = 0, fail = 0;
const results = [];
async function t(name, fn) {
  try { await fn(); pass++; results.push("  ✓ " + name); console.log("  ✓", name); }
  catch (e) { fail++; const m = String(e.message || e).split("\n")[0].slice(0, 240); results.push("  ✗ " + name + "\n      " + m); console.log("  ✗", name, "\n     ", m); }
}
const section = s => { results.push("\n" + s); console.log("\n" + s); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
function expect(cond, msg) { if (!cond) throw new Error(msg); }

const browser = await chromium.launch();
const pageErrors = [];
async function user(label, email, loc = HOME) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, locale: "ar",
    geolocation: { latitude: loc[0], longitude: loc[1] }, permissions: ["geolocation"]
  });
  await ctx.addInitScript(([e]) => { window.__LOGIN = { email: e, pass: "test1234" }; }, [email]);
  const pg = await ctx.newPage();
  pg.on("pageerror", e => pageErrors.push(`[${label}] ${e.message}`));
  pg.on("dialog", d => d.accept());
  pg.label = label;
  return pg;
}
const screen = pg => pg.evaluate(() => document.querySelector(".screen.on")?.id);
async function waitScreen(pg, id, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await screen(pg) === id) return; await sleep(200); }
  throw new Error(`expected #${id}, got #${await screen(pg)}`);
}
const shot = (pg, name) => pg.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }).catch(() => {});
const toastText = pg => pg.evaluate(() => document.querySelector("#toast.on")?.textContent || "");
const tap = (pg, sel) => pg.locator(sel).first().click();
async function signUpRest(email, password = "test1234") {
  const r = await fetch(`http://${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true })
  });
  return (await r.json()).localId;
}
async function seed(path, data) {
  const url = `http://${FS}/v1/projects/${PROJECT}/databases/(default)/documents/${path}`;
  const fields = Object.fromEntries(Object.entries(data).map(([k, v]) =>
    [k, typeof v === "number" ? { integerValue: String(v) } : typeof v === "boolean" ? { booleanValue: v } : { stringValue: String(v) }]));
  const r = await fetch(url, { method: "PATCH", headers: { "content-type": "application/json", Authorization: "Bearer owner" }, body: JSON.stringify({ fields }) });
  if (!r.ok) throw new Error("seed failed " + (await r.text()));
}

// ═════════════════════════════════════════
section("1. تسجيل المطعم");
const owner = await user("owner", "owner@test.sd", REST);
await owner.goto(URL);
await t("شاشة الترحيب تظهر", () => waitScreen(owner, "s-welcome"));
await t("اختيار «أملك مطعماً» يفتح نموذج التسجيل", async () => {
  await tap(owner, '[data-role="owner"]'); await waitScreen(owner, "s-ownerreg");
});
await t("التحقق يرفض النموذج الفارغ", async () => {
  await tap(owner, "#o-save"); await sleep(300);
  expect((await owner.textContent("#o-err")).length > 3, "no validation error");
});
await t("تسجيل المطعم يفتح لوحة المطعم", async () => {
  await owner.fill("#o-name", "مطعم الاختبار");
  await owner.selectOption("#o-cat", "مشويات");
  await owner.selectOption("#o-city", "أمدرمان");
  await owner.fill("#o-district", "الثورة");
  await owner.fill("#o-phone", "912345678");
  await tap(owner, "#o-save"); await waitScreen(owner, "s-owner");
});
await t("المطعم الجديد يظهر «قيد المراجعة»", async () => {
  expect((await owner.textContent("#ow-head")).includes("قيد المراجعة"), "no pending note");
});
await t("إضافة صنف بسعر مخفّض", async () => {
  await tap(owner, '.screen.on nav [data-go="menu"]'); await sleep(800);
  await tap(owner, '[data-new="item"]'); await sleep(300);
  await owner.fill("#it-name", "صحن كبدة");
  await owner.fill("#it-price", "6000");
  await owner.fill("#it-old", "8000");
  await tap(owner, "#it-save"); await sleep(1500);
  const txt = await owner.textContent("#ow-body");
  expect(txt.includes("صحن كبدة") && txt.includes("-25%"), "item or discount badge missing");
});
await t("رفض سعر خصم أقل من السعر الحالي", async () => {
  await tap(owner, '[data-new="item"]'); await sleep(300);
  await owner.fill("#it-name", "خطأ"); await owner.fill("#it-price", "5000"); await owner.fill("#it-old", "4000");
  await tap(owner, "#it-save"); await sleep(300);
  expect((await owner.textContent("#it-err")).includes("أكبر"), "no error");
  await owner.evaluate(() => document.querySelector("#sheet").classList.remove("on"));
});
await t("إضافة عرض", async () => {
  await tap(owner, '[data-new="offer"]'); await sleep(300);
  await owner.fill("#of-title", "توصيل مجاني فوق 10,000 ج");
  await tap(owner, "#of-save"); await sleep(1500);
  expect((await owner.textContent("#ow-body")).includes("توصيل مجاني فوق"), "offer missing");
});
await t("إضافة منطقة توصيل", async () => {
  await tap(owner, '.screen.on nav [data-go="settings"]'); await sleep(1000);
  await tap(owner, "[data-zone-new]"); await sleep(300);
  await owner.fill("#z-name", "الثورة"); await owner.fill("#z-fee", "1000"); await owner.fill("#z-time", "30 د");
  await tap(owner, "#z-save"); await sleep(1500);
  expect((await owner.textContent("#ow-body")).includes("الثورة"), "zone missing");
});
await t("تحديد موقع المطعم على الخريطة", async () => {
  await tap(owner, "#st-loc-edit"); await sleep(2500);
  await tap(owner, "#pk-ok"); await sleep(1800);
  expect(!(await owner.evaluate(() => document.querySelector("#picker").classList.contains("on"))), "picker still open: " + await owner.textContent("#pk-err"));
  expect((await owner.textContent("#ow-body")).includes("محدد"), "location not saved");
});
await t("فتح المطعم", async () => {
  await owner.locator("#ow-open").check({ force: true }); await sleep(1200);
  expect((await owner.textContent("#ow-head")).includes("مفتوح"), "not open");
});
await shot(owner, "01-owner-settings");

// ═════════════════════════════════════════
section("2. الأدمن");
const adminUid = await signUpRest("admin@test.sd");
await seed(`users/${adminUid}`, { role: "customer", name: "الأدمن", phone: "+249900000001", strikes: 0, delivered: 0 });
await seed(`admins/${adminUid}`, { name: "admin" });
const admin = await user("admin", "admin@test.sd");
await admin.goto(URL);
await t("حساب الأدمن يفتح لوحة الأدمن", async () => {
  await tap(admin, '[data-role="customer"]'); await waitScreen(admin, "s-admin");
});
await t("المطعم الجديد يظهر «بانتظار التفعيل»", async () => {
  await sleep(1500); expect((await admin.textContent("#ad-body")).includes("بانتظار التفعيل"), "not listed as pending");
});
await t("تفعيل الشهرين المجانيين", async () => {
  await tap(admin, "[data-trial]"); await sleep(2000);
  expect((await admin.textContent("#ad-body")).includes("يوماً"), "not activated");
});
await t("توثيق المطعم", async () => {
  await tap(admin, '[data-verify][data-v="1"]'); await sleep(1800);
  expect((await admin.textContent("#ad-body")).includes("موثّق"), "no verified badge");
});
await shot(admin, "02-admin");

// ═════════════════════════════════════════
section("3. الزبون: من التسجيل حتى الطلب");
const cust = await user("customer", "customer@test.sd");
await cust.goto(URL);
await t("التسجيل كزبون", async () => {
  await tap(cust, '[data-role="customer"]'); await waitScreen(cust, "s-customer");
  await cust.fill("#c-name", "أحمد"); await cust.fill("#c-phone", "923456789");
  await tap(cust, "#c-save"); await waitScreen(cust, "s-home");
});
await t("المطعم المفعّل يظهر في الرئيسية", async () => {
  await sleep(2500); expect((await cust.textContent("#h-list")).includes("مطعم الاختبار"), "restaurant not listed");
});
await t("قسم العروض والتخفيضات يظهر", async () => {
  await sleep(1500); const x = await cust.textContent("#h-offers");
  expect(x.includes("العروض") && x.includes("صحن كبدة"), "offers section missing");
});
await t("شارة التوثيق والمسافة", async () => {
  const x = await cust.textContent("#h-list"); expect(x.includes("موثّق") && /م|كم/.test(x), "badge or distance missing");
});
await t("لا تمرير أفقي في الرئيسية", async () => {
  const w = await cust.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(w[0] <= w[1], `scrollWidth ${w[0]} > ${w[1]}`);
});
await t("«الأقرب لي» يعرض المطعم بالمسافة", async () => {
  await tap(cust, "#h-nearest"); await sleep(1500);
  const x = await cust.textContent("#sheet"); expect(x.includes("مطعم الاختبار") && x.includes("بالسيارة"), "nearest sheet wrong");
  await cust.evaluate(() => document.querySelector("#sheet").classList.remove("on"));
});
await t("التبديل لعرض الخريطة", async () => {
  await tap(cust, '[data-view="map"]'); await sleep(1500);
  expect(await cust.locator("#h-mapwrap .leaflet-container").count() === 1, "map did not render");
  expect(await cust.locator("#h-mapwrap .mpin").count() >= 1, "no restaurant pin");
  await tap(cust, '[data-view="list"]');
});
await t("البحث باسم وجبة يعرض الصنف والمطعم", async () => {
  await cust.fill("#h-search", "كبده"); await sleep(600);   // تطبيع: ه/ة
  expect(await cust.locator("#h-dishes .dish").count() === 1, "dish not found");
  expect((await cust.textContent("#h-list")).includes("مطعم الاختبار"), "restaurant not matched by dish");
});
await t("بحث بلا نتائج يعرض رسالة واضحة", async () => {
  await cust.fill("#h-search", "بيتزا"); await sleep(600);
  expect((await cust.textContent("#h-list")).includes("لا توجد نتائج"), "no empty state");
  await tap(cust, "#h-clear"); await sleep(400);
});
await t("فلتر «توصيل مجاني» يستبعد المطعم برسوم توصيل", async () => {
  await tap(cust, "#h-filter"); await sleep(300);
  await tap(cust, '[data-tog="freeDel"]'); await tap(cust, "#f-apply"); await sleep(500);
  expect(!(await cust.textContent("#h-list")).includes("مطعم الاختبار"), "fee 1000 restaurant should be excluded");
  expect((await cust.textContent("#h-fcount")) === "1", "filter badge");
  await tap(cust, '#h-active [data-unf="freeDel"]'); await sleep(400);
  expect((await cust.textContent("#h-list")).includes("مطعم الاختبار"), "not restored after removing filter");
});
await shot(cust, "03-home");
await t("فتح المطعم وإضافة صنف للسلة", async () => {
  await tap(cust, '#h-list [data-rest]'); await waitScreen(cust, "s-rest"); await sleep(1500);
  expect((await cust.textContent("#r-body")).includes("8,000"), "old price missing");
  await tap(cust, "[data-add]"); await tap(cust, "[data-add]"); await sleep(300);
  await tap(cust, "#r-cart"); await waitScreen(cust, "s-cart");
});
await t("لا يمكن الإرسال بدون منطقة وموقع", async () => {
  await tap(cust, "#cart-send"); await sleep(300);
  expect((await cust.textContent("#cart-err")).length > 3, "no validation");
});
await t("اختيار المنطقة يحسب رسوم التوصيل", async () => {
  const v = await cust.locator("#cart-zone option").nth(1).getAttribute("value");
  await cust.selectOption("#cart-zone", v); await sleep(400);
  expect((await cust.textContent("#cart-body")).includes("13,000"), "total should be 12,000 + 1,000");
});
await t("تحديد الموقع وحفظه كعنوان «البيت»", async () => {
  await tap(cust, "#cart-pick"); await sleep(2500);
  await cust.fill("#pk-land", "جنب مسجد الحارة");
  await tap(cust, '#pk-labels [data-lbl="البيت"]');
  await tap(cust, "#pk-ok"); await sleep(800);
  expect((await cust.textContent("#cart-body")).includes("جنب مسجد الحارة"), "address card missing: " + await cust.textContent("#pk-err").catch(() => ""));
});
await t("تحذير بنكك لا يظهر لمطعم موثّق", async () => {
  const has = await cust.locator('input[name="pay"][value="bankak"]:not([disabled])').count();
  if (!has) return; // المطعم لم يضف رقم بنكك
  await cust.locator('input[name="pay"][value="bankak"]').check(); await sleep(300);
  expect(!(await cust.textContent("#cart-body")).includes("لا تحوّل المال مسبقاً"), "warning shown for verified");
  await cust.locator('input[name="pay"][value="cash"]').check(); await sleep(300);
});
await t("إرسال الطلب يفتح شاشة التتبع", async () => {
  await tap(cust, "#cart-send"); await waitScreen(cust, "s-track"); await sleep(1500);
  expect((await cust.textContent("#t-body")).includes("تم إرسال الطلب"), "tracking not shown");
});
await shot(cust, "04-track");

// ═════════════════════════════════════════
section("4. المطعم يستقبل الطلب وينفّذه");
await t("الطلب يصل للمطعم لحظياً مع شارة «زبون جديد»", async () => {
  await tap(owner, '.screen.on nav [data-go="orders"]'); await sleep(2500);
  const x = await owner.textContent("#ow-body");
  expect(x.includes("أحمد") && x.includes("زبون جديد") && x.includes("جنب مسجد الحارة"), "order not received");
});
await t("الدردشة: الزبون يرسل والمطعم يستلم لحظياً", async () => {
  await tap(cust, "#t-chat"); await waitScreen(cust, "s-chat");
  await cust.fill("#ch-input", "هل يمكن إضافة شطة؟"); await tap(cust, "#ch-send"); await sleep(1500);
  expect((await cust.textContent("#ch-list")).includes("إضافة شطة"), "own message not shown");
  await sleep(1000);
  expect(await owner.locator("[data-chat] .dot").count() >= 1, "owner has no unread dot");
  await tap(owner, "[data-chat]"); await waitScreen(owner, "s-chat"); await sleep(1500);
  expect((await owner.textContent("#ch-list")).includes("إضافة شطة"), "owner did not receive");
});
await t("الدردشة: المطعم يرد برد سريع والزبون يستلم", async () => {
  await tap(owner, '#ch-qr [data-q]'); await sleep(2000);
  expect((await cust.locator("#ch-list .bub.them").count()) >= 1, "customer did not receive reply");
  await tap(owner, "#ch-back"); await waitScreen(owner, "s-owner");
  await tap(cust, "#ch-back"); await waitScreen(cust, "s-track");
});
for (const [act, label, cust_sees] of [
  ["accept", "قبول", "المطعم قبل الطلب"], ["prepare", "بدء التحضير", "قيد التحضير"],
  ["out", "خرج للتوصيل", "في الطريق إليك"], ["delivered", "تم التسليم", "تم التسليم"]]) {
  await t(`${label} ← الزبون يرى «${cust_sees}» لحظياً`, async () => {
    if (act !== "accept") { await tap(owner, '[data-seg="active"]'); await sleep(400); }
    await tap(owner, `[data-act="${act}"]`); await sleep(2500);
    const x = await cust.textContent("#t-body"); expect(x.includes(cust_sees), "customer did not update");
  });
}

// ═════════════════════════════════════════
section("5. التقييم");
await t("نموذج التقييم يظهر بعد التسليم", async () => {
  await sleep(1000); expect(await cust.locator("#rt-stars [data-star]").count() === 5, "no rating form");
});
await t("إرسال تقييم 5 نجوم", async () => {
  await tap(cust, '[data-star="5"]'); await cust.fill("#rt-text", "أكل ممتاز وتوصيل سريع");
  await tap(cust, "#rt-send"); await sleep(2000);
  expect((await cust.textContent("#t-body")).includes("قيّمت"), "rating not saved");
});
await t("التقييم يظهر في صفحة المطعم", async () => {
  await tap(cust, '.screen.on [data-go="myorders"]'); await waitScreen(cust, "s-myorders");
  await tap(cust, '.screen.on nav [data-go="home"]'); await waitScreen(cust, "s-home"); await sleep(2500);
  await tap(cust, '#h-list [data-rest]'); await waitScreen(cust, "s-rest"); await sleep(1800);
  const x = await cust.textContent("#r-body"); expect(x.includes("5.0") && x.includes("أكل ممتاز"), "rating not shown");
});
await t("صفحة المطعم تعرض خريطة الموقع", async () => {
  expect(await cust.locator("#r-map .leaflet-container").count() === 1, "no location map");
});
await shot(cust, "05-restaurant");

// ═════════════════════════════════════════
section("6. بلاغ عدم الاستلام والاعتراض");
await t("طلب ثانٍ يصل للمطعم", async () => {
  await tap(cust, "[data-add]"); await sleep(200); await tap(cust, "#r-cart"); await waitScreen(cust, "s-cart");
  const v = await cust.locator("#cart-zone option").nth(1).getAttribute("value");
  await cust.selectOption("#cart-zone", v); await sleep(300);
  await tap(cust, '[data-addr="0"]'); await sleep(500);
  await tap(cust, "#cart-send"); await waitScreen(cust, "s-track"); await sleep(2500);
  await tap(owner, '[data-seg="new"]'); await sleep(500);
  expect(await owner.locator('[data-act="accept"]').count() === 1, "second order missing");
});
await t("المطعم يوصل الطلب ثم يبلّغ «لم يستلم»", async () => {
  await tap(owner, '[data-act="accept"]'); await sleep(1500);
  await tap(owner, '[data-seg="active"]'); await sleep(400);
  await tap(owner, '[data-act="prepare"]'); await sleep(1500);
  await tap(owner, '[data-act="out"]'); await sleep(1500);
  await tap(owner, '[data-act="report"]'); await sleep(500);
  await tap(owner, "#rp-send"); await sleep(2500);
  expect((await toastText(owner)).includes("البلاغ") || (await owner.locator('[data-act="report"][disabled]').count()) === 1, "report not sent");
});
await t("الزبون يرى البلاغ ويعترض", async () => {
  await sleep(1500); expect(await cust.locator("#t-dispute").count() === 1, "no dispute form");
  await cust.fill("#t-dispute", "لم يتصل بي المندوب");
  await tap(cust, "#t-dispute-send"); await sleep(2000);
  expect((await cust.textContent("#t-report")).includes("قيد المراجعة"), "dispute not sent");
});
await t("الأدمن يرى الاعتراض ويلغي البلاغ", async () => {
  await admin.reload(); await waitScreen(admin, "s-admin");
  await tap(admin, '#ad-seg [data-t="rep"]'); await sleep(2000);
  expect((await admin.textContent("#ad-body")).includes("لم يتصل بي المندوب"), "dispute not visible");
  await tap(admin, "[data-rep-cancel]"); await sleep(2000);
  expect((await admin.textContent("#ad-body")).includes("لا توجد اعتراضات"), "not resolved");
});
await shot(admin, "06-admin-reports");

// ═════════════════════════════════════════
section("7. الحساب والتنقل");
await t("حسابي يعرض الطلبات والعنوان المحفوظ", async () => {
  await tap(cust, '.screen.on [data-go="home"]').catch(() => {});
  await cust.goto(URL); await waitScreen(cust, "s-home");
  await tap(cust, '.screen.on nav [data-go="account"]'); await waitScreen(cust, "s-account"); await sleep(1500);
  const x = await cust.textContent("#ac-body"); expect(x.includes("البيت") && x.includes("جنب مسجد"), "address missing");
});
await t("الإنذار ألغي بعد قبول الاعتراض", async () => {
  expect(!(await cust.textContent("#ac-body")).includes("إنذار"), "strike still shown");
});
await t("«عن التطبيق» يرجع لحسابي", async () => {
  await tap(cust, '#ac-body [data-go="about"]'); await waitScreen(cust, "s-about");
  await tap(cust, "#ab-back"); await waitScreen(cust, "s-account");
});
await t("القائمة الجانبية تفتح وتنقل", async () => {
  await tap(cust, '.screen.on nav [data-go="home"]'); await waitScreen(cust, "s-home");
  await tap(cust, "[data-drawer]"); await sleep(300);
  await tap(cust, '#drawer [data-go="myorders"]'); await waitScreen(cust, "s-myorders");
  expect((await cust.textContent("#mo-list")).includes("مطعم الاختبار"), "orders missing");
});
await t("إحصاءات المطعم تحسب المبيعات", async () => {
  await tap(owner, '.screen.on nav [data-go="stats"]'); await sleep(1500);
  expect((await owner.textContent("#ow-body")).includes("13,000"), "sales should include the delivered order");
});
await t("إيقاف المطعم يخفيه عن الزبون", async () => {
  await tap(admin, '#ad-seg [data-t="rest"]'); await sleep(1500);
  await tap(admin, '[data-list][data-v="0"]'); await sleep(2000);
  await cust.goto(URL); await waitScreen(cust, "s-home"); await sleep(2500);
  expect(!(await cust.textContent("#h-list")).includes("مطعم الاختبار"), "suspended restaurant still listed");
});
await shot(owner, "07-owner-stats");

// ═════════════════════════════════════════
section("8. حذف الحساب");
await t("الزبون يحذف حسابه ويعود لشاشة الترحيب", async () => {
  await tap(cust, '.screen.on nav [data-go="account"]'); await waitScreen(cust, "s-account"); await sleep(800);
  await tap(cust, "[data-delete-account]"); await sleep(300);
  expect(await cust.locator("#del-go[disabled]").count() === 1, "delete should need confirmation");
  await cust.fill("#del-confirm", "حذف"); await tap(cust, "#del-go");
  await waitScreen(cust, "s-welcome", 20000);
});
await t("الدخول من جديد يبدأ حساباً جديداً", async () => {
  await tap(cust, '[data-role="customer"]'); await waitScreen(cust, "s-customer");
});

section("أخطاء JavaScript أثناء الفحص");
await t("لا توجد أخطاء JavaScript", () => expect(!pageErrors.length, pageErrors.slice(0, 5).join(" | ")));

await browser.close(); server.close();
const summary = `${pass} نجح، ${fail} فشل`;
console.log("\n" + summary);
writeFileSync("e2e-results.txt", results.join("\n") + "\n\n" + summary + "\n");
process.exit(fail ? 1 : 0);
