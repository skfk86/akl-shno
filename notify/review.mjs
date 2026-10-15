// أكل شنو؟ — المراجعة التلقائية لطلبات المطاعم
// تعمل داخل GitHub Actions مع notify.mjs. ثلاث نتائج ممكنة:
//   approve  ← كل الفحوصات نجحت والذكاء الاصطناعي واثق أن الصورة واجهة مطعم حقيقية باسمه
//   reject   ← مشكلة واضحة (رقم/صورة مكررة، جهاز محظور، موقع خارج السودان، لقطة شاشة أو تصميم)
//   manual   ← حالة غير محسومة: تبقى للأدمن مع تقرير الفحص
// الذكاء الاصطناعي: GitHub Models (مجاني مع GITHUB_TOKEN)، ولا يحتاج أي حساب أو بطاقة.

import { createHash } from "node:crypto";

const MODELS = ["openai/gpt-4.1-mini", "openai/gpt-4o-mini"];
const ENDPOINT = "https://models.github.ai/inference/chat/completions";
const SUDAN = { minLat: 8.6, maxLat: 22.3, minLng: 21.8, maxLng: 38.7 };

const norm = s => String(s || "").toLowerCase()
  .replace(/[ً-ْـ]/g, "").replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي")
  .replace(/^(مطعم|كافتيريا|كافيه|شواية|بوفيه)\s+/, "").replace(/\s+/g, " ").trim();
const digits = p => String(p || "").replace(/\D/g, "").replace(/^0+/, "").replace(/^249/, "");
export const sha = s => createHash("sha256").update(String(s)).digest("hex").slice(0, 32);

// ───── الذكاء الاصطناعي: وصف الصور وإرجاع JSON ─────
const PROMPT = (r, hasLicense) => `You verify restaurant sign-ups for a food delivery app in Sudan.
Restaurant name (Arabic): "${r.name}". Category: "${r.category}". City: "${r.city}".
Image 1 should be a REAL photo taken by a phone of the restaurant's storefront (outside), ideally with its sign.
${hasLicense ? "Image 2 should be a photo of a business license or health certificate document." : ""}
Be strict about fakes: screenshots, app UIs, posters, infographics, designed graphics, memes, stock/marketing images, text-only images, or photos of a screen are NOT acceptable storefront photos.
Answer ONLY with JSON:
{"real_photo":bool,"is_storefront":bool,"screenshot_or_graphic":bool,"sign_visible":bool,"sign_text":"text read on the sign or empty","name_match":"yes|partial|no|unknown","license_is_document":${hasLicense ? "bool" : "null"},"confidence":0..1,"reason_ar":"one short Arabic sentence explaining your judgement"}`;

async function askAI(r, images) {
  const token = process.env.GITHUB_TOKEN;
  if (!token || !images.length) return null;
  const content = [{ type: "text", text: PROMPT(r, images.length > 1) },
    ...images.map(url => ({ type: "image_url", image_url: { url, detail: "low" } }))];
  for (const model of MODELS) {
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ model, temperature: 0, max_tokens: 400, response_format: { type: "json_object" },
          messages: [{ role: "user", content }] })
      });
      const raw = await res.text();
      if (!res.ok) { console.log(`  ai ${model}: HTTP ${res.status} ${raw.slice(0, 200).replace(/\s+/g, " ")}`); continue; }
      let txt;
      try { txt = JSON.parse(raw).choices?.[0]?.message?.content || ""; }
      catch { console.log(`  ai ${model}: non-JSON response (${res.headers.get("content-type")}): ${raw.slice(0, 200).replace(/\s+/g, " ")}`); continue; }
      const m = txt.match(/\{[\s\S]*\}/);   // بعض النماذج تحيط JSON بنص أو ```json
      if (!m) { console.log(`  ai ${model}: no JSON in answer: ${txt.slice(0, 160)}`); continue; }
      return { ...JSON.parse(m[0]), model };
    } catch (e) { console.log(`  ai ${model}: ${e.message}`); }
  }
  return null;
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
    if (imgs.license) add(ai.license_is_document !== false, ai.license_is_document ? "صورة الرخصة وثيقة حقيقية" : "صورة الرخصة لا تبدو وثيقة");
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
