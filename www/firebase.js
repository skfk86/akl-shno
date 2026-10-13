// أكل شنو؟ — تهيئة Firebase والعمليات الحساسة
// كل عملية هنا مكتوبة بالشكل الذي تقبله firestore.rules بالضبط.

import { initializeApp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";
import {
  getFirestore, doc, collection, getDoc, getDocs, query, where, orderBy,
  writeBatch, setDoc, updateDoc, increment, serverTimestamp, Timestamp
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

// ───────── الحساب ─────────
// ملاحظة: داخل Capacitor استخدم plugin تسجيل دخول Google الأصلي بدل signInWithPopup.
export async function createProfile({ role, name, phone }) {
  const uid = auth.currentUser.uid;
  await setDoc(doc(db, "users", uid), {
    role, name, phone, addresses: [],
    strikes: 0, delivered: 0,
    createdAt: serverTimestamp()
  });
}

// ───────── المطاعم الظاهرة للزبون ─────────
// الشرط where إلزامي، وإلا ترفض القواعد الاستعلام.
export async function listOpenRestaurants(city) {
  const q = query(
    collection(db, "restaurants"),
    where("subActiveUntil", ">", Timestamp.now()),
    where("city", "==", city)
  );
  return (await getDocs(q)).docs.map(d => ({ id: d.id, ...d.data() }));
}

// ───────── إنشاء طلب ─────────
export async function placeOrder(order) {
  const uid = auth.currentUser.uid;
  const me = (await getDoc(doc(db, "users", uid))).data();
  const ref = doc(collection(db, "orders"));
  await setDoc(ref, {
    ...order,                       // restaurantId, items, total, type, payMethod, location, landmark, zone
    customerId: uid,
    customerStrikes: me.strikes,    // يراها المطعم
    customerDelivered: me.delivered,
    status: "new",
    reported: false,
    createdAt: serverTimestamp()
  });
  return ref.id;
}

// ───────── المطعم: في الطريق ─────────
export function markOutForDelivery(orderId) {
  return updateDoc(doc(db, "orders", orderId), {
    status: "out_for_delivery",
    outAt: serverTimestamp()
  });
}

// ───────── المطعم: تم التسليم (+1 لسجل الزبون) ─────────
export async function markDelivered(orderId, customerId) {
  const b = writeBatch(db);
  b.update(doc(db, "orders", orderId), { status: "delivered" });
  b.update(doc(db, "users", customerId), {
    delivered: increment(1),
    lastDeliveredOrder: orderId
  });
  await b.commit();
}

// ───────── المطعم: بلاغ عدم استلام (+1 إنذار) ─────────
// الثلاث كتابات معاً أو لا شيء.
export async function reportNoShow(orderId, customerId, reason, note = "") {
  const b = writeBatch(db);
  b.set(doc(db, "reports", orderId), {
    restaurantId: auth.currentUser.uid,
    customerId, reason, note,
    status: "open",
    createdAt: serverTimestamp()
  });
  b.update(doc(db, "orders", orderId), { reported: true });
  b.update(doc(db, "users", customerId), {
    strikes: increment(1),
    lastReportId: orderId
  });
  await b.commit();
}

// ───────── الزبون: اعتراض على بلاغ ─────────
export function disputeReport(orderId, text) {
  return updateDoc(doc(db, "reports", orderId), {
    status: "disputed",
    dispute: text.slice(0, 300)
  });
}

// ───────── المطعم: إرسال تحويل بنكك ─────────
export function submitPayment({ txnId, amount, receiptUrl }) {
  return setDoc(doc(collection(db, "payments")), {
    restaurantId: auth.currentUser.uid,
    txnId, amount, receiptUrl,
    status: "pending",
    createdAt: serverTimestamp()
  });
}
