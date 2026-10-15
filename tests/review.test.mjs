// اختبار المراجعة التلقائية (notify/review.mjs) على محاكي Firestore، مع GitHub Models الحقيقي.
// التشغيل: firebase emulators:exec --only firestore "node review.test.mjs"
import { initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { reviewRestaurant, nameMatch } from "../notify/review.mjs";

initializeApp({ projectId: "demo-akl-shno" });
const db = getFirestore();
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log("  ✓", name); }
  catch (e) { fail++; console.log("  ✗", name, "\n     ", String(e.message || e).slice(0, 300)); }
}
const expect = (c, m) => { if (!c) throw new Error(m); };
const img = f => "data:image/jpeg;base64," + readFileSync(new URL(f, import.meta.url)).toString("base64");
const jpg = img("./proof.jpg"), poster = img("./fake-poster.jpg"), photo = img("./real-photo.jpg"), shot = img("./screenshot.jpg");
const camera = (ago = 3600e3, extra = {}) => ({ proofMeta: { sign: { camera: true, make: "samsung", model: "SM-A155F", software: "A155FXXU1", taken: Date.now() - ago, ...extra } } });
let n = 10;
const fresh = (extra = {}) => ({ phone: `+2499120${String(++n).padStart(5, "0")}`, name: `مطعم تجربة ${n}`, ...extra });
// نفس الصورة بإعادة ضغط مختلفة (بصمة مختلفة) لتجربة حالات أخرى دون كشف التكرار
const uniq = async d => "data:image/jpeg;base64," + (await sharp(Buffer.from(d.split(",")[1], "base64")).jpeg({ quality: 70 + (++n % 25) }).toBuffer()).toString("base64");

async function rest(id, extra = {}, img = jpg) {
  await db.doc(`images/img-${id}`).set({ owner: id, data: img });
  await db.doc(`users/${id}`).set({ role: "owner", name: id, deviceId: "dev-" + id });
  await db.doc(`restaurants/${id}`).set({
    name: "مطعم الريان", category: "مشويات", city: "أمدرمان", district: "الثورة", phone: "+249912000111",
    lat: 15.64, lng: 32.48, review: "pending", reviewAt: Timestamp.now(), proofs: { sign: `img-${id}`, license: "" }, ...extra
  });
  return db.doc(`restaurants/${id}`).get();
}

console.log("\nالمراجعة التلقائية للمطاعم");
await t("مطابقة اسم اللافتة: «مطعم الريّان» = «الريان»", () => expect(nameMatch("مطعم الريّان", "الريان") === "yes", nameMatch("مطعم الريّان", "الريان")));
await t("مطابقة اسم اللافتة: «شواية الساقية» ≠ «مطعم النيل»", () => expect(nameMatch("شواية الساقية", "مطعم النيل") === "no", "matched"));
await t("لافتة فارغة ← غير معروف", () => expect(nameMatch("", "مطعم النيل") === "unknown", "should be unknown"));
let res;
await t("تصميم مسطّح ← رفض تلقائي", async () => {
  res = await reviewRestaurant(db, await rest("r1", camera()));
  console.log("      →", res.decision, "|", res.reason, "|", JSON.stringify(res.report.stats));
  expect(res.decision === "reject", res.decision);
});
await t("ملصق/إنفوغرافيك (مثل صور الطقس) ← رفض تلقائي", async () => {
  const r = await reviewRestaurant(db, await rest("p1", fresh(camera()), poster));
  console.log("      →", r.decision, "|", JSON.stringify(r.report.stats));
  expect(r.decision === "reject", r.decision + " " + r.reason);
});
await t("لقطة شاشة من التطبيق ← رفض تلقائي", async () => {
  const r = await reviewRestaurant(db, await rest("s1", fresh(camera()), shot));
  console.log("      →", r.decision, "|", JSON.stringify(r.report.stats));
  expect(r.decision === "reject", r.decision + " " + r.reason);
});
await t("صورة كاميرا حقيقية حديثة + كل الفحوصات ← قبول تلقائي", async () => {
  const r = await reviewRestaurant(db, await rest("ok1", fresh(camera()), photo));
  console.log("      →", r.decision, "|", r.reason, "|", JSON.stringify(r.report.stats));
  r.report.checks.forEach(c => console.log("      ", c.ok ? "+" : "-", c.label));
  expect(r.decision === "approve", r.decision + " " + r.reason);
});
await t("صورة حقيقية بلا بيانات كاميرا (من المعرض أو الإنترنت) ← للأدمن", async () => {
  const r = await reviewRestaurant(db, await rest("m1", fresh(), await uniq(photo)));
  expect(r.decision === "manual", r.decision);
});
await t("صورة قديمة (قبل شهر) ← للأدمن", async () => {
  const r = await reviewRestaurant(db, await rest("m2", fresh(camera(30 * 864e5)), await uniq(photo)));
  expect(r.decision === "manual", r.decision);
});
await t("صورة معدّلة ببرنامج تصميم ← للأدمن", async () => {
  const r = await reviewRestaurant(db, await rest("m3", fresh(camera(3600e3, { software: "Canva" })), await uniq(photo)));
  expect(r.decision === "manual", r.decision);
});
await t("تقرير الفحص يحوي البنود", async () => {
  expect(res.report.checks.length >= 10, "few checks: " + res.report.checks.length);
  expect(res.hashes.sign, "no image hash");
});
await db.doc(`proofHashes/${res.hashes.sign}`).set({ rid: "r1" });
await t("نفس الصورة لمطعم آخر ← رفض تلقائي", async () => {
  const r = await reviewRestaurant(db, await rest("r2", { phone: "+249912000222", name: "مطعم آخر" }));
  expect(r.decision === "reject" && r.reason.includes("الصورة"), r.decision + " " + r.reason);
});
await t("رقم هاتف مستخدم في مطعم آخر ← رفض تلقائي", async () => {
  const other = jpg.replace(/.{8}$/, "AAAAAAA=");   // صورة مختلفة البصمة
  const r = await reviewRestaurant(db, await rest("r3", { name: "مطعم ثالث" }, other));
  expect(r.decision === "reject" && r.reason.includes("الهاتف"), r.decision + " " + r.reason);
});
await t("موقع خارج السودان ← رفض تلقائي", async () => {
  const r = await reviewRestaurant(db, await rest("r4", { phone: "+249912000444", name: "مطعم رابع", lat: 30.04, lng: 31.23 }, jpg.replace(/.{8}$/, "BBBBBBB=")));
  expect(r.decision === "reject" && r.reason.includes("السودان"), r.decision + " " + r.reason);
});
await t("جهاز محظور ← رفض تلقائي", async () => {
  await db.doc("bannedDevices/dev-r5").set({ uid: "x" });
  const r = await reviewRestaurant(db, await rest("r5", { phone: "+249912000555", name: "مطعم خامس" }, jpg.replace(/.{8}$/, "CCCCCCC=")));
  expect(r.decision === "reject" && r.reason.includes("محظور"), r.decision + " " + r.reason);
});

console.log(`\n${pass} نجح، ${fail} فشل`);
process.exit(fail ? 1 : 0);
