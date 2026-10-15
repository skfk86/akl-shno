// أكل شنو؟ — المراجعة التلقائية لطلبات المطاعم
// تعمل داخل GitHub Actions مع notify.mjs. ثلاث نتائج ممكنة:
//   approve  ← كل الفحوصات نجحت والذكاء الاصطناعي واثق أن الصورة واجهة مطعم حقيقية باسمه
//   reject   ← مشكلة واضحة (رقم/صورة مكررة، جهاز محظور، موقع خارج السودان، لقطة شاشة أو تصميم)
//   manual   ← حالة غير محسومة: تبقى للأدمن مع تقرير الفحص
// الفحص بالطريقة العادية بدون ذكاء اصطناعي: بيانات الكاميرا (EXIF) + تحليل البكسلات + القواعد.

import { createHash } from "node:crypto";
import sharp from "sharp";

// نفس خوارزمية الهاتف (pixelStats في index.html) بحجم العمل: الضلع الأطول 1100 بكسل
export async function imageStats(dataUrl) {
  const buf = Buffer.from(String(dataUrl).split(",")[1] || "", "base64");
  const { data: d, info } = await sharp(buf).resize(1100, 1100, { fit: "inside", withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;
  let flat = 0, total = 0, lum = 0;
  const colors = new Set();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if ((x & 3) === 0 && (y & 3) === 0) colors.add((d[i] >> 3) << 10 | (d[i + 1] >> 3) << 5 | d[i + 2] >> 3);
    lum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    if (x < w - 1 && y < h - 1) {
      const r = i + 4, b = i + w * 4;
      if (Math.max(Math.abs(d[i] - d[r]), Math.abs(d[i + 1] - d[r + 1]), Math.abs(d[i + 2] - d[r + 2])) <= 1 &&
          Math.max(Math.abs(d[i] - d[b]), Math.abs(d[i + 1] - d[b + 1]), Math.abs(d[i + 2] - d[b + 2])) <= 1) flat++;
      total++;
    }
  }
  return { flat: +(flat / total).toFixed(3), colors: colors.size, lum: Math.round(lum / (w * h)) };
}

const SUDAN = { minLat: 8.6, maxLat: 22.3, minLng: 21.8, maxLng: 38.7 };
const norm = s => String(s || "").toLowerCase()
  .replace(/[\u064B-\u0652\u0640]/g, "").replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي")
  .replace(/^(مطعم|كافتيريا|كافيه|شواية|بوفيه)\s+/, "").replace(/\s+/g, " ").trim();
const digits = p => String(p || "").replace(/\D/g, "").replace(/^0+/, "").replace(/^249/, "");
export const sha = s => createHash("sha256").update(String(s)).digest("hex").slice(0, 32);

// ───── الذكاء الاصطناعي: وصف الصور وإرجاع JSON ─────
// لا نعطي النموذج اسم المطعم: يقرأ اللافتة دون تلقين، ونقارن نحن الاسمين (النماذج الصغيرة تردد ما يُقال لها).
const PROMPT = (r, hasLicense) => `Look carefully at image 1 and describe ONLY what you actually see. Do not guess.
${hasLicense ? "Image 2 may be a business document.\n" : ""}Return ONLY this JSON:
{"description":"2-3 sentences describing the image objectively: colors, objects, people, text, background",
 "photo_type":"camera_photo | screenshot | graphic_or_illustration | photo_of_screen | other",
 "scene":"restaurant_storefront | building_exterior | interior | food | document | poster_or_ad | abstract | other",
 "sign_visible":true or false,
 "sign_text":"exact text written on the shop sign, transcribed character by character in its original language; empty string if no sign or unreadable",
 ${hasLicense ? '"license_is_document":true or false,' : ""}
 "confidence":number between 0 and 1}
Rules: a "camera_photo" has real-world perspective, natural lighting, depth and noise. Flat colored shapes, posters, infographics, app screens, memes and designed images are "graphic_or_illustration" or "screenshot". If the image is plain shapes or mostly text, scene is "abstract" or "poster_or_ad".`;

// مطابقة اسم اللافتة مع اسم المطعم المسجّل (بعد توحيد الحروف وحذف كلمات مثل «مطعم»)
const STOP = new Set(["مطعم", "كافتيريا", "كافيه", "بوفيه", "شواية", "اكل", "وجبات", "restaurant", "cafe", "the"]);
const words = s => norm(s).split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3 && !STOP.has(w));
export function nameMatch(sign, name) {
  const a = words(sign), b = words(name);
  if (!a.length || !b.length) return "unknown";
  const hit = b.filter(w => a.some(x => x.includes(w) || w.includes(x))).length;
  return hit === b.length ? "yes" : hit ? "partial" : "no";
}

// مزوّدو الذكاء الاصطناعي المجانيون، يُستخدم أول مزوّد مفاتيحه موجودة في أسرار GitHub:
//   محلي على خادم GitHub (الافتراضي): OLLAMA_MODEL — نموذج رؤية مفتوح المصدر، بلا أي حساب
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
  if (e.OLLAMA_MODEL) return "local";
  if (e.CF_ACCOUNT_ID && e.CF_API_TOKEN) return "cloudflare";
  if (e.GEMINI_API_KEY) return "gemini";
  if (e.AI_URL && e.AI_KEY && e.AI_MODEL) return "custom";
  return null;
}

async function askAI(r, images) {
  images = [...images];
  const p = aiProvider(), e = process.env;
  if (!p || !images.length) return null;
  const prompt = PROMPT(r, !["cloudflare", "local"].includes(p) && images.length > 1);
  if (p === "local") images = images.slice(0, 1);   // نموذج صغير: صورة الواجهة فقط، أدق وأسرع
  try {
    const out = p === "local" ? await openaiCompat("http://127.0.0.1:11434/v1/chat/completions", "ollama", e.OLLAMA_MODEL, prompt, images)
      : p === "cloudflare" ? await cloudflare(prompt, images)
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

  // ───── تحليل الصورة بالطريقة العادية (بدون ذكاء اصطناعي) ─────
  // 1) بيانات الكاميرا التي قرأها الهاتف من الملف الأصلي عند الالتقاط
  const m = r.proofMeta?.sign || null;
  const EDITORS = /photoshop|canva|picsart|snapseed|gimp|lightroom|illustrator|figma|remini|facetune/i;
  add(!!m?.camera, m?.camera ? `صورة من كاميرا الهاتف${m.make ? ` (${String(m.make + " " + (m.model || "")).trim().slice(0, 30)})` : ""}` : "لا توجد بيانات كاميرا في الصورة");
  const takenAgo = m?.taken ? (r.reviewAt?.toMillis?.() || Date.now()) - m.taken : null;
  add(takenAgo != null && takenAgo > -864e5 && takenAgo < 7 * 864e5, takenAgo == null ? "تاريخ الالتقاط غير معروف" : takenAgo < 7 * 864e5 ? "التُقطت حديثاً" : "الصورة قديمة (التُقطت قبل أكثر من أسبوع)");
  add(!EDITORS.test(m?.software || ""), EDITORS.test(m?.software || "") ? `الصورة معدّلة ببرنامج (${m.software})` : "لا أثر لبرامج تعديل الصور");
  // 2) نعيد تحليل البكسلات على الخادم (لا نعتمد على الهاتف وحده)
  const st = imgs.sign ? await imageStats(imgs.sign).catch(() => null) : null;
  const graphic = !!st && (st.flat > 0.6 || st.colors < 150);
  if (st) {
    add(!graphic && st.flat < 0.45, graphic ? "الصورة تصميم أو لقطة شاشة (مساحات لونية مسطحة)" : st.flat < 0.45 ? "تفاصيل الصورة طبيعية كصور الكاميرا" : "تفاصيل الصورة غير كافية للحكم");
    add(st.lum >= 35 && st.lum <= 240, st.lum < 35 ? "الصورة مظلمة جداً" : st.lum > 240 ? "الصورة ساطعة جداً" : "الإضاءة مناسبة");
  }

  // ───── ذكاء اصطناعي اختياري (معطّل افتراضياً، يعمل فقط إذا أُضيف مزوّد في أسرار GitHub) ─────
  const ai = imgs.sign && aiProvider() ? await askAI(r, [imgs.sign, imgs.license].filter(Boolean)) : null;
  if (ai) {
    ai.name_match = nameMatch(ai.sign_text, r.name);
    add(!!ai.sign_visible && ai.name_match !== "no", ai.name_match === "no" ? "الاسم على اللافتة لا يطابق اسم المطعم" : "اللافتة متوافقة مع اسم المطعم");
  }

  // القرار
  const hardFail = checks.find(c => c.hard && !c.ok);
  let decision = "manual", reason = "";
  if (hardFail) { decision = "reject"; reason = hardFail.label; }
  else if (graphic) { decision = "reject"; reason = "صورة الواجهة تصميم أو لقطة شاشة. التقط صورة حقيقية لواجهة مطعمك بالكاميرا"; }
  else if (st && checks.every(c => c.ok)) decision = "approve";
  else reason = checks.filter(c => !c.ok).map(c => c.label).join("، ");
  const conf = checks.filter(c => c.ok).length / checks.length;

  return {
    decision, reason, hashes,
    report: { key: r.reviewAt?.toMillis?.() || 0, at: new Date().toISOString(), decision, reason, confidence: conf,
      checks: checks.map(({ ok, label }) => ({ ok, label })), stats: st, ai: ai ? { model: ai.model, note: String(ai.description || "").slice(0, 220), sign: String(ai.sign_text || "").slice(0, 60) } : null }
  };
}
