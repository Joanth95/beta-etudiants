/**
 * Proxy API entre l'espace étudiant (GitHub Pages) et Grist (DINUM).
 *
 * La clé API Grist reste secrète ici (variable GRIST_API_KEY).
 * Chaque étudiant s'authentifie avec son code personnel (colonne Code
 * de la table Etudiants) et ne peut lire/modifier que ses propres
 * lignes de la table Planning.
 *
 * Endpoints :
 *   POST   /api/login              { code }            -> infos étudiant
 *   GET    /api/planning                                -> créneaux de l'étudiant
 *   POST   /api/planning           { fields }           -> création
 *   PATCH  /api/planning/:id       { fields }           -> modification
 *   DELETE /api/planning/:id                            -> suppression
 *
 * Le code étudiant est transmis dans l'en-tête X-Student-Code.
 */

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

// Champs que l'étudiant a le droit d'écrire dans Planning.
const WRITABLE_FIELDS = ["Date", "Heure_Debut", "Heure_Fin", "Activite", "Lieu", "Notes"];

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env, request);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      const response = await route(request, env);
      for (const [k, v] of Object.entries(cors)) response.headers.set(k, v);
      return response;
    } catch (err) {
      const body = JSON.stringify({ error: err.publicMessage || "Erreur interne du serveur" });
      const status = err.status || 500;
      if (!err.status) console.error(err);
      return new Response(body, { status, headers: { ...JSON_HEADERS, ...cors } });
    }
  },
};

function corsHeaders(env, request) {
  const allowed = env.ALLOWED_ORIGIN || "*";
  const origin = request.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": allowed === "*" ? "*" : (origin === allowed ? allowed : allowed),
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Student-Code",
    "Access-Control-Max-Age": "86400",
  };
}

function httpError(status, publicMessage) {
  const err = new Error(publicMessage);
  err.status = status;
  err.publicMessage = publicMessage;
  return err;
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");

  if (request.method === "POST" && path === "/api/login") {
    return login(request, env);
  }

  const planningMatch = path.match(/^\/api\/planning(?:\/(\d+))?$/);
  if (planningMatch) {
    const student = await authenticate(request, env);
    const rowId = planningMatch[1] ? Number(planningMatch[1]) : null;

    if (request.method === "GET" && rowId === null) return listPlanning(env, student);
    if (request.method === "POST" && rowId === null) return createEntry(request, env, student);
    if (request.method === "PATCH" && rowId !== null) return updateEntry(request, env, student, rowId);
    if (request.method === "DELETE" && rowId !== null) return deleteEntry(env, student, rowId);
  }

  throw httpError(404, "Route inconnue");
}

/* ------------------------------------------------------------------ */
/* Authentification                                                    */
/* ------------------------------------------------------------------ */

async function findStudentByCode(env, code) {
  if (!code || typeof code !== "string" || code.length < 4 || code.length > 64) return null;
  const table = env.TABLE_ETUDIANTS || "Etudiants";
  const colCode = env.COL_CODE || "Code";
  const filter = encodeURIComponent(JSON.stringify({ [colCode]: [code] }));
  const data = await grist(env, "GET", `/tables/${table}/records?filter=${filter}`);
  return data.records && data.records.length === 1 ? data.records[0] : null;
}

async function authenticate(request, env) {
  const code = request.headers.get("X-Student-Code");
  const student = await findStudentByCode(env, code);
  if (!student) throw httpError(401, "Code étudiant invalide");
  return { id: student.id, code, fields: student.fields };
}

async function login(request, env) {
  const body = await request.json().catch(() => ({}));
  const student = await findStudentByCode(env, body.code);
  if (!student) throw httpError(401, "Code étudiant invalide");
  return json({
    nom: student.fields.Nom || "",
    prenom: student.fields.Prenom || "",
  });
}

/* ------------------------------------------------------------------ */
/* Planning                                                            */
/* ------------------------------------------------------------------ */

async function listPlanning(env, student) {
  const table = env.TABLE_PLANNING || "Planning";
  const colStudent = env.COL_PLANNING_CODE || "Code_Etudiant";
  const filter = encodeURIComponent(JSON.stringify({ [colStudent]: [student.code] }));
  const data = await grist(env, "GET", `/tables/${table}/records?filter=${filter}`);
  const records = (data.records || []).map((r) => ({
    id: r.id,
    fields: { ...r.fields, Date: epochToIso(r.fields.Date) },
  }));
  return json({ records });
}

async function createEntry(request, env, student) {
  const table = env.TABLE_PLANNING || "Planning";
  const colStudent = env.COL_PLANNING_CODE || "Code_Etudiant";
  const fields = sanitizeFields(await request.json().catch(() => ({})));
  fields[colStudent] = student.code; // toujours rattaché à l'étudiant authentifié
  const data = await grist(env, "POST", `/tables/${table}/records`, { records: [{ fields }] });
  return json({ id: data.records[0].id }, 201);
}

async function updateEntry(request, env, student, rowId) {
  await assertOwnership(env, student, rowId);
  const table = env.TABLE_PLANNING || "Planning";
  const fields = sanitizeFields(await request.json().catch(() => ({})));
  await grist(env, "PATCH", `/tables/${table}/records`, { records: [{ id: rowId, fields }] });
  return json({ ok: true });
}

async function deleteEntry(env, student, rowId) {
  await assertOwnership(env, student, rowId);
  const table = env.TABLE_PLANNING || "Planning";
  await grist(env, "POST", `/tables/${table}/data/delete`, [rowId]);
  return json({ ok: true });
}

/** Vérifie que la ligne appartient bien à l'étudiant connecté. */
async function assertOwnership(env, student, rowId) {
  const table = env.TABLE_PLANNING || "Planning";
  const colStudent = env.COL_PLANNING_CODE || "Code_Etudiant";
  const filter = encodeURIComponent(JSON.stringify({ id: [rowId] }));
  const data = await grist(env, "GET", `/tables/${table}/records?filter=${filter}`);
  const record = data.records && data.records[0];
  if (!record || record.fields[colStudent] !== student.code) {
    throw httpError(403, "Ce créneau ne vous appartient pas");
  }
}

/** Ne garde que les champs autorisés et convertit la date en epoch pour Grist. */
function sanitizeFields(body) {
  const source = body.fields || body || {};
  const fields = {};
  for (const key of WRITABLE_FIELDS) {
    if (source[key] !== undefined) fields[key] = source[key];
  }
  if (typeof fields.Date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(fields.Date)) {
    fields.Date = Date.parse(fields.Date + "T00:00:00Z") / 1000;
  } else {
    delete fields.Date;
  }
  return fields;
}

function epochToIso(value) {
  if (typeof value !== "number") return value || null;
  return new Date(value * 1000).toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* Client Grist                                                        */
/* ------------------------------------------------------------------ */

async function grist(env, method, path, body) {
  const base = (env.GRIST_BASE_URL || "https://grist.numerique.gouv.fr/api").replace(/\/$/, "");
  const url = `${base}/docs/${env.GRIST_DOC_ID}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${env.GRIST_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`Grist ${method} ${path} -> ${res.status}: ${text}`);
    throw httpError(502, "Erreur de communication avec Grist");
  }
  if (res.status === 204) return {};
  return res.json().catch(() => ({}));
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}
