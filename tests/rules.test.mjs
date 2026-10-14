// اختبارات قواعد Firestore لتطبيق أكل شنو؟
// تعمل داخل محاكي Firestore: firebase emulators:exec --only firestore "node rules.test.mjs"

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import {
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, query, where,
  writeBatch, serverTimestamp, increment, Timestamp
} from "firebase/firestore";

const env = await initializeTestEnvironment({
  projectId: "demo-akl-shno",
  firestore: { rules: readFileSync("../firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 }
});

const DAY = 864e5;
const future = Timestamp.fromMillis(Date.now() + 30 * DAY);
const past = Timestamp.fromMillis(Date.now() - DAY);

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log("  ✓", name); }
  catch (e) { fail++; console.log("  ✗", name, "\n     ", e.message?.split("\n")[0]); }
}
const db = uid => env.authenticatedContext(uid).firestore();
const anon = () => env.unauthenticatedContext().firestore();

async function seed() {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async c => {
    const s = c.firestore();
    const user = (id, extra) => setDoc(doc(s, "users", id), { role: "customer", name: id, phone: "+249900000000", addresses: [], strikes: 0, delivered: 0, deviceId: "dev-" + id, ...extra });
    await user("cust");
    await user("vet", { delivered: 5 });
    await user("warned", { strikes: 2, delivered: 5 });
    await user("banned", { strikes: 3 });
    await user("owner", { role: "owner" });
    await user("owner2", { role: "owner" });
    await user("admin");
    await setDoc(doc(s, "admins", "admin"), { name: "admin" });
    const rest = (id, extra) => setDoc(doc(s, "restaurants", id), {
      ownerId: id, name: id, category: "مشويات", city: "أمدرمان", district: "الثورة", phone: "+249911111111",
      isOpen: true, delivery: true, pickup: true, bankak: "123", freeTrial: true, ...extra });
    await rest("owner", { subActiveUntil: future, listed: true });
    await rest("owner2", { subActiveUntil: null, listed: false, freeTrial: false });
    await setDoc(doc(s, "restaurants", "owner", "menu", "m1"), { name: "كبدة", price: 6000, available: true });
  });
}

const order = (customerId, u, extra = {}) => ({
  restaurantId: "owner", restaurantName: "owner", restaurantPhone: "+249911111111",
  items: [{ id: "m1", name: "كبدة", price: 6000, qty: 2 }], subtotal: 12000, deliveryFee: 0, total: 12000,
  type: "delivery", payMethod: "cash", bankakTxn: "", zone: "الثورة", landmark: "جنب المسجد",
  location: { lat: 15.6, lng: 32.4 }, customerId, customerName: customerId, customerPhone: "+249900000000",
  customerStrikes: u.strikes, customerDelivered: u.delivered, status: "new", reported: false,
  createdAt: serverTimestamp(), ...extra
});

async function placeAs(uid, u, extra, id = "o1") {
  return setDoc(doc(db(uid), "orders", id), order(uid, u, extra));
}
async function setOrder(id, data) {
  await env.withSecurityRulesDisabled(c => updateDoc(doc(c.firestore(), "orders", id), data));
}

console.log("\nالمستخدمون");
await seed();
await t("زبون جديد ينشئ ملفه", () => assertSucceeds(setDoc(doc(db("newbie"), "users", "newbie"),
  { role: "customer", name: "x", phone: "+249900000001", addresses: [], strikes: 0, delivered: 0, createdAt: serverTimestamp() })));
await t("لا ينشئ ملفاً بإنذارات أو بطلبات مستلمة مزيفة", () => assertFails(setDoc(doc(db("cheat"), "users", "cheat"),
  { role: "customer", name: "x", phone: "+249900000001", addresses: [], strikes: 0, delivered: 9, createdAt: serverTimestamp() })));
await t("لا يقرأ ملف مستخدم آخر", () => assertFails(getDoc(doc(db("cust"), "users", "vet"))));
await t("يعدّل اسمه وهاتفه", () => assertSucceeds(updateDoc(doc(db("cust"), "users", "cust"), { name: "علي" })));
await t("يحفظ رمز الإشعارات لهاتفه", () => assertSucceeds(updateDoc(doc(db("cust"), "users", "cust"), { fcmToken: "tok-123" })));
await t("لا يحفظ رمز إشعارات لمستخدم آخر", () => assertFails(updateDoc(doc(db("cust"), "users", "vet"), { fcmToken: "tok-123" })));
await t("لا يمسح إنذاراته بنفسه", () => assertFails(updateDoc(doc(db("warned"), "users", "warned"), { strikes: 0 })));

console.log("\nالمطاعم");
await t("الزبون يستعرض المطاعم المفعّلة", () => assertSucceeds(getDocs(query(collection(db("cust"), "restaurants"), where("listed", "==", true)))));
await t("لا يستعرض كل المطاعم بلا فلتر", () => assertFails(getDocs(collection(db("cust"), "restaurants"))));
await t("غير المسجّل لا يستعرض المطاعم", () => assertFails(getDocs(query(collection(anon(), "restaurants"), where("listed", "==", true)))));
await t("لا يفتح مطعماً غير مفعّل", () => assertFails(getDoc(doc(db("cust"), "restaurants", "owner2"))));
await t("المنيو يُقرأ للجميع", () => assertSucceeds(getDoc(doc(db("cust"), "restaurants", "owner", "menu", "m1"))));
await t("صاحب المطعم يقرأ مطعمه غير المفعّل", () => assertSucceeds(getDoc(doc(db("owner2"), "restaurants", "owner2"))));
await t("صاحب المطعم يفتح ويغلق ويحدد موقعه", () => assertSucceeds(updateDoc(doc(db("owner"), "restaurants", "owner"), { isOpen: false, lat: 15.6, lng: 32.4 })));
await t("لا يمدد اشتراكه بنفسه", () => assertFails(updateDoc(doc(db("owner2"), "restaurants", "owner2"), { subActiveUntil: future })));
await t("لا يُظهر مطعمه بنفسه", () => assertFails(updateDoc(doc(db("owner2"), "restaurants", "owner2"), { listed: true })));
await t("لا يوثّق نفسه", () => assertFails(updateDoc(doc(db("owner"), "restaurants", "owner"), { verified: true })));
await t("لا يزوّر تقييمه", () => assertFails(updateDoc(doc(db("owner"), "restaurants", "owner"), { ratingSum: 50, ratingCount: 10 })));
await t("لا يعدّل منيو مطعم آخر", () => assertFails(setDoc(doc(db("owner2"), "restaurants", "owner", "menu", "x"), { name: "x", price: 1 })));
await t("الأدمن يفعّل ويوثّق", () => assertSucceeds(updateDoc(doc(db("admin"), "restaurants", "owner2"), { subActiveUntil: future, listed: true, verified: true })));

console.log("\nإنشاء الطلبات");
await seed();
await t("زبون جديد يطلب كاش 12,000", () => assertSucceeds(placeAs("cust", { strikes: 0, delivered: 0 })));
await seed();
await t("زبون جديد لا يطلب كاش فوق 50,000", () => assertFails(placeAs("cust", { strikes: 0, delivered: 0 }, { total: 60000 })));
await t("زبون جديد يطلب ببنكك فوق 50,000", () => assertSucceeds(placeAs("cust", { strikes: 0, delivered: 0 }, { total: 60000, payMethod: "bankak", bankakTxn: "999" })));
await seed();
await t("زبون قديم يطلب كاش فوق 50,000", () => assertSucceeds(placeAs("vet", { strikes: 0, delivered: 5 }, { total: 90000 })));
await t("صاحب إنذارين لا يطلب كاش", () => assertFails(placeAs("warned", { strikes: 2, delivered: 5 }, {}, "o2")));
await t("صاحب إنذارين يطلب ببنكك", () => assertSucceeds(placeAs("warned", { strikes: 2, delivered: 5 }, { payMethod: "bankak", bankakTxn: "1" }, "o3")));
await t("المحظور (3 إنذارات) لا يطلب", () => assertFails(placeAs("banned", { strikes: 3, delivered: 0 }, { payMethod: "bankak" }, "o4")));
await t("لا يخفي إنذاراته عن المطعم", () => assertFails(placeAs("warned", { strikes: 0, delivered: 5 }, { payMethod: "bankak" }, "o5")));
await t("لا يطلب من مطعم غير مفعّل", () => assertFails(placeAs("cust", { strikes: 0, delivered: 0 }, { restaurantId: "owner2" }, "o6")));
await t("لا ينشئ طلباً باسم زبون آخر", () => assertFails(setDoc(doc(db("cust"), "orders", "o7"), order("vet", { strikes: 0, delivered: 5 }))));
await t("لا يبدأ الطلب بحالة غير جديد", () => assertFails(placeAs("cust", { strikes: 0, delivered: 0 }, { status: "delivered" }, "o8")));
await env.withSecurityRulesDisabled(c => updateDoc(doc(c.firestore(), "restaurants", "owner"), { listed: false }));
await t("لا يطلب من مطعم أوقفه الأدمن", () => assertFails(placeAs("vet", { strikes: 0, delivered: 5 }, {}, "o9")));
await env.withSecurityRulesDisabled(c => updateDoc(doc(c.firestore(), "restaurants", "owner"), { listed: true, subActiveUntil: past }));
await t("لا يطلب من مطعم انتهى اشتراكه", () => assertFails(placeAs("vet", { strikes: 0, delivered: 5 }, {}, "o10")));

console.log("\nحظر الجهاز");
await seed();
await env.withSecurityRulesDisabled(c => setDoc(doc(c.firestore(), "bannedDevices", "dev-shared"), { uid: "banned", strikes: 3 }));
await env.withSecurityRulesDisabled(c => updateDoc(doc(c.firestore(), "users", "cust"), { deviceId: "dev-shared" }));
await t("حساب جديد على جهاز محظور لا يطلب", () => assertFails(placeAs("cust", { strikes: 0, delivered: 0 })));
await env.withSecurityRulesDisabled(c => updateDoc(doc(c.firestore(), "users", "cust"), { deviceId: "" }));
await t("لا طلب بدون تسجيل معرّف الجهاز", () => assertFails(placeAs("cust", { strikes: 0, delivered: 0 })));
await t("الزبون يسجّل معرّف جهازه", () => assertSucceeds(updateDoc(doc(db("cust"), "users", "cust"), { deviceId: "dev-new" })));
await t("بعدها يطلب عادياً", () => assertSucceeds(placeAs("cust", { strikes: 0, delivered: 0 })));
await t("الزبون لا يحظر أو يرفع حظر جهاز", () => assertFails(setDoc(doc(db("cust"), "bannedDevices", "x"), { uid: "cust" })));
await t("الأدمن يرفع الحظر", () => assertSucceeds(deleteDoc(doc(db("admin"), "bannedDevices", "dev-shared"))));

console.log("\nمراحل الطلب");
await seed();
await placeAs("cust", { strikes: 0, delivered: 0 });
await t("مطعم آخر لا يقرأ الطلب", () => assertFails(getDoc(doc(db("owner2"), "orders", "o1"))));
await t("المطعم يقرأ طلبه", () => assertSucceeds(getDoc(doc(db("owner"), "orders", "o1"))));
await t("المطعم لا يقفز من جديد إلى تم التسليم", () => assertFails(updateDoc(doc(db("owner"), "orders", "o1"), { status: "delivered" })));
await t("المطعم يقبل الطلب", () => assertSucceeds(updateDoc(doc(db("owner"), "orders", "o1"), { status: "accepted" })));
await t("الزبون لا يلغي بعد القبول", () => assertFails(updateDoc(doc(db("cust"), "orders", "o1"), { status: "cancelled" })));
await t("المطعم لا يغيّر مبلغ الطلب", () => assertFails(updateDoc(doc(db("owner"), "orders", "o1"), { total: 1 })));
await t("بدء التحضير", () => assertSucceeds(updateDoc(doc(db("owner"), "orders", "o1"), { status: "preparing" })));
await t("خرج للتوصيل بوقت الخادم", () => assertSucceeds(updateDoc(doc(db("owner"), "orders", "o1"), { status: "out_for_delivery", outAt: serverTimestamp() })));
await t("تم التسليم يزيد سجل الزبون", async () => {
  const s = db("owner"), b = writeBatch(s);
  b.update(doc(s, "orders", "o1"), { status: "delivered" });
  b.update(doc(s, "users", "cust"), { delivered: increment(1), lastDeliveredOrder: "o1" });
  await assertSucceeds(b.commit());
});
await t("لا يُزاد سجل الزبون مرة ثانية لنفس الطلب", async () => {
  const s = db("owner"), b = writeBatch(s);
  b.update(doc(s, "users", "cust"), { delivered: increment(1), lastDeliveredOrder: "o1" });
  await assertFails(b.commit());
});
await seed();
await placeAs("cust", { strikes: 0, delivered: 0 }, {}, "c1");
await t("الزبون يلغي طلباً جديداً", () => assertSucceeds(updateDoc(doc(db("cust"), "orders", "c1"), { status: "cancelled" })));

console.log("\nالبلاغات والإنذارات");
await seed();
await placeAs("cust", { strikes: 0, delivered: 0 });
const report = async (who, oid = "o1") => {
  const s = db(who), b = writeBatch(s);
  b.set(doc(s, "reports", oid), { restaurantId: who, customerId: "cust", reason: "no_answer", note: "", status: "open", createdAt: serverTimestamp() });
  b.update(doc(s, "orders", oid), { reported: true });
  b.update(doc(s, "users", "cust"), { strikes: increment(1), lastReportId: oid });
  return b.commit();
};
await t("لا بلاغ قبل خروج الطلب للتوصيل", () => assertFails(report("owner")));
await setOrder("o1", { status: "out_for_delivery" });
await t("مطعم آخر لا يبلّغ عن الطلب", () => assertFails(report("owner2")));
await t("المطعم يبلّغ: بلاغ + إنذار معاً", () => assertSucceeds(report("owner")));
await t("لا بلاغ ثانٍ لنفس الطلب", () => assertFails(report("owner")));
await t("لا إنذار بدون بلاغ", () => assertFails(updateDoc(doc(db("owner"), "users", "cust"), { strikes: increment(1), lastReportId: "zzz" })));
await t("الزبون يعترض مرة", () => assertSucceeds(updateDoc(doc(db("cust"), "reports", "o1"), { status: "disputed", dispute: "لم يتصل بي أحد" })));
await t("لا يعترض مرة ثانية", () => assertFails(updateDoc(doc(db("cust"), "reports", "o1"), { status: "disputed", dispute: "مرة أخرى" })));
await t("الأدمن يلغي البلاغ ويخصم الإنذار", async () => {
  const s = db("admin"), b = writeBatch(s);
  b.update(doc(s, "reports", "o1"), { status: "cancelled" });
  b.update(doc(s, "users", "cust"), { strikes: increment(-1) });
  await assertSucceeds(b.commit());
});

console.log("\nالتقييم");
await seed();
await placeAs("cust", { strikes: 0, delivered: 0 });
const rate = (who, oid, stars) => {
  const s = db(who), b = writeBatch(s);
  b.set(doc(s, "ratings", oid), { restaurantId: "owner", customerId: who, customerName: who, stars, comment: "ممتاز", createdAt: serverTimestamp() });
  b.update(doc(s, "restaurants", "owner"), { ratingSum: increment(stars), ratingCount: increment(1), lastRatingId: oid });
  return b.commit();
};
await t("لا تقييم قبل التسليم", () => assertFails(rate("cust", "o1", 5)));
await setOrder("o1", { status: "delivered" });
await t("زبون آخر لا يقيّم طلباً ليس له", () => assertFails(rate("vet", "o1", 5)));
await t("لا تقييم بـ 6 نجوم", () => assertFails(rate("cust", "o1", 6)));
await t("الزبون يقيّم طلبه المستلَم", () => assertSucceeds(rate("cust", "o1", 4)));
await t("لا تقييم ثانٍ لنفس الطلب", () => assertFails(rate("cust", "o1", 5)));
await t("التقييمات تُقرأ للجميع", () => assertSucceeds(getDocs(query(collection(anon(), "ratings"), where("restaurantId", "==", "owner")))));
await t("المتوسط محفوظ بشكل صحيح", async () => {
  await env.withSecurityRulesDisabled(async c => {
    const r = (await getDoc(doc(c.firestore(), "restaurants", "owner"))).data();
    if (r.ratingSum !== 4 || r.ratingCount !== 1) throw new Error(`ratingSum=${r.ratingSum} ratingCount=${r.ratingCount}`);
  });
});

console.log("\nالاشتراكات");
await seed();
await t("المطعم يرسل تحويل بنكك", () => assertSucceeds(setDoc(doc(db("owner2"), "payments", "p1"),
  { restaurantId: "owner2", txnId: "12345", amount: 10000, status: "pending", createdAt: serverTimestamp() })));
await t("لا يرسل تحويلاً مقبولاً مسبقاً", () => assertFails(setDoc(doc(db("owner2"), "payments", "p2"),
  { restaurantId: "owner2", txnId: "12345", amount: 10000, status: "approved", createdAt: serverTimestamp() })));
await t("لا يوافق على تحويله بنفسه", () => assertFails(updateDoc(doc(db("owner2"), "payments", "p1"), { status: "approved" })));
await t("الأدمن يستعرض التحويلات المعلّقة", () => assertSucceeds(getDocs(query(collection(db("admin"), "payments"), where("status", "==", "pending")))));
await t("الأدمن يوافق ويمدد الاشتراك", async () => {
  const s = db("admin"), b = writeBatch(s);
  b.update(doc(s, "payments", "p1"), { status: "approved" });
  b.update(doc(s, "restaurants", "owner2"), { subActiveUntil: future, listed: true });
  await assertSucceeds(b.commit());
});
await t("غير الأدمن لا يقرأ مجموعة الأدمن لغيره", () => assertFails(getDoc(doc(db("cust"), "admins", "admin"))));

console.log("\nالصور");
await seed();
const img = (o = {}) => ({ owner: "owner", data: "data:image/webp;base64,AAAA", createdAt: serverTimestamp(), ...o });
await t("صاحب المطعم يرفع صورة", () => assertSucceeds(setDoc(doc(db("owner"), "images", "i1"), img())));
await t("الصور تُقرأ للجميع", () => assertSucceeds(getDoc(doc(anon(), "images", "i1"))));
await t("لا يرفع صورة باسم غيره", () => assertFails(setDoc(doc(db("owner2"), "images", "i2"), img())));
await t("لا يرفع غير الصور", () => assertFails(setDoc(doc(db("owner"), "images", "i3"), img({ data: "data:text/html;base64,AAAA" }))));
await t("لا يرفع صورة أكبر من الحد", () => assertFails(setDoc(doc(db("owner"), "images", "i4"), img({ data: "data:image/webp;base64," + "A".repeat(210000) }))));
await t("غير صاحبها لا يحذفها", () => assertFails(deleteDoc(doc(db("owner2"), "images", "i1"))));
await t("صاحبها يحذفها", () => assertSucceeds(deleteDoc(doc(db("owner"), "images", "i1"))));

console.log("\nحذف الحساب");
await seed();
await t("الزبون يحذف حسابه", () => assertSucceeds(deleteDoc(doc(db("cust"), "users", "cust"))));
await t("لا يحذف حساب غيره", () => assertFails(deleteDoc(doc(db("cust"), "users", "vet"))));
await t("صاحب المطعم يحذف منيوه ومطعمه", async () => {
  await assertSucceeds(deleteDoc(doc(db("owner"), "restaurants", "owner", "menu", "m1")));
  await assertSucceeds(deleteDoc(doc(db("owner"), "restaurants", "owner")));
});
await t("لا يحذف مطعم غيره", () => assertFails(deleteDoc(doc(db("owner"), "restaurants", "owner2"))));

console.log("\nالدردشة");
await seed();
await placeAs("cust", { strikes: 0, delivered: 0 });
const msg = (who, role, extra = {}) => ({ from: who, role, text: "مرحباً", at: serverTimestamp(), notified: false, ...extra });
await t("الزبون يراسل المطعم على طلبه", () => assertSucceeds(setDoc(doc(db("cust"), "orders", "o1", "messages", "m1"), msg("cust", "customer"))));
await t("المطعم يرد على الزبون", () => assertSucceeds(setDoc(doc(db("owner"), "orders", "o1", "messages", "m2"), msg("owner", "restaurant"))));
await t("الطرفان يقرآن المحادثة", async () => {
  await assertSucceeds(getDocs(collection(db("cust"), "orders", "o1", "messages")));
  await assertSucceeds(getDocs(collection(db("owner"), "orders", "o1", "messages")));
});
await t("مطعم آخر لا يقرأ المحادثة", () => assertFails(getDocs(collection(db("owner2"), "orders", "o1", "messages"))));
await t("طرف ثالث لا يراسل على الطلب", () => assertFails(setDoc(doc(db("vet"), "orders", "o1", "messages", "m3"), msg("vet", "customer"))));
await t("لا ينتحل الزبون صفة المطعم", () => assertFails(setDoc(doc(db("cust"), "orders", "o1", "messages", "m4"), msg("cust", "restaurant"))));
await t("لا رسائل فارغة أو طويلة جداً", async () => {
  await assertFails(setDoc(doc(db("cust"), "orders", "o1", "messages", "m5"), msg("cust", "customer", { text: "" })));
  await assertFails(setDoc(doc(db("cust"), "orders", "o1", "messages", "m6"), msg("cust", "customer", { text: "ا".repeat(501) })));
});
await t("لا تعديل ولا حذف للرسائل", async () => {
  await assertFails(updateDoc(doc(db("cust"), "orders", "o1", "messages", "m1"), { text: "معدّل" }));
  await assertFails(deleteDoc(doc(db("cust"), "orders", "o1", "messages", "m1")));
});
await setOrder("o1", { status: "cancelled" });
await t("لا مراسلة على طلب ملغي", () => assertFails(setDoc(doc(db("cust"), "orders", "o1", "messages", "m7"), msg("cust", "customer"))));
const sup = (who, role, u) => { const s = db(who), b = writeBatch(s);
  b.set(doc(s, "support", u, "messages", "s" + Math.random()), msg(who, role));
  b.set(doc(s, "support", u), { name: "x", lastAt: serverTimestamp(), lastText: "مرحباً", lastFrom: role === "admin" ? "admin" : "user" }, { merge: true });
  return b.commit(); };
await t("المستخدم يراسل الدعم", () => assertSucceeds(sup("cust", "user", "cust")));
await t("الأدمن يرد على المستخدم", () => assertSucceeds(sup("admin", "admin", "cust")));
await t("مستخدم لا يقرأ محادثة دعم غيره", () => assertFails(getDocs(collection(db("vet"), "support", "cust", "messages"))));
await t("مستخدم لا يرد بصفة الأدمن", () => assertFails(sup("cust", "admin", "cust")));

console.log("\nالدردشة المباشرة");
await seed();
const dm = (who, role, cid, meta) => { const s = db(who), b = writeBatch(s);
  b.set(doc(s, "chats", cid, "messages", "d" + Math.random()), msg(who, role));
  b.set(doc(s, "chats", cid), { ...meta, lastAt: serverTimestamp(), lastText: "مرحباً", lastFrom: role }, { merge: true });
  return b.commit(); };
const META = { customerId: "cust", restaurantId: "owner", customerName: "cust", restaurantName: "owner" };
await t("الزبون يبدأ محادثة مع مطعم قبل الطلب", () => assertSucceeds(dm("cust", "customer", "owner_cust", META)));
await t("المطعم يرد", () => assertSucceeds(dm("owner", "restaurant", "owner_cust", META)));
await t("الطرفان يقرآن، وغيرهما لا", async () => {
  await assertSucceeds(getDocs(collection(db("cust"), "chats", "owner_cust", "messages")));
  await assertSucceeds(getDocs(collection(db("owner"), "chats", "owner_cust", "messages")));
  await assertFails(getDocs(collection(db("vet"), "chats", "owner_cust", "messages")));
});
await t("الزبون يستعرض محادثاته فقط", async () => {
  await assertSucceeds(getDocs(query(collection(db("cust"), "chats"), where("customerId", "==", "cust"))));
  await assertFails(getDocs(collection(db("cust"), "chats")));
});
await t("المطعم يستعرض محادثاته", () => assertSucceeds(getDocs(query(collection(db("owner"), "chats"), where("restaurantId", "==", "owner")))));
await t("لا يبدأ محادثة باسم زبون آخر", () => assertFails(dm("vet", "customer", "owner_cust2", { ...META, customerId: "cust" })));
await t("لا معرّف محادثة مزوّر", () => assertFails(dm("vet", "customer", "owner2_x", { ...META, customerId: "vet" })));
await t("مطعم آخر لا يكتب في المحادثة", () => assertFails(dm("owner2", "restaurant", "owner_cust", META)));

await env.cleanup();
console.log(`\n${pass} نجح، ${fail} فشل`);
process.exit(fail ? 1 : 0);
