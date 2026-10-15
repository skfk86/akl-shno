// أكل شنو؟ — تشغيل المراجعة التلقائية على طلبات المطاعم المعلّقة
// يعمل في review.yml بعد تشغيل نموذج الرؤية محلياً (Ollama) على خادم GitHub. لا حسابات ولا مفاتيح خارجية.
//   node review-run.mjs --count   ← يطبع عدد الطلبات التي تحتاج فحصاً (لتخطي تحميل النموذج إن لم يوجد شيء)
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { reviewRestaurant, aiProvider } from "./review.mjs";

initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SA)) });
const db = getFirestore();

const cfg = (await db.doc("settings/review").get()).data() || {};
const pend = cfg.auto === false ? [] : (await db.collection("restaurants").where("review", "==", "pending").get()).docs
  .filter(d => { const k = d.get("reviewAt")?.toMillis?.() || 0; return k && d.get("autoReview")?.key !== k; });

if (process.argv.includes("--count")) { console.log(pend.length); process.exit(0); }
console.log(`pending: ${pend.length} · ai: ${aiProvider() || "none"}`);

const restAll = (await db.collection("restaurants").get()).docs.map(d => d.data());
let seats = 20 - restAll.filter(r => r.freeTrial).length;
for (const d of pend) {
  const r = d.data();
  const { decision, reason, hashes, report, passed } = await reviewRestaurant(db, d);
  report.passed = !!passed;
  const upd = { autoReview: report, proofHash: hashes };
  if (decision === "approve") {
    Object.assign(upd, { approved: true, review: "approved", rejectReason: "", reviewedAt: Timestamp.now(), autoApproved: true });
    if (seats > 0 && r.subActiveUntil == null) { Object.assign(upd, { subActiveUntil: Timestamp.fromMillis(Date.now() + 60 * 864e5), freeTrial: true, listed: true }); seats--; }
  } else if (decision === "reject") {
    Object.assign(upd, { approved: false, review: "rejected", rejectReason: reason, reviewedAt: Timestamp.now() });
  }
  // لا نكتب فوق قرار اتخذه الأدمن أثناء الفحص
  const fresh = await d.ref.get();
  if (fresh.get("review") !== "pending" || fresh.get("reviewAt")?.toMillis?.() !== r.reviewAt?.toMillis?.()) { console.log(`skip ${r.name}: changed meanwhile`); continue; }
  await d.ref.update(upd);
  for (const h of Object.values(hashes)) await db.doc(`proofHashes/${h}`).set({ rid: d.id, at: Timestamp.now() }, { merge: true });
  console.log(`${r.name}: ${decision}${reason ? " · " + reason : ""}${report.ai ? ` · ai ${Math.round(report.confidence * 100)}% «${report.ai.sign}» ${report.ai.note}` : ""}`);
}
process.exit(0);
