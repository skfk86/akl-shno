// اختبار المراجعة التلقائية (notify/review.mjs) على محاكي Firestore، مع GitHub Models الحقيقي.
// التشغيل: firebase emulators:exec --only firestore "node review.test.mjs"
import { initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { readFileSync } from "node:fs";
import { reviewRestaurant } from "../notify/review.mjs";

initializeApp({ projectId: "demo-akl-shno" });
const db = getFirestore();
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log("  ✓", name); }
  catch (e) { fail++; console.log("  ✗", name, "\n     ", String(e.message || e).slice(0, 300)); }
}
const expect = (c, m) => { if (!c) throw new Error(m); };
const jpg = "data:image/jpeg;base64," + readFileSync(new URL("./proof.jpg", import.meta.url)).toString("base64");

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
let res;
await t("صورة تصميم (ليست واجهة حقيقية) لا تُقبل تلقائياً", async () => {
  res = await reviewRestaurant(db, await rest("r1"));
  console.log("      →", res.decision, "|", res.reason, "|", res.report.ai?.note || "no ai");
  expect(res.decision !== "approve", "graphic image was auto-approved");
});
await t("الذكاء الاصطناعي (GitHub Models) متاح ويرد", async () => {
  expect(res.report.ai, "AI unavailable — check models: read permission and GITHUB_TOKEN");
  console.log("      → model:", res.report.ai.model);
});
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
