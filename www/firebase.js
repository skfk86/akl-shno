// أكل شنو؟ — تهيئة Firebase وكل عمليات البيانات
// كل عملية هنا مكتوبة بالشكل الذي تقبله firestore.rules بالضبط.

import { initializeApp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithCredential, onAuthStateChanged, signOut, deleteUser
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";
import {
  getFirestore, doc, collection, getDoc, getDocs, query, where, orderBy, limit,
  writeBatch, setDoc, updateDoc, deleteDoc, addDoc, onSnapshot,
  increment, serverTimestamp, Timestamp
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyC9v9eNURyltMNYlEOIOmDE-tnI6pdS48k",
  authDomain: "whate-eate.firebaseapp.com",
  projectId: "whate-eate",
  storageBucket: "whate-eate.firebasestorage.app",
  messagingSenderId: "726536956200",
  appId: "1:726536956200:web:0884010216719915bec81d"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

const uid = () => auth.currentUser.uid;
const DAY = 24 * 60 * 60 * 1000;
const list = snap => snap.docs.map(d => ({ id: d.id, ...d.data() }));

// ═════════ الحساب ═════════
// دخول Google الأصلي عبر @capacitor-firebase/authentication،
// ثم تمرير الـ idToken إلى JS SDK حتى تعمل قواعد Firestore.
export async function signInGoogle() {
  const FA = window.Capacitor?.Plugins?.FirebaseAuthentication;
  if (!FA) throw new Error("NATIVE_ONLY");
  const r = await FA.signInWithGoogle();
  const cred = GoogleAuthProvider.credential(r.credential.idToken);
  return signInWithCredential(auth, cred);
}

export async function logout() {
  try { await window.Capacitor?.Plugins?.FirebaseAuthentication?.signOut(); } catch {}
  await signOut(auth);
}

export function watchAuth(cb) { return onAuthStateChanged(auth, cb); }

export async function getProfile() {
  const s = await getDoc(doc(db, "users", uid()));
  return s.exists() ? s.data() : null;
}

export async function isAdminUser() {
  try { return (await getDoc(doc(db, "admins", uid()))).exists(); }
  catch { return false; }
}

export async function createProfile({ role, name, phone }) {
  await setDoc(doc(db, "users", uid()), {
    role, name, phone, addresses: [],
    strikes: 0, delivered: 0,
    createdAt: serverTimestamp()
  });
}

// ═════════ المطاعم ═════════
export async function createRestaurant({ name, category, city, district, phone }) {
  await setDoc(doc(db, "restaurants", uid()), {
    ownerId: uid(), name, category, city, district, phone,
    isOpen: false, delivery: true, pickup: true, bankak: "",
    subActiveUntil: null, freeTrial: false, listed: false,
    createdAt: serverTimestamp()
  });
}

// الشرط where('listed') إلزامي، وإلا ترفض القواعد الاستعلام.
// المنتهي اشتراكه يُخفى هنا؛ ولا يستطيع استقبال طلبات أصلاً بحكم القواعد.
export async function listOpenRestaurants(city) {
  const q = query(collection(db, "restaurants"), where("listed", "==", true));
  const now = Date.now();
  const all = list(await getDocs(q)).filter(r => r.subActiveUntil && r.subActiveUntil.toMillis() > now);
  return city ? all.filter(r => r.city === city) : all;
}

export async function getRestaurant(id) {
  const s = await getDoc(doc(db, "restaurants", id));
  return s.exists() ? { id: s.id, ...s.data() } : null;
}

export const getMyRestaurant = () => getRestaurant(uid());
export const updateMyRestaurant = data => updateDoc(doc(db, "restaurants", uid()), data);

// المنيو والعروض ومناطق التوصيل: sub = 'menu' | 'offers' | 'zones'
export async function listSub(rid, sub) {
  return list(await getDocs(collection(db, "restaurants", rid, sub)));
}
export const addSub = (sub, data) => addDoc(collection(db, "restaurants", uid(), sub), data);
export const updateSub = (sub, id, data) => updateDoc(doc(db, "restaurants", uid(), sub, id), data);
export const deleteSub = (sub, id) => deleteDoc(doc(db, "restaurants", uid(), sub, id));

// ═════════ الطلبات ═════════
export async function placeOrder(order) {
  const me = await getProfile();
  const ref = doc(collection(db, "orders"));
  await setDoc(ref, {
    ...order,
    customerId: uid(),
    customerName: me.name,
    customerPhone: me.phone,
    customerStrikes: me.strikes,    // يراها المطعم، والقواعد تتحقق من صحتها
    customerDelivered: me.delivered,
    status: "new",
    reported: false,
    createdAt: serverTimestamp()
  });
  return ref.id;
}

const byNewest = arr => arr.sort((a, b) => (b.createdAt?.seconds ?? 9e9) - (a.createdAt?.seconds ?? 9e9));

export function watchMyOrders(cb) {
  const q = query(collection(db, "orders"), where("customerId", "==", uid()));
  return onSnapshot(q, s => cb(byNewest(list(s))));
}

export function watchRestaurantOrders(cb) {
  const q = query(collection(db, "orders"), where("restaurantId", "==", uid()));
  return onSnapshot(q, s => cb(byNewest(list(s))));
}

export function watchOrder(id, cb) {
  return onSnapshot(doc(db, "orders", id), s => cb({ id: s.id, ...s.data() }));
}

export const setOrderStatus = (id, status) => updateDoc(doc(db, "orders", id), { status });

export function markOutForDelivery(orderId) {
  return updateDoc(doc(db, "orders", orderId), { status: "out_for_delivery", outAt: serverTimestamp() });
}

// تم التسليم (+1 لسجل الزبون)
export async function markDelivered(orderId, customerId) {
  const b = writeBatch(db);
  b.update(doc(db, "orders", orderId), { status: "delivered" });
  b.update(doc(db, "users", customerId), { delivered: increment(1), lastDeliveredOrder: orderId });
  await b.commit();
}

// طلبات الزبون النشطة (لفرض طلب واحد نشط على الحساب الجديد)
export async function myActiveOrders() {
  const q = query(collection(db, "orders"), where("customerId", "==", uid()));
  return list(await getDocs(q)).filter(o => ["new", "accepted", "preparing", "ready", "out_for_delivery"].includes(o.status));
}

export const updateProfile = ({ name, phone }) => updateDoc(doc(db, "users", uid()), { name, phone });
// رمز الإشعارات للهاتف الحالي (يُقرأ من سكربت GitHub Actions لإرسال الإشعارات)
export const saveFcmToken = token => updateDoc(doc(db, "users", uid()), { fcmToken: token });
// معرّف الجهاز: يُستخدم لمنع المحظور من فتح حساب جديد على نفس الهاتف
export const saveDeviceId = id => updateDoc(doc(db, "users", uid()), { deviceId: id });
export async function isDeviceBanned(id) {
  try { return (await getDoc(doc(db, "bannedDevices", id))).exists(); } catch { return false; }
}
export async function adminListBanned() {
  return list(await getDocs(collection(db, "bannedDevices")));
}
export const adminUnbanDevice = async b => {
  const batch = writeBatch(db);
  batch.delete(doc(db, "bannedDevices", b.id));
  if (b.uid) batch.update(doc(db, "users", b.uid), { strikes: 0 });
  await batch.commit();
};
// حذف الحساب نهائياً: الملف الشخصي، والمطعم بمنيوه وصوره إن وُجد، ثم حساب الدخول.
// سجلات الطلبات السابقة تبقى لدى المطاعم لأغراض المحاسبة (مذكور في سياسة الخصوصية).
export async function deleteMyAccount(role) {
  const id = uid();
  const delImg = img => img ? deleteDoc(doc(db, "images", img)).catch(() => {}) : null;
  if (role === "owner") {
    for (const sub of ["menu", "offers", "zones"]) {
      for (const d of (await getDocs(collection(db, "restaurants", id, sub))).docs) {
        await delImg(d.data().image); await deleteDoc(d.ref);
      }
    }
    const r = await getDoc(doc(db, "restaurants", id));
    if (r.exists()) { await delImg(r.data().image); await deleteDoc(r.ref); }
  }
  await deleteDoc(doc(db, "users", id));
  try { await deleteUser(auth.currentUser); }
  catch (e) {
    if (e.code !== "auth/requires-recent-login") throw e;
    await signInGoogle(); await deleteUser(auth.currentUser);
  }
  try { await window.Capacitor?.Plugins?.FirebaseAuthentication?.signOut(); } catch {}
}

// ═════════ الدردشة ═════════
// thread: { kind: "order", id: orderId } أو { kind: "support", id: userId }
const msgCol = t => t.kind === "order" ? collection(db, "orders", t.id, "messages") : collection(db, "support", t.id, "messages");
export function watchMessages(t, cb, onErr) {
  return onSnapshot(query(msgCol(t), orderBy("at"), limit(300)), s => cb(list(s)), onErr);
}
export function watchLastMessage(t, cb) {
  return onSnapshot(query(msgCol(t), orderBy("at", "desc"), limit(1)), s => cb(s.docs[0] ? { id: s.docs[0].id, ...s.docs[0].data() } : null), () => {});
}
export async function sendMessage(t, role, text, name = "") {
  const b = writeBatch(db);
  b.set(doc(msgCol(t)), { from: uid(), role, text, at: serverTimestamp(), notified: false });
  if (t.kind === "support") {
    b.set(doc(db, "support", t.id), { name, lastAt: serverTimestamp(), lastText: text.slice(0, 120), lastFrom: role === "admin" ? "admin" : "user" }, { merge: true });
  }
  await b.commit();
}
export async function adminListSupport() {
  return list(await getDocs(query(collection(db, "support"), orderBy("lastAt", "desc"), limit(100))));
}

export const saveAddresses = addresses => updateDoc(doc(db, "users", uid()), { addresses });

// ═════════ الصور ═════════
// تُخزن مضغوطة (أقل من 140KB) في مجموعة images، ويُحفظ معرّفها في المطعم أو الصنف.
export async function uploadImage(dataUrl) {
  const ref = await addDoc(collection(db, "images"), { owner: uid(), data: dataUrl, createdAt: serverTimestamp() });
  return ref.id;
}
// الصورة لا تتغير بعد رفعها (التعديل يُنشئ معرّفاً جديداً)، فتُحفظ على الهاتف وتُقرأ مرة واحدة فقط.
const idb = new Promise(res => {
  try {
    const r = indexedDB.open("akl-cache", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("img");
    r.onsuccess = () => res(r.result); r.onerror = () => res(null);
  } catch { res(null); }
});
const idbGet = async k => { const d = await idb; if (!d) return null;
  return new Promise(r => { try { const q = d.transaction("img").objectStore("img").get(k); q.onsuccess = () => r(q.result || null); q.onerror = () => r(null); } catch { r(null); } }); };
const idbSet = async (k, v) => { const d = await idb; if (!d) return;
  try { d.transaction("img", "readwrite").objectStore("img").put(v, k); } catch {} };
export async function getImage(id) {
  const cached = await idbGet(id);
  if (cached) return cached;
  const s = await getDoc(doc(db, "images", id));
  const data = s.exists() ? s.data().data : null;
  if (data) idbSet(id, data);
  return data;
}
export const deleteImage = id => deleteDoc(doc(db, "images", id));

// ═════════ التقييم ═════════
export async function rateOrder(o, stars, comment, name) {
  const b = writeBatch(db);
  b.set(doc(db, "ratings", o.id), {
    restaurantId: o.restaurantId, customerId: uid(), customerName: name,
    stars, comment, createdAt: serverTimestamp()
  });
  b.update(doc(db, "restaurants", o.restaurantId), {
    ratingSum: increment(stars), ratingCount: increment(1), lastRatingId: o.id
  });
  await b.commit();
}

export async function getRating(orderId) {
  const s = await getDoc(doc(db, "ratings", orderId));
  return s.exists() ? s.data() : null;
}

export async function listRatings(rid) {
  const q = query(collection(db, "ratings"), where("restaurantId", "==", rid));
  return list(await getDocs(q)).sort((a, b) => (b.createdAt?.seconds ?? 0) - (a.createdAt?.seconds ?? 0));
}

// ═════════ البلاغات ═════════
// بلاغ عدم استلام (+1 إنذار): الثلاث كتابات معاً أو لا شيء.
export async function reportNoShow(orderId, customerId, reason, note = "") {
  const b = writeBatch(db);
  b.set(doc(db, "reports", orderId), {
    restaurantId: uid(), customerId, reason, note,
    status: "open", createdAt: serverTimestamp()
  });
  b.update(doc(db, "orders", orderId), { reported: true });
  b.update(doc(db, "users", customerId), { strikes: increment(1), lastReportId: orderId });
  await b.commit();
}

export async function getReport(orderId) {
  const s = await getDoc(doc(db, "reports", orderId));
  return s.exists() ? { id: s.id, ...s.data() } : null;
}

export function disputeReport(orderId, text) {
  return updateDoc(doc(db, "reports", orderId), { status: "disputed", dispute: text.slice(0, 300) });
}

// ═════════ الاشتراك ═════════
export function submitPayment({ txnId, amount }) {
  return addDoc(collection(db, "payments"), {
    restaurantId: uid(), txnId, amount,
    status: "pending", createdAt: serverTimestamp()
  });
}

// ═════════ الأدمن ═════════
export async function adminListRestaurants() {
  return list(await getDocs(collection(db, "restaurants")));
}

// يمدّ الاشتراك من تاريخ انتهائه الحالي إن كان سارياً، وإلا من اليوم
function extend(current, days) {
  const base = current && current.toMillis() > Date.now() ? current.toMillis() : Date.now();
  return Timestamp.fromMillis(base + days * DAY);
}

export function adminActivateTrial(r, days = 60) {
  return updateDoc(doc(db, "restaurants", r.id), {
    subActiveUntil: extend(r.subActiveUntil, days), freeTrial: true, listed: true
  });
}

// الإيقاف يخفي المطعم من القائمة؛ ويمنع الطلبات الجديدة أيضاً عبر شرط listed في القواعد.
export const adminSetVerified = (rid, verified) => updateDoc(doc(db, "restaurants", rid), { verified });
export const adminSetListed = (rid, listed) => updateDoc(doc(db, "restaurants", rid), { listed });

export async function adminListPayments() {
  return list(await getDocs(query(collection(db, "payments"), where("status", "==", "pending"))));
}

export async function adminApprovePayment(p, restaurant, days = 30) {
  const b = writeBatch(db);
  b.update(doc(db, "payments", p.id), { status: "approved" });
  b.update(doc(db, "restaurants", p.restaurantId), {
    subActiveUntil: extend(restaurant?.subActiveUntil, days), listed: true
  });
  await b.commit();
}

export const adminRejectPayment = p => updateDoc(doc(db, "payments", p.id), { status: "rejected" });

export async function adminListDisputes() {
  return list(await getDocs(query(collection(db, "reports"), where("status", "==", "disputed"))));
}

// تثبيت الإنذار، أو إلغاؤه مع خصم الإنذار من الزبون
export async function adminResolveReport(r, uphold) {
  if (uphold) return updateDoc(doc(db, "reports", r.id), { status: "upheld" });
  const b = writeBatch(db);
  b.update(doc(db, "reports", r.id), { status: "cancelled" });
  b.update(doc(db, "users", r.customerId), { strikes: increment(-1) });
  await b.commit();
}
