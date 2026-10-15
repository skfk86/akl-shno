// اختبار المراجعة التلقائية (notify/review.mjs) على محاكي Firestore، مع GitHub Models الحقيقي.
// التشغيل: firebase emulators:exec --only firestore "node review.test.mjs"
import { initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { readFileSync } from "node:fs";
import { reviewRestaurant, aiProvider, nameMatch } from "../notify/review.mjs";

initializeApp({ projectId: "demo-akl-shno" });
const db = getFirestore();
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log("  ✓", name); }
  catch (e) { fail++; console.log("  ✗", name, "\n     ", String(e.message || e).slice(0, 300)); }
}
const expect = (c, m) => { if (!c) throw new Error(m); };
const img = f => "data:image/jpeg;base64," + readFileSync(new URL(f, import.meta.url)).toString("base64");
const jpg = img("./proof.jpg"), poster = img("./fake-poster.jpg");

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
await t("صورة غير موثوقة لا تُقبل تلقائياً", async () => {
  res = await reviewRestaurant(db, await rest("r1"));
  console.log("      →", res.decision, "|", res.reason, "|", res.report.ai ? `${res.report.ai.type}/${res.report.ai.scene} «${res.report.ai.sign}» ${res.report.ai.note}` : "no ai");
  res.report.checks.forEach(c => console.log("      ", c.ok ? "+" : "-", c.label));
  expect(res.decision !== "approve", "graphic image was auto-approved");
});
await t("ملصق/إنفوغرافيك (مثل صور الطقس) لا يُقبل تلقائياً", async () => {
  const r = await reviewRestaurant(db, await rest("p1", { phone: "+249912000666", name: "مطعم سادس" }, poster));
  console.log("      →", r.decision, "|", r.reason, "|", r.report.ai ? `${r.report.ai.type}/${r.report.ai.scene} «${r.report.ai.sign}» ${r.report.ai.note}` : "no ai");
  expect(r.decision !== "approve", "poster was auto-approved");
});
if (aiProvider()) await t(`الذكاء الاصطناعي (${aiProvider()}) متاح ويرد`, async () => {
  expect(res.report.ai, "AI provider configured but did not answer");
});
else console.log("      → لا يوجد مفتاح ذكاء اصطناعي بعد: الفحص يعمل بالقواعد فقط ويحوّل الباقي للأدمن");
await t("تقرير الفحص يحوي البنود", async () => {
  expect(res.report.checks.length >= 6, "few checks: " + res.report.checks.length);
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
