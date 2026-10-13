// أكل شنو؟ — تهيئة Firebase وكل عمليات البيانات
// كل عملية هنا مكتوبة بالشكل الذي تقبله firestore.rules بالضبط.

import { initializeApp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithCredential, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";
import {
  getFirestore, doc, collection, getDoc, getDocs, query, where,
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
