// أكل شنو؟ — المراجعة التلقائية لطلبات المطاعم
// تعمل داخل GitHub Actions مع notify.mjs. ثلاث نتائج ممكنة:
//   approve  ← كل الفحوصات نجحت والذكاء الاصطناعي واثق أن الصورة واجهة مطعم حقيقية باسمه
//   reject   ← مشكلة واضحة (رقم/صورة مكررة، جهاز محظور، موقع خارج السودان، لقطة شاشة أو تصميم)
//   manual   ← حالة غير محسومة: تبقى للأدمن مع تقرير الفحص
// الذكاء الاصطناعي: Cloudflare Workers AI أو Gemini (مجاني بمفتاح في أسرار GitHub). بدونه يعمل الفحص بالقواعد فقط.

import { createHash } from "node:crypto";

// ───── الذكاء الاصطناعي: وصف الصور وإرجاع JSON ─────
const PROMPT = (r, hasLicense) => `You verify restaurant sign-ups for a food delivery app in Sudan.
Restaurant name (Arabic): "${r.name}". Category: "${r.category}". City: "${r.city}".
Image 1 should be a REAL photo taken by a phone of the restaurant's storefront (outside), ideally with its sign.
${hasLicense ? "Image 2 should be a photo of a business license or health certificate document." : ""}
Be strict about fakes: screenshots, app UIs, posters, infographics, designed graphics, memes, stock/marketing images, text-only images, or photos of a screen are NOT acceptable storefront photos.
Answer ONLY with JSON:
{"real_photo":bool,"is_storefront":bool,"screenshot_or_graphic":bool,"sign_visible":bool,"sign_text":"text read on the sign or empty","name_match":"yes|partial|no|unknown","license_is_document":${hasLicense ? "bool" : "null"},"confidence":0..1,"reason_ar":"one short Arabic sentence explaining your judgement"}`;

// مزوّدو الذكاء الاصطناعي المجانيون، يُستخدم أول مزوّد مفاتيحه موجودة في أسرار GitHub:
//   Cloudflare Workers AI: CF_ACCOUNT_ID + CF_API_TOKEN   (حساب مجاني بلا بطاقة، 10 آلاف وحدة يومياً)
//   Google Gemini:         GEMINI_API_KEY
//   أي خدمة متوافقة مع OpenAI: AI_URL + AI_KEY + AI_MODEL
// (GitHub Models أُوقفت نهائياً في 30 يوليو 2026)
const parseJSON = txt => { const m = String(txt || "").match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; };

async function openaiCompat(url, key, model, prompt, images) {
  const res = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, temperature: 0, max_tokens: 400,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }, ...images.map(u => ({ type: "image_url", image_url: { url: u } }))] }] })
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${raw.slice(0, 160)}`);
  return parseJSON(JSON.parse(raw).choices?.[0]?.message?.content);
}

const CF_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
async function cloudflare(prompt, images) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/ai/run/${CF_MODEL}`;
  const call = body => fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${process.env.CF_API_TOKEN}` }, body: JSON.stringify(body) });
  // النموذج يقبل صورة واحدة في كل طلب: نفحص الواجهة (والرخصة تُذكر في النص فقط)
  const body = { messages: [{ role: "user", content: prompt }], image: images[0], max_tokens: 400, temperature: 0 };
  let res = await call(body), raw = await res.text();
  if (!res.ok && /agree|licen/i.test(raw)) { await call({ prompt: "agree" }); res = await call(body); raw = await res.text(); }  // قبول ترخيص Meta أول مرة
  if (!res.ok) throw new Error(`HTTP ${res.status} ${raw.slice(0, 160)}`);
  const out = JSON.parse(raw).result;
  return parseJSON(typeof out === "string" ? out : out?.response);
}

export function aiProvider() {
  const e = process.env;
  if (e.CF_ACCOUNT_ID && e.CF_API_TOKEN) return "cloudflare";
  if (e.GEMINI_API_KEY) return "gemini";
  if (e.AI_URL && e.AI_KEY && e.AI_MODEL) return "custom";
  return null;
}

async function askAI(r, images) {
  const p = aiProvider(), e = process.env;
  if (!p || !images.length) return null;
  const prompt = PROMPT(r, p !== "cloudflare" && images.length > 1);
  try {
    const out = p === "cloudflare" ? await cloudflare(prompt, images)
      : p === "gemini" ? await openaiCompat("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", e.GEMINI_API_KEY, "gemini-2.5-flash", prompt, images)
      : await openaiCompat(e.AI_URL, e.AI_KEY, e.AI_MODEL, prompt, images);
    if (!out) { console.log(`  ai ${p}: no JSON in answer`); return null; }
    return { ...out, model: p };
  } catch (x) { console.log(`  ai ${p}: ${x.message}`); return null; }
}

// ───── مراجعة مطعم واحد ─────
export async function reviewRestaurant(db, doc) {
  const r = doc.data(), p = r.proofs || {}, checks = [];
  const add = (ok, label, hard = false) => { checks.push({ ok, label, hard }); return ok; };

  // صور الإثبات
  const imgs = {};
  for (const k of ["sign", "license"]) if (p[k]) imgs[k] = (await db.doc(`images/${p[k]}`).get()).get("data") || null;
  add(!!imgs.sign, imgs.sign ? "صورة الواجهة مرفوعة" : "صورة الواجهة مفقودة", true);
  const hashes = Object.fromEntries(Object.entries(imgs).filter(([, v]) => v).map(([k, v]) => [k, sha(v)]));

  // الموقع داخل السودان
  const inSudan = typeof r.lat === "number" && r.lat > SUDAN.minLat && r.lat < SUDAN.maxLat && r.lng > SUDAN.minLng && r.lng < SUDAN.maxLng;
  add(inSudan, inSudan ? "الموقع داخل السودان" : "الموقع غير محدد أو خارج السودان", true);

  // تكرار الرقم أو الاسم أو الصورة مع مطاعم أخرى
  const others = (await db.collection("restaurants").get()).docs.filter(d => d.id !== doc.id).map(d => d.data());
  const ph = digits(r.phone);
  const phoneDup = ph.length >= 9 && others.some(o => digits(o.phone) === ph);
  add(/^(9|1)\d{8}$/.test(ph), /^(9|1)\d{8}$/.test(ph) ? "رقم هاتف سوداني صحيح" : "رقم الهاتف غير صحيح");
  add(!phoneDup, phoneDup ? "رقم الهاتف مستخدم في مطعم آخر" : "رقم الهاتف غير مكرر", true);
  const nameDup = others.some(o => norm(o.name) === norm(r.name) && o.city === r.city);
  add(!nameDup, nameDup ? "يوجد مطعم بنفس الاسم في نفس المدينة" : "الاسم غير مكرر في المدينة");
  // سجل دائم لبصمات الصور: يكشف إعادة استخدام الصورة حتى لو حُذف المطعم القديم وسُجّل من جديد
  let imgDup = false;
  for (const h of Object.values(hashes)) { const x = await db.doc(`proofHashes/${h}`).get(); if (x.exists && x.get("rid") !== doc.id) imgDup = true; }
  add(!imgDup, imgDup ? "الصورة مستخدمة في طلب مطعم آخر" : "الصورة غير مستخدمة من قبل", true);

  // الجهاز
  const dev = (await db.doc(`users/${doc.id}`).get()).get("deviceId");
  const banned = dev ? (await db.doc(`bannedDevices/${dev}`).get()).exists : false;
  add(!banned, banned ? "جهاز صاحب المطعم محظور" : "الجهاز غير محظور", true);

  // الذكاء الاصطناعي
  const ai = imgs.sign ? await askAI(r, [imgs.sign, imgs.license].filter(Boolean)) : null;
  if (ai) {
    add(!!ai.real_photo && !ai.screenshot_or_graphic, ai.screenshot_or_graphic ? "الصورة لقطة شاشة أو تصميم وليست صورة حقيقية" : ai.real_photo ? "صورة حقيقية ملتقطة بالكاميرا" : "الصورة لا تبدو حقيقية");
    add(!!ai.is_storefront, ai.is_storefront ? "تظهر واجهة مطعم" : "لا تظهر واجهة مطعم");
    add(!!ai.sign_visible, ai.sign_visible ? `اللافتة ظاهرة${ai.sign_text ? `: «${String(ai.sign_text).slice(0, 40)}»` : ""}` : "اللافتة غير ظاهرة");
    add(["yes", "partial"].includes(ai.name_match), ai.name_match === "yes" ? "الاسم على اللافتة يطابق اسم المطعم" : ai.name_match === "partial" ? "الاسم على اللافتة يطابق جزئياً" : "الاسم على اللافتة لا يطابق أو غير مقروء");
    if (imgs.license && typeof ai.license_is_document === "boolean") add(ai.license_is_document, ai.license_is_document ? "صورة الرخصة وثيقة حقيقية" : "صورة الرخصة لا تبدو وثيقة");
  }

  // القرار
  const conf = Number(ai?.confidence) || 0;
  const hardFail = checks.find(c => c.hard && !c.ok);
  let decision = "manual", reason = "";
  if (hardFail) { decision = "reject"; reason = hardFail.label; }
  else if (ai && ai.screenshot_or_graphic && conf >= 0.7) { decision = "reject"; reason = "صورة الواجهة لقطة شاشة أو تصميم. التقط صورة حقيقية لواجهة مطعمك بالكاميرا"; }
  else if (ai && !ai.is_storefront && conf >= 0.85) { decision = "reject"; reason = "الصورة لا تُظهر واجهة مطعم. التقط صورة لواجهة المطعم من الخارج تظهر فيها اللافتة"; }
  else if (ai && checks.every(c => c.ok) && conf >= 0.75) decision = "approve";
  if (!ai && !hardFail) reason = "تعذر فحص الصورة آلياً، تحتاج مراجعة يدوية";

  return {
    decision, reason, hashes,
    report: { key: r.reviewAt?.toMillis?.() || 0, at: new Date().toISOString(), decision, reason, confidence: conf,
      checks: checks.map(({ ok, label }) => ({ ok, label })), ai: ai ? { model: ai.model, note: String(ai.reason_ar || "").slice(0, 200), sign: String(ai.sign_text || "").slice(0, 60) } : null }
  };
}
