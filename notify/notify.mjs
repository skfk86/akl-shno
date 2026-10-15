// أكل شنو؟ — مرسل الإشعارات
// يعمل في GitHub Actions كل 5 دقائق (بديل مجاني عن Cloud Functions):
//   1) طلب جديد        ← إشعار لصاحب المطعم
//   2) تغيّر حالة الطلب  ← إشعار للزبون
//   3) قرب انتهاء الاشتراك ← إشعار لصاحب المطعم (مرة واحدة)
// يحفظ في كل طلب ما أُرسل عنه، فلا يتكرر الإشعار.

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import { getAuth } from "firebase-admin/auth";

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

  // رسائل الدردشة غير المُبلَّغ عنها في هذا الطلب (رسالة واحدة مجمّعة لكل طرف)
  const msgs = await d.ref.collection("messages").where("notified", "==", false).get();
  if (!msgs.empty) {
    const byTarget = {};
    for (const m of msgs.docs) {
      const x = m.data(), to = x.role === "customer" ? o.restaurantId : o.customerId;
      (byTarget[to] ||= { role: x.role, texts: [] }).texts.push(x.text);
    }
    for (const [to, g] of Object.entries(byTarget)) {
      const fromName = g.role === "customer" ? (o.customerName || "الزبون") : (o.restaurantName || "المطعم");
      const body = g.texts.length > 1 ? `${g.texts.length} رسائل جديدة: ${g.texts.at(-1)}` : g.texts[0];
      await push(to, `رسالة من ${fromName} · ${code(d.id)}`, body.slice(0, 150),
        { orderId: d.id, kind: "chat", title: g.role === "customer" ? fromName : (o.restaurantName || "") });
    }
    const b = db.batch(); msgs.docs.forEach(m => b.update(m.ref, { notified: true })); await b.commit();
  }
}

// ───── الدردشة المباشرة (زبون ↔ مطعم) ─────
const dms = await db.collection("chats").where("lastAt", ">", since).get();
for (const c of dms.docs) {
  const x = c.data();
  const msgs = await c.ref.collection("messages").where("notified", "==", false).get();
  if (msgs.empty) continue;
  for (const role of ["customer", "restaurant"]) {
    const mine = msgs.docs.filter(m => m.get("role") === role);
    if (!mine.length) continue;
    const to = role === "customer" ? x.restaurantId : x.customerId;
    const fromName = role === "customer" ? (x.customerName || "زبون") : (x.restaurantName || "المطعم");
    const body = mine.length > 1 ? `${mine.length} رسائل جديدة: ${mine.at(-1).get("text")}` : mine[0].get("text");
    await push(to, `رسالة من ${fromName}`, body.slice(0, 150), { kind: "dm", chatId: c.id });
  }
  const b = db.batch(); msgs.docs.forEach(m => b.update(m.ref, { notified: true })); await b.commit();
}

// ───── رسائل الدعم ─────
const admins = (await db.collection("admins").get()).docs.map(x => x.id);
const threads = await db.collection("support").where("lastAt", ">", since).get();
for (const t of threads.docs) {
  const msgs = await t.ref.collection("messages").where("notified", "==", false).get();
  if (msgs.empty) continue;
  const fromUser = msgs.docs.filter(m => m.get("role") === "user"), fromAdmin = msgs.docs.filter(m => m.get("role") === "admin");
  if (fromUser.length) for (const a of admins)
    await push(a, `دعم: ${t.get("name") || "مستخدم"}`, fromUser.at(-1).get("text").slice(0, 150), { kind: "support", userId: t.id });
  if (fromAdmin.length)
    await push(t.id, "رد من دعم أكل شنو؟", fromAdmin.at(-1).get("text").slice(0, 150), { kind: "support" });
  const b = db.batch(); msgs.docs.forEach(m => b.update(m.ref, { notified: true })); await b.commit();
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

// ───── الإعلان المميز: تذكير قبل انتهائه بيوم ─────
const featSoon = Timestamp.fromMillis(Date.now() + 864e5);
for (const d of (await db.collection("restaurants").where("featuredUntil", "<=", featSoon).get()).docs) {
  const r = d.data(), until = r.featuredUntil?.toMillis?.();
  if (!until || until < Date.now() || r.featuredNotified === until) continue;
  await push(d.id, "إعلانك المميز ينتهي غداً", `مددّه من الإعدادات ليبقى ${r.name} في أعلى الصفحة الرئيسية.`, { kind: "featured" });
  await d.ref.update({ featuredNotified: until });
}

// المراجعة التلقائية نفسها تعمل في مهمة مستقلة (review.yml) تشغّل نموذج الذكاء الاصطناعي على خادم GitHub.
const reviewCfg = (await db.doc("settings/review").get()).data() || {};
const autoOn = reviewCfg.auto !== false;

// ───── توثيق المطاعم: طلب مراجعة جديد ← الأدمن، والقرار ← صاحب المطعم ─────
const reviews = await db.collection("restaurants").where("review", "in", ["pending", "approved", "rejected"]).get();
for (const d of reviews.docs) {
  const r = d.data();
  if (r.review === "pending") {
    const key = r.reviewAt?.toMillis?.() || 0;
    // ننتظر نتيجة الفحص التلقائي قبل إزعاج الأدمن (أو 30 دقيقة كحد أقصى)
    const waiting = autoOn && r.autoReview?.key !== key && Date.now() - key < 30 * 60e3;
    if (key && r.notifiedReview !== key && !waiting) {
      for (const a of admins) await push(a, r.autoReview?.passed ? "مطعم اجتاز الفحص، بانتظار قبولك" : "مطعم يحتاج مراجعتك", `${r.name} · ${r.district || ""}، ${r.city || ""}${r.autoReview?.reason ? " · " + r.autoReview.reason : ""}`, { kind: "review", rid: d.id });
      await d.ref.update({ notifiedReview: key });
    }
  } else {
    const key = `${r.review}-${r.reviewedAt?.toMillis?.() || 0}`;
    if (r.notifiedDecision !== key) {
      if (r.review === "approved") await push(d.id, "تم قبول مطعمك في أكل شنو؟", "أضف المنيو ومناطق التوصيل وابدأ استقبال الطلبات.", { kind: "approved" });
      if (r.review === "approved" && r.autoApproved)
        for (const a of admins) await push(a, `قُبل تلقائياً: ${r.name}`, "اجتازت الإثباتات كل الفحوصات. يمكنك إلغاء القبول من لوحة الأدمن.", { kind: "review", rid: d.id });
      else await push(d.id, "لم يُقبل طلب مطعمك", (r.rejectReason ? "السبب: " + r.rejectReason + ". " : "") + "صحّح الإثباتات وأعد الإرسال من التطبيق.", { kind: "rejected" });
      await d.ref.update({ notifiedDecision: key });
    }
  }
}

// ───── تنظيف البيانات القديمة (مرة يومياً) ─────
// الرسائل بعد 60 يوماً، وصور إثبات المطاعم بعد 30 يوماً من قرار المراجعة.
const MSG_DAYS = 60, PROOF_DAYS = 30;
const metaRef = db.doc("meta/cleanup"), meta = (await metaRef.get()).data() || {};
if (Date.now() - (meta.at?.toMillis?.() || 0) > 20 * 3600e3) {
  const cut = Timestamp.fromMillis(Date.now() - MSG_DAYS * 864e5);
  const proofCut = Date.now() - PROOF_DAYS * 864e5;
  let msgs = 0, threads = 0, proofs = 0;
  async function wipe(snap) {
    for (let i = 0; i < snap.docs.length; i += 400) {
      const b = db.batch(); snap.docs.slice(i, i + 400).forEach(x => b.delete(x.ref)); await b.commit();
    }
    return snap.size;
  }
  // رسائل الطلبات القديمة: نتقدم بمؤشر زمني حتى لا نقرأ نفس الطلبات كل يوم
  const after = meta.ordersCursor || Timestamp.fromMillis(0);
  const old = await db.collection("orders").where("createdAt", ">", after).where("createdAt", "<", cut).orderBy("createdAt").limit(300).get();
  for (const o of old.docs) msgs += await wipe(await o.ref.collection("messages").get());
  const ordersCursor = old.docs.length ? old.docs.at(-1).get("createdAt") : after;
  // المحادثات المباشرة والدعم: تُحذف الرسائل القديمة، والمحادثة الخاملة كلها
  for (const col of ["chats", "support"]) {
    for (const t of (await db.collection(col).get()).docs) {
      msgs += await wipe(await t.ref.collection("messages").where("at", "<", cut).get());
      if ((t.get("lastAt")?.toMillis?.() || 0) < cut.toMillis()) { await t.ref.delete(); threads++; }
    }
  }
  // صور الإثبات بعد المراجعة
  for (const d of reviews.docs) {
    const r = d.data(), p = r.proofs || {};
    if (r.review === "pending" || !(p.sign || p.license)) continue;
    if ((r.reviewedAt?.toMillis?.() || Date.now()) > proofCut) continue;
    for (const id of [p.sign, p.license].filter(Boolean)) { await db.doc(`images/${id}`).delete().catch(() => {}); proofs++; }
    await d.ref.update({ proofs: { sign: "", license: "" } });
  }
  await metaRef.set({ at: Timestamp.now(), ordersCursor, msgs, threads, proofs });
  console.log(`cleanup: messages ${msgs} · threads ${threads} · proof images ${proofs}`);
}

// ───── حذف الحسابات بطلب الأدمن ─────
// يحذف حساب الدخول والملف الشخصي والمطعم والمنيو والصور والمحادثات. تبقى سجلات الطلبات للمحاسبة والنزاعات.
async function wipeCol(ref) {
  const snap = await ref.get();
  for (let i = 0; i < snap.docs.length; i += 400) { const b = db.batch(); snap.docs.slice(i, i + 400).forEach(x => b.delete(x.ref)); await b.commit(); }
}
for (const q of (await db.collection("deleteQueue").get()).docs) {
  const uid = q.id, ban = q.get("ban") === true;
  if ((await db.doc(`admins/${uid}`).get()).exists) { await q.ref.delete(); continue; }   // لا يُحذف أدمن
  const u = (await db.doc(`users/${uid}`).get()).data() || {};
  if (ban && u.deviceId) await db.doc(`bannedDevices/${u.deviceId}`).set({ uid, name: u.name || "", phone: u.phone || "", manual: true, reason: q.get("reason") || "حذف من الإدارة", at: Timestamp.now() });
  const rest = db.doc(`restaurants/${uid}`);
  for (const sub of ["menu", "offers", "zones"]) await wipeCol(rest.collection(sub));
  await rest.delete();
  await wipeCol(db.collection("images").where("owner", "==", uid));
  await wipeCol(db.doc(`support/${uid}`).collection("messages")); await db.doc(`support/${uid}`).delete();
  for (const f of ["customerId", "restaurantId"])
    for (const c of (await db.collection("chats").where(f, "==", uid).get()).docs) { await wipeCol(c.ref.collection("messages")); await c.ref.delete(); }
  await db.doc(`users/${uid}`).delete();
  await getAuth().deleteUser(uid).catch(e => { if (e.code !== "auth/user-not-found") console.log("  auth delete:", e.code); });
  await q.ref.delete();
  console.log(`deleted account ${uid}${ban ? " + device banned" : ""}`);
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
  const uid = b.get("uid"); if (!uid || b.get("manual")) continue;   // الحظر اليدوي من الإدارة لا يُرفع تلقائياً
  const s = (await db.doc(`users/${uid}`).get()).get("strikes") || 0;
  if (s < 3) { await b.ref.delete(); unbanned++; }
}
console.log(`devices banned: ${bannedNew} · unbanned: ${unbanned}`);

console.log(`orders checked: ${orders.size} · sent: ${sent} · no token: ${skipped} · failed: ${failed}`);
process.exit(0);
