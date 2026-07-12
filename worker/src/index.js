/**
 * Proxy API entre l'espace étudiant (GitHub Pages) et le document Grist
 * GESTION-ETUDIANT (instance DINUM).
 *
 * La clé API Grist reste secrète ici (secret GRIST_API_KEY).
 * L'étudiant s'authentifie avec son code anonymat (1ère lettre du prénom
 * + date de naissance JJMMAA + 1ère lettre du nom, ex. J150398D).
 *
 * Règles métier :
 *   - Le planning hebdomadaire (PLANNING_HEBDO) est géré dans Grist :
 *     l'étudiant le CONSULTE uniquement.
 *   - L'étudiant déclare ses écarts dans Sortie_de_stage : rattrapage
 *     (heures en plus), retard (heures déduites par la formule Grist), etc.
 *   - Un étudiant peut s'inscrire seul (« entrée en stage ») : création de
 *     sa fiche LISTE_DES_ETUDIANTS + de sa période PERIODES_DE_STAGE.
 *
 * Endpoints (code anonymat dans l'en-tête X-Student-Code) :
 *   GET    /api/services                       -> services accueillant des étudiants (public)
 *   POST   /api/inscription    { ... }         -> auto-inscription (public)
 *   POST   /api/login          { code }        -> payload complet
 *   GET    /api/data                           -> payload complet (rafraîchissement)
 *   POST   /api/sorties        { ... }         -> nouvelle déclaration
 *   DELETE /api/sorties/:id                    -> suppression d'une de SES déclarations
 */

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

const T_ETUDIANTS = "LISTE_DES_ETUDIANTS";
const T_PERIODES = "PERIODES_DE_STAGE";
const T_HEBDO = "PLANNING_HEBDO";
const T_CODES = "CODES_HORAIRES";
const T_SERVICES = "SERVICES";
const T_SORTIES = "Sortie_de_stage";

const DAY_COLUMNS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];

const CIVILITES = ["Madame", "Monsieur"];
const FORMATIONS = ["AIDE SOIGNANT", "INFIRMIER", "AUTRE"];
const NIVEAUX = ["L1", "L2", "L3", "M1", "M2", "Aide-Soignant"];
// Motifs proposés à l'étudiant ; « Retard » est déduit par la formule Grist
// Ajustement_h ; « Sortie de stage » compte ou non selon la case Compte_stage
const MOTIFS = ["Rattrapage", "Retard", "Sortie de stage"];

// Nombre maximal de semaines générées automatiquement pour une période
const MAX_SEMAINES_GENEREES = 30;

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    try {
      const response = await route(request, env);
      for (const [k, v] of Object.entries(cors)) response.headers.set(k, v);
      return response;
    } catch (err) {
      const status = err.status || 500;
      if (!err.status) console.error(err);
      return new Response(JSON.stringify({ error: err.publicMessage || "Erreur interne du serveur" }), {
        status,
        headers: { ...JSON_HEADERS, ...cors },
      });
    }
  },
};

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
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
  const path = new URL(request.url).pathname.replace(/\/+$/, "");

  // --- Endpoints publics (page d'entrée en stage) ---
  if (request.method === "GET" && path === "/api/services") {
    return listServices(env);
  }
  if (request.method === "POST" && path === "/api/inscription") {
    return inscription(request, env);
  }
  if (request.method === "POST" && path === "/api/login") {
    const body = await request.json().catch(() => ({}));
    const student = await authenticateCode(env, body.code);
    return json(await buildPayload(env, student));
  }

  // --- Endpoints authentifiés ---
  const student = await authenticateCode(env, request.headers.get("X-Student-Code"));

  if (request.method === "GET" && path === "/api/data") {
    return json(await buildPayload(env, student));
  }
  if (request.method === "POST" && path === "/api/sorties") {
    return createSortie(request, env, student);
  }
  const m = path.match(/^\/api\/sorties\/(\d+)$/);
  if (request.method === "DELETE" && m) {
    return deleteSortie(env, student, Number(m[1]));
  }

  throw httpError(404, "Route inconnue");
}

/* ------------------------------------------------------------------ */
/* Authentification                                                    */
/* ------------------------------------------------------------------ */

function normalizeCode(code) {
  if (typeof code !== "string") return null;
  code = code.trim().toUpperCase();
  // 1 lettre (accents acceptés) + JJMMAA + 1 lettre
  if (!/^\p{Lu}\d{6}\p{Lu}$/u.test(code)) return null;
  return code;
}

async function authenticateCode(env, rawCode) {
  const code = normalizeCode(rawCode);
  if (!code) throw httpError(401, "Code anonymat invalide");
  const records = await gristFilter(env, T_ETUDIANTS, { Anonymat: [code] });
  if (records.length !== 1) throw httpError(401, "Code anonymat invalide");
  return { rowId: records[0].id, code, fields: records[0].fields };
}

/* ------------------------------------------------------------------ */
/* Lecture : payload complet pour l'étudiant                           */
/* ------------------------------------------------------------------ */

async function buildPayload(env, student) {
  const [periodes, services, codes, sorties] = await Promise.all([
    gristFilter(env, T_PERIODES, { Code_anonymat: [student.code] }),
    gristAll(env, T_SERVICES),
    gristAll(env, T_CODES),
    gristFilter(env, T_SORTIES, { Anonymat: [student.rowId] }),
  ]);

  const serviceName = new Map(services.map((s) => [s.id, s.fields.Nom || ""]));
  const periodeIds = periodes.map((p) => p.id);

  const semaines = periodeIds.length
    ? await gristFilter(env, T_HEBDO, { Periode: periodeIds })
    : [];

  return {
    etudiant: {
      prenom: student.fields.PRENOM || "",
      nom: student.fields.NOM || "",
    },
    motifs: MOTIFS,
    periodes: periodes.map((p) => ({
      id: p.id,
      Du: epochToIso(p.fields.Du),
      Au: epochToIso(p.fields.Au),
      Service: serviceName.get(p.fields.Service) || "",
      Niveau: p.fields.Niveau || "",
      En_cours: !!p.fields.En_cours,
      A_FAIRE: p.fields.A_FAIRE ?? null,
      FAIT: p.fields.FAIT ?? null,
      Solde_heures: p.fields.Solde_heures ?? null,
      Tuteur: p.fields.Tuteur || "",
    })),
    semaines: semaines.map((s) => {
      const out = {
        id: s.id,
        Periode: s.fields.Periode,
        Semaine_debut: epochToIso(s.fields.Semaine_debut),
        Commentaire: s.fields.Commentaire || "",
        Total_h_semaine: s.fields.Total_h_semaine ?? null,
      };
      for (const d of DAY_COLUMNS) out[d] = s.fields[d] || 0;
      return out;
    }),
    codes: codes.map((c) => ({
      id: c.id,
      Code: c.fields.Code || "",
      Libelle: c.fields.Libelle || "",
      Heure_debut: c.fields.Heure_debut || "",
      Heure_fin: c.fields.Heure_fin || "",
    })),
    sorties: sorties.map((s) => ({
      id: s.id,
      Motif: s.fields.Motif || "",
      Date: epochToIso(s.fields.Date),
      Heure_debut: s.fields.Heure_debut || "",
      Heure_fin: s.fields.Heure_fin || "",
      Compte_stage: !!s.fields.Compte_stage,
      Duree_affichee: s.fields.Duree_affichee || "",
      Ajustement_h: s.fields.Ajustement_h ?? 0,
    })),
  };
}

async function listServices(env) {
  const services = await gristAll(env, T_SERVICES);
  return json({
    services: services
      .filter((s) => s.fields.Recoit_des_etudiant)
      .map((s) => ({ id: s.id, Nom: s.fields.Nom || "" })),
    civilites: CIVILITES,
    formations: FORMATIONS,
    niveaux: NIVEAUX,
  });
}

/* ------------------------------------------------------------------ */
/* Sorties de stage (déclarations d'heures)                            */
/* ------------------------------------------------------------------ */

const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

async function createSortie(request, env, student) {
  const body = await request.json().catch(() => ({}));

  const motif = String(body.Motif || "").trim().slice(0, 100);
  const date = String(body.Date || "");
  const debut = String(body.Heure_debut || "").trim();
  const fin = String(body.Heure_fin || "").trim();

  if (!motif) throw httpError(400, "Le motif est obligatoire");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw httpError(400, "Date invalide");
  if (!TIME_RE.test(debut) || !TIME_RE.test(fin)) {
    throw httpError(400, "Heures invalides (format attendu : HH:MM)");
  }

  // « Retard » est déduit par la formule Grist ; les autres motifs comptent
  // comme heures de stage sauf refus explicite.
  const compteStage = motif.toUpperCase() === "RETARD" ? false : body.Compte_stage !== false;

  const fields = {
    Anonymat: student.rowId,
    Code_anonymat: student.code,
    Motif: motif,
    Date: Date.parse(date + "T00:00:00Z") / 1000,
    Heure_debut: debut,
    Heure_fin: fin,
    Compte_stage: compteStage,
  };
  const data = await grist(env, "POST", `/tables/${T_SORTIES}/records`, { records: [{ fields }] });
  return json({ id: data.records[0].id }, 201);
}

async function deleteSortie(env, student, rowId) {
  const rows = await gristFilter(env, T_SORTIES, { id: [rowId] });
  if (!rows.length) throw httpError(404, "Déclaration introuvable");
  if (rows[0].fields.Anonymat !== student.rowId) {
    throw httpError(403, "Cette déclaration ne vous appartient pas");
  }
  await grist(env, "POST", `/tables/${T_SORTIES}/data/delete`, [rowId]);
  return json({ ok: true });
}

/* ------------------------------------------------------------------ */
/* Inscription (« entrée en stage »)                                   */
/* ------------------------------------------------------------------ */

async function inscription(request, env) {
  const body = await request.json().catch(() => ({}));

  // Champ-piège anti-robots : rempli uniquement par les robots
  if (body.website) throw httpError(400, "Requête refusée");

  const nom = cleanText(body.NOM, 80);
  const prenom = cleanText(body.PRENOM, 80);
  const ddn = String(body.DDN || "");
  const civilite = CIVILITES.includes(body.Civilite) ? body.Civilite : "";
  const formation = FORMATIONS.includes(body.FORMATION) ? body.FORMATION : "";
  const centre = cleanText(body.Centre_de_formation, 120);
  const email = cleanText(body.Adresse_mail, 120);
  const telephone = cleanText(body.Numero_de_telephone, 20);

  const p = body.periode || {};
  const serviceId = Number(p.Service);
  const du = String(p.Du || "");
  const au = String(p.Au || "");
  const niveau = NIVEAUX.includes(p.Niveau) ? p.Niveau : "";
  const tuteur = cleanText(p.Tuteur, 80);

  if (!nom || !prenom) throw httpError(400, "Nom et prénom obligatoires");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ddn)) throw httpError(400, "Date de naissance invalide");
  if (!formation) throw httpError(400, "Formation obligatoire");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(du) || !/^\d{4}-\d{2}-\d{2}$/.test(au)) {
    throw httpError(400, "Dates de stage invalides");
  }
  if (du > au) throw httpError(400, "La fin du stage doit être après le début");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, "Adresse mail invalide");

  const services = await gristAll(env, T_SERVICES);
  const service = services.find((s) => s.id === serviceId && s.fields.Recoit_des_etudiant);
  if (!service) throw httpError(400, "Service invalide");

  // Code anonymat calculé comme la formule Grist :
  // PRENOM[0].upper() + DDN JJMMAA + NOM[0].upper()
  const [y, mo, d] = ddn.split("-");
  const code = (prenom[0] + d + mo + y.slice(2) + nom[0]).toUpperCase();

  // Étudiant déjà connu ? On ne crée que la nouvelle période.
  const existing = await gristFilter(env, T_ETUDIANTS, { Anonymat: [code] });
  let studentRowId;
  let dejaInscrit = false;

  if (existing.length === 1) {
    studentRowId = existing[0].id;
    dejaInscrit = true;
    const periodes = await gristFilter(env, T_PERIODES, { Code_anonymat: [code] });
    const duEpoch = Date.parse(du + "T00:00:00Z") / 1000;
    if (periodes.some((per) => per.fields.Du === duEpoch)) {
      throw httpError(409, "Une période de stage commençant à cette date existe déjà. Connectez-vous avec votre code.");
    }
  } else if (existing.length > 1) {
    throw httpError(409, "Plusieurs dossiers correspondent à ce code : contactez votre encadrant.");
  } else {
    const studentFields = {
      NOM: nom,
      PRENOM: prenom,
      DDN: Date.parse(ddn + "T00:00:00Z") / 1000,
      FORMATION: formation,
      Civilite: civilite,
      Centre_de_formation: centre,
      Adresse_mail: email,
      Numero_de_telephone: telephone,
    };
    const created = await grist(env, "POST", `/tables/${T_ETUDIANTS}/records`, {
      records: [{ fields: studentFields }],
    });
    studentRowId = created.records[0].id;
  }

  const createdPeriode = await grist(env, "POST", `/tables/${T_PERIODES}/records`, {
    records: [{
      fields: {
        Anonymat: studentRowId,
        Code_anonymat: code,
        Du: Date.parse(du + "T00:00:00Z") / 1000,
        Au: Date.parse(au + "T00:00:00Z") / 1000,
        Niveau: niveau,
        Service: serviceId,
        Tuteur: tuteur,
      },
    }],
  });
  const periodeId = createdPeriode.records[0].id;

  // Génère une semaine de planning (vide) par semaine de stage,
  // que le service remplira ensuite dans Grist.
  const nbSemaines = await genererSemaines(env, periodeId, du, au);

  return json({ code, dejaInscrit, semainesGenerees: nbSemaines }, 201);
}

function cleanText(value, max) {
  return String(value || "").trim().slice(0, max);
}

async function genererSemaines(env, periodeId, duIso, auIso) {
  const DAY = 86400;
  const du = Date.parse(duIso + "T00:00:00Z") / 1000;
  const au = Date.parse(auIso + "T00:00:00Z") / 1000;
  // Lundi de la semaine du début de stage (getUTCDay : lundi = 1)
  const shift = (new Date(du * 1000).getUTCDay() + 6) % 7;
  let monday = du - shift * DAY;

  const records = [];
  while (monday <= au && records.length < MAX_SEMAINES_GENEREES) {
    records.push({ fields: { Periode: periodeId, Semaine_debut: monday } });
    monday += 7 * DAY;
  }
  if (records.length) {
    await grist(env, "POST", `/tables/${T_HEBDO}/records`, { records });
  }
  return records.length;
}

/* ------------------------------------------------------------------ */
/* Client Grist                                                        */
/* ------------------------------------------------------------------ */

async function grist(env, method, path, body) {
  const base = (env.GRIST_BASE_URL || "https://grist.numerique.gouv.fr/api").replace(/\/$/, "");
  const res = await fetch(`${base}/docs/${env.GRIST_DOC_ID}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.GRIST_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`Grist ${method} ${path} -> ${res.status}: ${await res.text()}`);
    throw httpError(502, "Erreur de communication avec Grist");
  }
  return res.json().catch(() => ({}));
}

async function gristFilter(env, table, filter) {
  const q = encodeURIComponent(JSON.stringify(filter));
  const data = await grist(env, "GET", `/tables/${table}/records?filter=${q}`);
  return data.records || [];
}

async function gristAll(env, table) {
  const data = await grist(env, "GET", `/tables/${table}/records`);
  return data.records || [];
}

/* ------------------------------------------------------------------ */
/* Utilitaires                                                         */
/* ------------------------------------------------------------------ */

function epochToIso(value) {
  if (typeof value !== "number") return value || null;
  return new Date(value * 1000).toISOString().slice(0, 10);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}
