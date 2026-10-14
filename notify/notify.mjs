// أكل شنو؟ — مرسل الإشعارات
// يعمل في GitHub Actions كل 5 دقائق (بديل مجاني عن Cloud Functions):
//   1) طلب جديد        ← إشعار لصاحب المطعم
//   2) تغيّر حالة الطلب  ← إشعار للزبون
//   3) قرب انتهاء الاشتراك ← إشعار لصاحب المطعم (مرة واحدة)
// يحفظ في كل طلب ما أُرسل عنه، فلا يتكرر الإشعار.

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";

initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SA)) });
const db = getFirestore(), fcm = getMessaging();

const code = id => "#" + id.slice(-5).toUpperCase();
const money = n => Number(n || 0).toLocaleString("en") + " ج";
const CUSTOMER_MSG = {
  accepted: ["تم قبول طلبك", "بدأ المطعم في تجهيز طلبك"],
  preparing: ["طلبك قيد التحضير", "المطعم يحضّر طلبك الآن"],
  ready: ["طلبك جاهز للاستلام", "تفضل باستلام طلبك من المطعم"],
  out_for_delivery: ["طلبك في الطريق إليك", "المندوب خرج بطلبك، جهّز نفسك للاستلام"],
  delivered: ["تم تسليم طلبك", "بالهناء والعافية! قيّم تجربتك من التطبيق"],
  rejected: ["تعذر قبول طلبك", "اعتذر المطعم عن الطلب، جرّب مطعماً آخر"]
};

const tokens = new Map();
async function tokenOf(uid) {
  if (!tokens.has(uid)) tokens.set(uid, (await db.doc(`users/${uid}`).get()).get("fcmToken") || null);
  return tokens.get(uid);
}

let sent = 0, skipped = 0, failed = 0;
async function push(uid, title, body, data = {}) {
  const token = await tokenOf(uid);
  if (!token) { skipped++; return; }
  try {
    await fcm.send({
      token, notification: { title, body }, data,
      android: { priority: "high", notification: { channelId: "orders", sound: "default" } }
    });
    sent++;
  } catch (e) {
    failed++;
    console.log(`  ! ${uid}: ${e.code || e.message}`);
    if (["messaging/registration-token-not-registered", "messaging/invalid-registration-token"].includes(e.code)) {
      await db.doc(`users/${uid}`).update({ fcmToken: null }).catch(() => {});
    }
  }
}

// ───── الطلبات خلال آخر 24 ساعة ─────
const since = Timestamp.fromMillis(Date.now() - 24 * 3600e3);
const orders = await db.collection("orders").where("createdAt", ">", since).get();
for (const d of orders.docs) {
  const o = d.data(), upd = {};
  if (!o.notifiedNew) {
    const what = o.type === "pickup" ? "استلام من المطعم" : `توصيل إلى ${o.zone || "الزبون"}`;
    await push(o.restaurantId, `طلب جديد ${code(d.id)} · ${money(o.total)}`,
      `${o.customerName || "زبون"} — ${what}. افتح التطبيق للقبول.`, { orderId: d.id, kind: "new" });
    upd.notifiedNew = true;
  }
  if (CUSTOMER_MSG[o.status] && o.lastNotifiedStatus !== o.status) {
    const [title, body] = CUSTOMER_MSG[o.status];
    await push(o.customerId, `${title} ${code(d.id)}`, `${o.restaurantName || ""}: ${body}`, { orderId: d.id, kind: o.status });
    upd.lastNotifiedStatus = o.status;
  }
  if (Object.keys(upd).length) await d.ref.update(upd);
}

// ───── تذكير قبل انتهاء الاشتراك بـ 5 أيام ─────
const soon = Timestamp.fromMillis(Date.now() + 5 * 864e5);
const expiring = await db.collection("restaurants").where("subActiveUntil", "<=", soon).get();
for (const d of expiring.docs) {
  const r = d.data(), until = r.subActiveUntil?.toMillis?.();
  if (!until || until < Date.now() || r.expiryNotified === until) continue;
  const days = Math.ceil((until - Date.now()) / 864e5);
  await push(d.id, "اشتراكك ينتهي قريباً", `باقي ${days} أيام على اشتراك ${r.name}. جدّده من التطبيق حتى لا يختفي مطعمك.`, { kind: "renew" });
  await d.ref.update({ expiryNotified: until });
}

// ───── حظر الأجهزة: 3 إنذارات ← الجهاز محظور، وأقل من ذلك ← يُرفع ─────
let bannedNew = 0, unbanned = 0;
const strikers = await db.collection("users").where("strikes", ">=", 3).get();
for (const u of strikers.docs) {
  const x = u.data(); if (!x.deviceId) continue;
  const ref = db.doc(`bannedDevices/${x.deviceId}`);
  if (!(await ref.get()).exists) {
    await ref.set({ uid: u.id, name: x.name || "", phone: x.phone || "", strikes: x.strikes, at: Timestamp.now() });
    bannedNew++;
  }
}
for (const b of (await db.collection("bannedDevices").get()).docs) {
  const uid = b.get("uid"); if (!uid) continue;
  const s = (await db.doc(`users/${uid}`).get()).get("strikes") || 0;
  if (s < 3) { await b.ref.delete(); unbanned++; }
}
console.log(`devices banned: ${bannedNew} · unbanned: ${unbanned}`);

console.log(`orders checked: ${orders.size} · sent: ${sent} · no token: ${skipped} · failed: ${failed}`);
process.exit(0);
