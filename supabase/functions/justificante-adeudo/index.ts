import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BUCKET = "justificantes-adeudos";
const MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  "image/webp",
  "image/jpeg",
  "image/png",
  "application/pdf",
  "application/gzip",
]);
const EXT_MAP: Record<string, string> = {
  "image/webp": "webp",
  "image/jpeg": "jpg",
  "image/png": "png",
  "application/pdf": "pdf",
  "application/gzip": "gz",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }
  if (req.method !== "POST") {
    return json({ ok: false, mensaje: "Método no permitido." }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceKey) {
    return json({ ok: false, mensaje: "Configuración incompleta del servidor." }, 500);
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const ct = req.headers.get("content-type") || "";

  if (ct.includes("multipart/form-data")) {
    const form = await req.formData();
    const token = String(form.get("p_token") || "").trim();
    const colId = String(form.get("p_colaborador_id") || "").trim();
    const file = form.get("file");

    if (!/^[0-9a-f]{64}$/.test(token)) {
      return json({ ok: false, mensaje: "Token inválido." }, 401);
    }
    if (!/^[0-9a-f-]{36}$/i.test(colId)) {
      return json({ ok: false, mensaje: "ID de colaborador inválido." }, 400);
    }
    if (!(file instanceof File)) {
      return json({ ok: false, mensaje: "Archivo justificante requerido." }, 400);
    }
    if (file.size <= 0 || file.size > MAX_BYTES) {
      return json({ ok: false, mensaje: "El archivo comprimido debe pesar máximo 2 MB." }, 400);
    }
    const mime = file.type || "application/octet-stream";
    if (!ALLOWED_MIME.has(mime)) {
      return json({ ok: false, mensaje: "Formato de archivo no permitido." }, 400);
    }

    const { data: authRes, error: authErr } = await admin.rpc("colab_validar_justificante_acceso", {
      p_token: token,
      p_accion: "upload",
    });
    if (authErr || !authRes?.ok) {
      return json({ ok: false, mensaje: authRes?.mensaje || "No autorizado para subir justificantes." }, 403);
    }

    const buf = await file.arrayBuffer();
    const sha256 = await sha256Hex(buf);
    const ext = EXT_MAP[mime] || "bin";
    const path = `${colId}/${Date.now()}_${sha256.slice(0, 12)}.${ext}`;

    const { error: upErr } = await admin.storage.from(BUCKET).upload(path, buf, {
      contentType: mime,
      upsert: false,
    });
    if (upErr) {
      return json({ ok: false, mensaje: "No se pudo guardar el justificante: " + upErr.message }, 500);
    }

    return json({
      ok: true,
      storage_path: path,
      mime_type: mime,
      bytes: buf.byteLength,
      sha256,
    });
  }

  let body: { action?: string; p_token?: string; path?: string } = {};
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, mensaje: "Solicitud JSON inválida." }, 400);
  }

  if (body.action === "url") {
    const token = String(body.p_token || "").trim();
    const path = String(body.path || "").trim();
    if (!/^[0-9a-f]{64}$/.test(token) || !path || path.includes("..")) {
      return json({ ok: false, mensaje: "Parámetros inválidos." }, 400);
    }

    const { data: authRes, error: authErr } = await admin.rpc("colab_validar_justificante_acceso", {
      p_token: token,
      p_accion: "read",
    });
    if (authErr || !authRes?.ok) {
      return json({ ok: false, mensaje: authRes?.mensaje || "No autorizado." }, 403);
    }

    const { data: signed, error: signErr } = await admin.storage.from(BUCKET).createSignedUrl(path, 120);
    if (signErr || !signed?.signedUrl) {
      return json({ ok: false, mensaje: "No se pudo generar el enlace del justificante." }, 404);
    }

    return json({ ok: true, signedUrl: signed.signedUrl });
  }

  return json({ ok: false, mensaje: "Acción no reconocida." }, 400);
});
