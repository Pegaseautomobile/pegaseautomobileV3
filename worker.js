// Pégase Automobile admin API for Cloudflare Workers.
// Set the values listed in the setup guide as Cloudflare variables/secrets.

const SESSION_HOURS = 8;
const PHOTO_LIMIT = 10;
const PHOTO_SIZE_LIMIT = 5 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function originAllowed(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(value => value.trim()).filter(Boolean);
  return Boolean(origin && allowed.includes(origin));
}

function responseHeaders(origin) {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
    "Cache-Control": "no-store"
  };
}

function jsonResponse(data, status, origin) {
  return new Response(JSON.stringify(data), { status, headers: responseHeaders(origin) });
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function sign(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

async function createSession(secret) {
  const payload = base64Url(new TextEncoder().encode(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + SESSION_HOURS * 60 * 60
  })));
  return `${payload}.${base64Url(await sign(payload, secret))}`;
}

function sameBytes(left, right) {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    difference |= (left[index] || 0) ^ (right[index] || 0);
  }
  return difference === 0;
}

async function validSession(token, secret) {
  if (!token || !secret) return false;
  const pieces = token.split(".");
  if (pieces.length !== 2) return false;
  try {
    const expected = await sign(pieces[0], secret);
    if (!sameBytes(expected, fromBase64Url(pieces[1]))) return false;
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(pieces[0])));
    return Number(payload.exp) > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function supabaseBase(env) {
  return (env.SUPABASE_URL || "").replace(/\/+$/, "");
}

function supabaseHeaders(env, extra = {}) {
  return { apikey: env.SUPABASE_SECRET_KEY, ...extra };
}

async function readUpstream(response) {
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    const message = typeof data === "string" ? data : (data?.message || data?.error || `HTTP ${response.status}`);
    throw new Error(`Supabase : ${message}`);
  }
  return data;
}

function checkConfiguration(env) {
  if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET || !env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
    throw new Error("Il manque un réglage secret dans Cloudflare.");
  }
}

async function removePhotos(paths, env) {
  const unique = [...new Set(paths.filter(Boolean))];
  if (!unique.length) return;
  const result = await fetch(`${supabaseBase(env)}/storage/v1/object/cars`, {
    method: "DELETE",
    headers: supabaseHeaders(env, { "Content-Type": "application/json" }),
    body: JSON.stringify({ prefixes: unique })
  });
  await readUpstream(result);
}

async function uploadPhotos(files, env) {
  if (!files.length) throw new Error("Choisis au moins une photo.");
  if (files.length > PHOTO_LIMIT) throw new Error("10 photos maximum par annonce.");

  const base = supabaseBase(env);
  const photos = [];
  try {
    for (const file of files) {
      if (!ALLOWED_TYPES.has(file.type)) throw new Error("Utilise des photos JPG, PNG ou WEBP.");
      if (file.size > PHOTO_SIZE_LIMIT) throw new Error("Chaque photo doit faire moins de 5 Mo.");
      const extension = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
      const path = `${crypto.randomUUID()}.${extension}`;
      const result = await fetch(`${base}/storage/v1/object/cars/${path}`, {
        method: "POST",
        headers: supabaseHeaders(env, { "Content-Type": file.type, "x-upsert": "false" }),
        body: file
      });
      await readUpstream(result);
      photos.push({
        url: `${base}/storage/v1/object/public/cars/${path}`,
        path
      });
    }
  } catch (error) {
    await removePhotos(photos.map(photo => photo.path), env).catch(() => {});
    throw error;
  }
  return photos;
}

function validateCar(car) {
  const brand = String(car.brand || "").trim();
  const model = String(car.model || "").trim();
  const year = Number(car.year);
  const km = Number(car.km);
  const price = Number(car.price);
  const fuel = String(car.fuel || "");
  const gear = String(car.gear || "");
  const badge = String(car.badge || "Disponible").trim().slice(0, 80);
  if (!brand || !model || brand.length > 80 || model.length > 120) throw new Error("Vérifie la marque et le modèle.");
  if (!Number.isInteger(year) || year < 1950 || year > 2100) throw new Error("Vérifie l’année du véhicule.");
  if (!Number.isInteger(km) || km < 0 || !Number.isInteger(price) || price < 0) throw new Error("Vérifie le kilométrage et le prix.");
  if (!["Diesel", "Essence", "Hybride", "Électrique"].includes(fuel)) throw new Error("Choisis une énergie valide.");
  if (!["Automatique", "Manuelle"].includes(gear)) throw new Error("Choisis une boîte de vitesse valide.");
  return { brand, model, year, km, fuel, gear, price, badge, warranty: Boolean(car.warranty), published: true };
}

async function handle(request, env) {
  const origin = request.headers.get("Origin");
  if (!originAllowed(origin, env)) return new Response("Origine refusée.", { status: 403 });
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: responseHeaders(origin) });

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/login" && request.method === "POST") {
    checkConfiguration(env);
    const input = await request.json().catch(() => ({}));
    if (!sameBytes(new TextEncoder().encode(String(input.password || "")), new TextEncoder().encode(env.ADMIN_PASSWORD))) {
      return jsonResponse({ error: "Mot de passe incorrect." }, 401, origin);
    }
    return jsonResponse({ token: await createSession(env.SESSION_SECRET) }, 200, origin);
  }

  checkConfiguration(env);
  const authorization = request.headers.get("Authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!await validSession(token, env.SESSION_SECRET)) {
    return jsonResponse({ error: "Ta connexion a expiré. Reconnecte-toi." }, 401, origin);
  }

  const tableUrl = `${supabaseBase(env)}/rest/v1/cars`;
  if (path === "/cars" && request.method === "GET") {
    const query = new URLSearchParams({
      select: "id,brand,model,year,km,fuel,gear,price,warranty,badge,image_url,image_path,images,published",
      order: "created_at.desc"
    });
    const result = await fetch(`${tableUrl}?${query}`, { headers: supabaseHeaders(env) });
    return jsonResponse(await readUpstream(result), 200, origin);
  }

  if (path === "/cars" && request.method === "POST") {
    const form = await request.formData();
    let input;
    try { input = JSON.parse(String(form.get("car") || "{}")); }
    catch { return jsonResponse({ error: "Les informations de l’annonce sont invalides." }, 400, origin); }
    const details = validateCar(input);
    const files = form.getAll("photos").filter(value => value instanceof File && value.size > 0);
    const photos = await uploadPhotos(files, env);
    const car = { ...details, image_url: photos[0].url, image_path: photos[0].path, images: photos };
    try {
      const result = await fetch(tableUrl, {
        method: "POST",
        headers: supabaseHeaders(env, { "Content-Type": "application/json", Prefer: "return=representation" }),
        body: JSON.stringify(car)
      });
      const saved = await readUpstream(result);
      return jsonResponse(saved?.[0] || saved, 201, origin);
    } catch (error) {
      await removePhotos(photos.map(photo => photo.path), env).catch(() => {});
      throw error;
    }
  }

  const addPhotosMatch = path.match(/^\/cars\/([0-9a-f-]+)\/photos$/i);
  if (addPhotosMatch && request.method === "POST") {
    const id = addPhotosMatch[1];
    const query = new URLSearchParams({ select: "id,image_url,image_path,images", id: `eq.${id}` });
    const currentResult = await fetch(`${tableUrl}?${query}`, { headers: supabaseHeaders(env) });
    const rows = await readUpstream(currentResult);
    if (!rows?.length) return jsonResponse({ error: "Annonce introuvable." }, 404, origin);
    const current = rows[0];
    const currentPhotos = Array.isArray(current.images) && current.images.length
      ? current.images
      : [{ url: current.image_url, path: current.image_path }].filter(photo => photo.url);
    const form = await request.formData();
    const files = form.getAll("photos").filter(value => value instanceof File && value.size > 0);
    if (currentPhotos.length + files.length > PHOTO_LIMIT) {
      return jsonResponse({ error: "Cette annonce peut contenir 10 photos maximum." }, 400, origin);
    }
    const photos = await uploadPhotos(files, env);
    const updateResult = await fetch(`${tableUrl}?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: supabaseHeaders(env, { "Content-Type": "application/json", Prefer: "return=representation" }),
      body: JSON.stringify({ images: [...currentPhotos, ...photos] })
    });
    try {
      const saved = await readUpstream(updateResult);
      return jsonResponse(saved?.[0] || { ok: true }, 200, origin);
    } catch (error) {
      await removePhotos(photos.map(photo => photo.path), env).catch(() => {});
      throw error;
    }
  }

  const deleteMatch = path.match(/^\/cars\/([0-9a-f-]+)$/i);
  if (deleteMatch && request.method === "DELETE") {
    const id = deleteMatch[1];
    const query = new URLSearchParams({ select: "image_path,images", id: `eq.${id}` });
    const currentResult = await fetch(`${tableUrl}?${query}`, { headers: supabaseHeaders(env) });
    const rows = await readUpstream(currentResult);
    if (!rows?.length) return jsonResponse({ error: "Annonce introuvable." }, 404, origin);
    const current = rows[0];
    const deleteResult = await fetch(`${tableUrl}?id=eq.${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: supabaseHeaders(env, { Prefer: "return=minimal" })
    });
    await readUpstream(deleteResult);
    const paths = Array.isArray(current.images) ? current.images.map(photo => photo.path).filter(Boolean) : [];
    if (current.image_path) paths.push(current.image_path);
    await removePhotos(paths, env);
    return jsonResponse({ ok: true }, 200, origin);
  }

  return jsonResponse({ error: "Adresse ou action inconnue." }, 404, origin);
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (error) {
      const origin = request.headers.get("Origin") || "";
      if (!originAllowed(origin, env)) return new Response("Origine refusée.", { status: 403 });
      return jsonResponse({ error: error instanceof Error ? error.message : "Erreur du serveur." }, 500, origin);
    }
  }
};
