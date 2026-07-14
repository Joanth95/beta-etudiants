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
 *
 * Espace cadre (email + code d'accès personnel dans X-Cadre-Email / X-Cadre-Code,
 * UTILISATEURS.Code_acces) : un cadre ne voit/modifie que les services dont il
 * est le Cadre_ref (SERVICES.Cadre_ref).
 *   POST   /api/cadre/login    { email, code }         -> payload des services du cadre
 *   GET    /api/cadre/data                             -> payload complet (rafraîchissement)
 *   PATCH  /api/cadre/sorties/:id   { Valide }         -> valider/invalider une déclaration
 *   PATCH  /api/cadre/planning/:semaineId { jour, codeId } -> édite une case du planning
 *   PATCH  /api/cadre/periodes/:id  { Tuteur, Niveau, Du, Au } -> édite une fiche de période
 */

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

const T_ETUDIANTS = "LISTE_DES_ETUDIANTS";
const T_PERIODES = "PERIODES_DE_STAGE";
const T_HEBDO = "PLANNING_HEBDO";
const T_CODES = "CODES_HORAIRES";
const T_SERVICES = "SERVICES";
const T_SORTIES = "Sortie_de_stage";
const T_UTILISATEURS = "UTILISATEURS";
const T_FERIES = "JOURS_FERIES";

const DAY_COLUMNS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];

const CIVILITES = ["Madame", "Monsieur"];
const FORMATIONS = ["AIDE SOIGNANT", "INFIRMIER", "AUTRE"];
const NIVEAUX = ["L1", "L2", "L3", "M1", "M2", "Aide-Soignant"];
// Motifs proposés à l'étudiant ; « Retard » est déduit par la formule Grist
// Ajustement_h ; « Sortie de stage » compte ou non selon la case Compte_stage
const MOTIFS = ["Rattrapage", "Retard", "Sortie de stage"];

// Nombre maximal de semaines générées automatiquement pour une période
const MAX_SEMAINES_GENEREES = 30;

// Base horaire réglementaire pour calculer les heures de stage à réaliser
const HEURES_PAR_SEMAINE = 35;

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
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Student-Code, X-Cadre-Email, X-Cadre-Code",
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
  if (request.method === "POST" && path === "/api/cadre/login") {
    const body = await request.json().catch(() => ({}));
    const cadre = await authenticateCadre(env, body.email, body.code);
    return json(await buildCadrePayload(env, cadre));
  }

  // --- Endpoints cadre authentifiés ---
  if (path.startsWith("/api/cadre/")) {
    const cadre = await authenticateCadre(
      env,
      request.headers.get("X-Cadre-Email"),
      request.headers.get("X-Cadre-Code")
    );
    if (request.method === "GET" && path === "/api/cadre/data") {
      return json(await buildCadrePayload(env, cadre));
    }
    const sm = path.match(/^\/api\/cadre\/sorties\/(\d+)$/);
    if (request.method === "PATCH" && sm) {
      return validerSortie(request, env, cadre, Number(sm[1]));
    }
    const wm = path.match(/^\/api\/cadre\/planning\/(\d+)$/);
    if (request.method === "PATCH" && wm) {
      return updatePlanningJour(request, env, cadre, Number(wm[1]));
    }
    const pm = path.match(/^\/api\/cadre\/periodes\/(\d+)$/);
    if (request.method === "PATCH" && pm) {
      return updatePeriode(request, env, cadre, Number(pm[1]));
    }
    throw httpError(404, "Route inconnue");
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

/** Authentifie un cadre par email + code d'accès personnel (UTILISATEURS.Code_acces). */
async function authenticateCadre(env, rawEmail, rawCode) {
  const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
  const code = typeof rawCode === "string" ? rawCode.trim() : "";
  if (!email || !code) throw httpError(401, "Email ou code d'accès invalide");

  const users = await gristAll(env, T_UTILISATEURS);
  const match = users.find(
    (u) => (u.fields.Email || "").trim().toLowerCase() === email
      && (u.fields.Code_acces || "").trim() === code
  );
  if (!match) throw httpError(401, "Email ou code d'accès invalide");

  const services = await gristAll(env, T_SERVICES);
  const myServices = services.filter((s) => s.fields.Cadre_ref === match.id);
  if (!myServices.length) {
    throw httpError(403, "Aucun service ne vous est rattaché : contactez l'administrateur");
  }

  return {
    rowId: match.id,
    fields: match.fields,
    services: myServices,
    serviceIds: new Set(myServices.map((s) => s.id)),
  };
}

/* ------------------------------------------------------------------ */
/* Lecture : payload complet pour l'étudiant                           */
/* ------------------------------------------------------------------ */

async function buildPayload(env, student) {
  const [periodes, services, codes, sorties, users, feries] = await Promise.all([
    gristFilter(env, T_PERIODES, { Code_anonymat: [student.code] }),
    gristAll(env, T_SERVICES),
    gristAll(env, T_CODES),
    gristFilter(env, T_SORTIES, { Anonymat: [student.rowId] }),
    gristAll(env, T_UTILISATEURS),
    gristAll(env, T_FERIES),
  ]);

  const serviceById = new Map(services.map((s) => [s.id, s]));
  const usersById = new Map(users.map((u) => [u.id, u]));
  const codesById = new Map(codes.map((c) => [c.id, c]));
  const periodeIds = periodes.map((p) => p.id);

  // Jours fériés (dates ISO) et ajustements des sorties par jour de période
  const feriesSet = new Set(feries.map((f) => epochToIso(f.fields.Date)).filter(Boolean));
  const sortiesByJour = new Map();
  for (const s of sorties) {
    const per = s.fields.Pour_le_stage_du_ || s.fields.Rapprochement_manuel;
    const iso = epochToIso(s.fields.Date);
    if (per && iso) {
      const key = per + "|" + iso;
      sortiesByJour.set(key, (sortiesByJour.get(key) || 0) + (s.fields.Ajustement_h || 0));
    }
  }

  const semaines = periodeIds.length
    ? await gristFilter(env, T_HEBDO, { Periode: periodeIds })
    : [];

  // Heures par jour de chaque semaine + compteurs par période :
  // - un férié travaillé (heures > 0) ouvre un jour de récupération ; poser un
  //   jour au code RF (récupération de férié) le consomme ;
  // - les jours ABS alimentent le suivi de présence (arrêté du 31/07/2009 :
  //   présence >= 80 % par stage, franchise de 30 jours sur le cursus).
  const feriesIso = [...feriesSet];
  const recuperationByPeriode = {};
  const absencesByPeriode = {};
  const joursPrevusByPeriode = {};
  const semainesData = semaines.map((s) => {
    const debut = s.fields.Semaine_debut;
    const jours = DAY_COLUMNS.map((d, i) => {
      const codeRec = codesById.get(s.fields[d]);
      const iso = debut ? epochToIso(debut + i * 86400) : null;
      const info = jourInfo(codeRec, iso, s.fields.Periode, sortiesByJour, feriesSet);
      const per = s.fields.Periode;
      const codeTxt = codeRec ? (codeRec.fields.Code || "").trim().toUpperCase() : "";
      if (info.ferie && info.heures > 0) {
        recuperationByPeriode[per] = (recuperationByPeriode[per] || 0) + 1;
      }
      if (codeTxt === "RF") {
        recuperationByPeriode[per] = (recuperationByPeriode[per] || 0) - 1;
        info.recup = true;
      }
      // Jour prévu = jour où l'étudiant devait être présent (code qui compte
      // en stage) ou a été absent ; l'absence se repère au code ABS.
      if (codeTxt === "ABS") {
        absencesByPeriode[per] = (absencesByPeriode[per] || 0) + 1;
        joursPrevusByPeriode[per] = (joursPrevusByPeriode[per] || 0) + 1;
      } else if (codeRec && codeRec.fields.Compte_stage) {
        joursPrevusByPeriode[per] = (joursPrevusByPeriode[per] || 0) + 1;
      }
      return info;
    });
    return { s, jours };
  });

  return {
    etudiant: {
      prenom: student.fields.PRENOM || "",
      nom: student.fields.NOM || "",
    },
    motifs: MOTIFS,
    periodes: periodes.map((p) => {
      // Heures à réaliser : valeur Grist si > 0 (déjà nette des fériés), sinon
      // calcul auto = 35 h/semaine moins les jours fériés (accordés à l'étudiant).
      const heuresBase = Math.max(0, HEURES_PAR_SEMAINE * nombreSemaines(p.fields.Du, p.fields.Au)
        - HEURES_PAR_SEMAINE / 5 * nombreFeries(feriesIso, p.fields.Du, p.fields.Au));
      const aFaire = p.fields.A_FAIRE > 0 ? p.fields.A_FAIRE : heuresBase;
      const fait = p.fields.FAIT ?? 0;
      const service = serviceById.get(p.fields.Service);
      return {
        id: p.id,
        Du: epochToIso(p.fields.Du),
        Au: epochToIso(p.fields.Au),
        Service: (service && service.fields.Nom) || "",
        Niveau: p.fields.Niveau || "",
        En_cours: !!p.fields.En_cours,
        A_FAIRE: aFaire,
        FAIT: fait,
        Solde_heures: Math.round((fait - aFaire) * 100) / 100,
        Recuperation: Math.max(0, recuperationByPeriode[p.id] || 0),
        Absences: absencesByPeriode[p.id] || 0,
        Presence_pct: joursPrevusByPeriode[p.id]
          ? Math.round(100 * (1 - (absencesByPeriode[p.id] || 0) / joursPrevusByPeriode[p.id]))
          : null,
        Tuteur: p.fields.Tuteur || "",
        cadre: cadreInfo(service, usersById),
      };
    }),
    // Suivi cursus : total des jours d'absence toutes périodes (franchise 30 j)
    absences_cursus: Object.values(absencesByPeriode).reduce((a, b) => a + b, 0),
    semaines: semainesData.map(({ s, jours }) => {
      const out = {
        id: s.id,
        Periode: s.fields.Periode,
        Semaine_debut: epochToIso(s.fields.Semaine_debut),
        Commentaire: s.fields.Commentaire || "",
        Total_h_semaine: s.fields.Total_h_semaine ?? null,
        jours,
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
      Commentaire: s.fields.Motif_ou_Commentaire || "",
      Periode: s.fields.Pour_le_stage_du_ || s.fields.Rapprochement_manuel || null,
      Date: epochToIso(s.fields.Date),
      Heure_debut: s.fields.Heure_debut || "",
      Heure_fin: s.fields.Heure_fin || "",
      Compte_stage: !!s.fields.Compte_stage,
      Valide: !!s.fields.Valide,
      Duree_affichee: s.fields.Duree_affichee || "",
      Duree_heures: s.fields.Duree_heures ?? 0,
      Ajustement_h: s.fields.Ajustement_h ?? 0,
    })),
  };
}

async function listServices(env) {
  const [services, users] = await Promise.all([
    gristAll(env, T_SERVICES),
    gristAll(env, T_UTILISATEURS),
  ]);
  const usersById = new Map(users.map((u) => [u.id, u]));
  return json({
    services: services
      .filter((s) => s.fields.Recoit_des_etudiant)
      .map((s) => ({ id: s.id, Nom: s.fields.Nom || "", cadre: cadreInfo(s, usersById) })),
    civilites: CIVILITES,
    formations: FORMATIONS,
    niveaux: NIVEAUX,
  });
}

/* ------------------------------------------------------------------ */
/* Espace cadre                                                        */
/* ------------------------------------------------------------------ */

/** Payload complet des services/étudiants/planning rattachés au cadre. */
async function buildCadrePayload(env, cadre) {
  const [periodesAll, students, codes, feries] = await Promise.all([
    gristAll(env, T_PERIODES),
    gristAll(env, T_ETUDIANTS),
    gristAll(env, T_CODES),
    gristAll(env, T_FERIES),
  ]);

  const periodes = periodesAll.filter((p) => cadre.serviceIds.has(p.fields.Service));
  const periodeIds = periodes.map((p) => p.id);
  const periodeIdSet = new Set(periodeIds);
  const etudiantsById = new Map(students.map((e) => [e.id, e]));
  const codesById = new Map(codes.map((c) => [c.id, c]));
  const feriesSet = new Set(feries.map((f) => epochToIso(f.fields.Date)).filter(Boolean));

  const studentIds = [...new Set(periodes.map((p) => p.fields.Etudiant).filter(Boolean))];
  const sortiesAll = studentIds.length ? await gristFilter(env, T_SORTIES, { Anonymat: studentIds }) : [];
  const sorties = sortiesAll.filter((s) => {
    const per = s.fields.Pour_le_stage_du_ || s.fields.Rapprochement_manuel;
    return periodeIdSet.has(per);
  });

  const sortiesByJour = new Map();
  for (const s of sorties) {
    const per = s.fields.Pour_le_stage_du_ || s.fields.Rapprochement_manuel;
    const iso = epochToIso(s.fields.Date);
    if (per && iso) {
      const key = per + "|" + iso;
      sortiesByJour.set(key, (sortiesByJour.get(key) || 0) + (s.fields.Ajustement_h || 0));
    }
  }

  const semaines = periodeIds.length ? await gristFilter(env, T_HEBDO, { Periode: periodeIds }) : [];
  const semainesData = semaines.map((s) => {
    const debut = s.fields.Semaine_debut;
    const jours = DAY_COLUMNS.map((d, i) => {
      const codeRec = codesById.get(s.fields[d]);
      const iso = debut ? epochToIso(debut + i * 86400) : null;
      return jourInfo(codeRec, iso, s.fields.Periode, sortiesByJour, feriesSet);
    });
    return { s, jours };
  });

  return {
    services: cadre.services.map((s) => ({ id: s.id, Nom: s.fields.Nom || "" })),
    niveaux: NIVEAUX,
    periodes: periodes.map((p) => {
      // Volontairement PAS de date de naissance ni de numéro de téléphone
      // personnel : ces données sont trop sensibles pour ce niveau de sécurité.
      const etu = etudiantsById.get(p.fields.Etudiant);
      const fait = p.fields.FAIT ?? 0;
      const aFaire = p.fields.A_FAIRE ?? 0;
      return {
        id: p.id,
        Service: p.fields.Service,
        Etudiant: {
          nom: etu ? etu.fields.NOM || "" : "",
          prenom: etu ? etu.fields.PRENOM || "" : "",
          formation: etu ? etu.fields.FORMATION || "" : "",
          centre: etu ? etu.fields.Centre_de_formation || "" : "",
          email: etu ? etu.fields.Adresse_mail || "" : "",
        },
        Du: epochToIso(p.fields.Du),
        Au: epochToIso(p.fields.Au),
        Niveau: p.fields.Niveau || "",
        Tuteur: p.fields.Tuteur || "",
        En_cours: !!p.fields.En_cours,
        A_FAIRE: aFaire,
        FAIT: fait,
        Solde_heures: Math.round((fait - aFaire) * 100) / 100,
        Lien_evaluation: p.fields.Lien_evaluation || "",
      };
    }),
    semaines: semainesData.map(({ s, jours }) => {
      const out = {
        id: s.id,
        Periode: s.fields.Periode,
        Semaine_debut: epochToIso(s.fields.Semaine_debut),
        jours,
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
      Periode: s.fields.Pour_le_stage_du_ || s.fields.Rapprochement_manuel || null,
      Motif: s.fields.Motif || "",
      Commentaire: s.fields.Motif_ou_Commentaire || "",
      Date: epochToIso(s.fields.Date),
      Heure_debut: s.fields.Heure_debut || "",
      Heure_fin: s.fields.Heure_fin || "",
      Compte_stage: !!s.fields.Compte_stage,
      Valide: !!s.fields.Valide,
      Duree_heures: s.fields.Duree_heures ?? 0,
      Ajustement_h: s.fields.Ajustement_h ?? 0,
    })),
  };
}

/** Vérifie que la période appartient à un service du cadre ; la renvoie sinon lève 403/404. */
async function ensurePeriodeInScope(env, cadre, periodeId) {
  if (!periodeId) throw httpError(403, "Aucune période rattachée");
  const rows = await gristFilter(env, T_PERIODES, { id: [periodeId] });
  if (!rows.length) throw httpError(404, "Période introuvable");
  if (!cadre.serviceIds.has(rows[0].fields.Service)) {
    throw httpError(403, "Cet étudiant n'appartient pas à l'un de vos services");
  }
  return rows[0];
}

async function validerSortie(request, env, cadre, rowId) {
  const body = await request.json().catch(() => ({}));
  if (typeof body.Valide !== "boolean") throw httpError(400, "Le champ Valide (booléen) est requis");

  const rows = await gristFilter(env, T_SORTIES, { id: [rowId] });
  if (!rows.length) throw httpError(404, "Déclaration introuvable");
  const periodeId = rows[0].fields.Pour_le_stage_du_ || rows[0].fields.Rapprochement_manuel;
  await ensurePeriodeInScope(env, cadre, periodeId);

  await gristUpdate(env, T_SORTIES, rowId, { Valide: body.Valide });
  return json({ ok: true });
}

async function updatePlanningJour(request, env, cadre, semaineId) {
  const body = await request.json().catch(() => ({}));
  const jour = String(body.jour || "");
  if (!DAY_COLUMNS.includes(jour)) throw httpError(400, "Jour invalide");
  const codeId = body.codeId === null || body.codeId === undefined ? null : Number(body.codeId);
  if (codeId !== null && !Number.isInteger(codeId)) throw httpError(400, "Code horaire invalide");

  const rows = await gristFilter(env, T_HEBDO, { id: [semaineId] });
  if (!rows.length) throw httpError(404, "Semaine introuvable");
  await ensurePeriodeInScope(env, cadre, rows[0].fields.Periode);

  if (codeId !== null) {
    const codes = await gristFilter(env, T_CODES, { id: [codeId] });
    if (!codes.length) throw httpError(400, "Code horaire introuvable");
  }

  await gristUpdate(env, T_HEBDO, semaineId, { [jour]: codeId });
  return json({ ok: true });
}

async function updatePeriode(request, env, cadre, periodeId) {
  const body = await request.json().catch(() => ({}));
  const rows = await gristFilter(env, T_PERIODES, { id: [periodeId] });
  if (!rows.length) throw httpError(404, "Période introuvable");
  if (!cadre.serviceIds.has(rows[0].fields.Service)) {
    throw httpError(403, "Cet étudiant n'appartient pas à l'un de vos services");
  }

  const fields = {};
  if (body.Tuteur !== undefined) fields.Tuteur = cleanText(body.Tuteur, 80);
  if (body.Niveau !== undefined) {
    if (!NIVEAUX.includes(body.Niveau)) throw httpError(400, "Niveau invalide");
    fields.Niveau = body.Niveau;
  }
  if (body.Du !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.Du)) throw httpError(400, "Date de début invalide");
    fields.Du = Date.parse(body.Du + "T00:00:00Z") / 1000;
  }
  if (body.Au !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.Au)) throw httpError(400, "Date de fin invalide");
    fields.Au = Date.parse(body.Au + "T00:00:00Z") / 1000;
  }
  const du = fields.Du !== undefined ? fields.Du : rows[0].fields.Du;
  const au = fields.Au !== undefined ? fields.Au : rows[0].fields.Au;
  if (typeof du === "number" && typeof au === "number" && du > au) {
    throw httpError(400, "La fin du stage doit être après le début");
  }
  if (!Object.keys(fields).length) throw httpError(400, "Aucune modification fournie");

  await gristUpdate(env, T_PERIODES, periodeId, fields);
  return json({ ok: true });
}

/** Heures comptabilisées un jour donné (réplique la formule Grist Total_h_semaine). */
function jourInfo(codeRec, dateIso, periodeId, sortiesByJour, feriesSet) {
  const ferie = dateIso ? feriesSet.has(dateIso) : false;
  let h = 0;
  if (codeRec && codeRec.fields.Compte_stage) {
    h = (codeRec.fields.Duree_heures || 0) + (codeRec.fields.Ajustement_h || 0);
  }
  if (dateIso && periodeId) h += sortiesByJour.get(periodeId + "|" + dateIso) || 0;
  // Conformité (arrêté du 31/07/2009) : un jour férié est accordé à l'étudiant.
  // Il n'est PAS compté double ; il est déduit du volume à réaliser (A_FAIRE).
  // Un férié travaillé produit donc un surplus = droit à un jour de récupération.
  return { heures: Math.round(h * 100) / 100, ferie };
}

/** Nombre de jours fériés (ISO) compris dans l'intervalle [du, au] (epoch). */
function nombreFeries(feriesIso, duEpoch, auEpoch) {
  if (typeof duEpoch !== "number" || typeof auEpoch !== "number") return 0;
  const duIso = epochToIso(duEpoch);
  const auIso = epochToIso(auEpoch);
  return feriesIso.filter((iso) => iso >= duIso && iso <= auIso).length;
}

/** Coordonnées du cadre responsable d'un service (nom, email, téléphone). */
function cadreInfo(service, usersById) {
  const ref = service && service.fields.Cadre_ref;
  const u = ref ? usersById.get(ref) : null;
  if (!u) return null;
  const nom = [u.fields.Civilite, u.fields.Nom, u.fields.Prenom]
    .map((x) => (x || "").trim()).filter(Boolean).join(" ");
  return {
    nom,
    email: u.fields.Email || "",
    telephone: u.fields.Telephone || "",
  };
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

  const dateEpoch = Date.parse(date + "T00:00:00Z") / 1000;
  const periodeId = await choisirPeriode(env, student, dateEpoch);

  const fields = {
    Anonymat: student.rowId,
    Code_anonymat: student.code,
    Motif: motif,
    Motif_ou_Commentaire: cleanText(body.Commentaire, 200),
    Date: dateEpoch,
    Heure_debut: debut,
    Heure_fin: fin,
    Compte_stage: compteStage,
  };
  // Rattache explicitement la déclaration à la période de stage, sinon la
  // formule Grist ne peut pas la rapprocher (date hors de l'intervalle, etc.).
  if (periodeId) fields.Rapprochement_manuel = periodeId;

  const data = await grist(env, "POST", `/tables/${T_SORTIES}/records`, { records: [{ fields }] });
  return json({ id: data.records[0].id }, 201);
}

/** Période à laquelle rattacher une déclaration datée de dateEpoch. */
async function choisirPeriode(env, student, dateEpoch) {
  const periodes = await gristFilter(env, T_PERIODES, { Code_anonymat: [student.code] });
  if (!periodes.length) return null;
  const DAY = 86400;
  // 1. période dont l'intervalle Du..Au contient la date
  const contient = periodes.find((p) => {
    const du = p.fields.Du, au = p.fields.Au;
    return typeof du === "number" && typeof au === "number" &&
      dateEpoch >= du && dateEpoch <= au + DAY - 1;
  });
  if (contient) return contient.id;
  // 2. période en cours
  const enCours = periodes.find((p) => p.fields.En_cours);
  if (enCours) return enCours.id;
  // 3. la plus récente
  return periodes.slice().sort((a, b) => (b.fields.Du || 0) - (a.fields.Du || 0))[0].id;
}

async function deleteSortie(env, student, rowId) {
  const rows = await gristFilter(env, T_SORTIES, { id: [rowId] });
  if (!rows.length) throw httpError(404, "Déclaration introuvable");
  if (rows[0].fields.Anonymat !== student.rowId) {
    throw httpError(403, "Cette déclaration ne vous appartient pas");
  }
  if (rows[0].fields.Valide) {
    throw httpError(403, "Cette déclaration a été validée : contactez votre encadrant pour la modifier");
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

  const duEpoch = Date.parse(du + "T00:00:00Z") / 1000;
  const auEpoch = Date.parse(au + "T00:00:00Z") / 1000;

  // Heures à réaliser = 35 h/semaine, moins les jours fériés (accordés à l'étudiant).
  const feriesIns = await gristAll(env, T_FERIES);
  const feriesInsIso = feriesIns.map((f) => epochToIso(f.fields.Date)).filter(Boolean);
  const aFaireInscription = Math.max(0,
    HEURES_PAR_SEMAINE * nombreSemaines(duEpoch, auEpoch)
    - HEURES_PAR_SEMAINE / 5 * nombreFeries(feriesInsIso, duEpoch, auEpoch));

  const createdPeriode = await grist(env, "POST", `/tables/${T_PERIODES}/records`, {
    records: [{
      fields: {
        Anonymat: studentRowId,
        Code_anonymat: code,
        Du: duEpoch,
        Au: auEpoch,
        Niveau: niveau,
        Service: serviceId,
        Tuteur: tuteur,
        A_FAIRE: aFaireInscription,
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

/** Liste des lundis (epoch) couvrant la période [du, au]. */
function lundisDeLaPeriode(du, au) {
  const DAY = 86400;
  if (typeof du !== "number" || typeof au !== "number") return [];
  // Lundi de la semaine du début de stage (getUTCDay : lundi = 1)
  const shift = (new Date(du * 1000).getUTCDay() + 6) % 7;
  let monday = du - shift * DAY;
  const lundis = [];
  while (monday <= au && lundis.length < MAX_SEMAINES_GENEREES) {
    lundis.push(monday);
    monday += 7 * DAY;
  }
  return lundis;
}

/** Nombre de semaines de stage couvertes par la période. */
function nombreSemaines(du, au) {
  return lundisDeLaPeriode(du, au).length;
}

async function genererSemaines(env, periodeId, duIso, auIso) {
  const du = Date.parse(duIso + "T00:00:00Z") / 1000;
  const au = Date.parse(auIso + "T00:00:00Z") / 1000;
  const records = lundisDeLaPeriode(du, au)
    .map((monday) => ({ fields: { Periode: periodeId, Semaine_debut: monday } }));
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

async function gristUpdate(env, table, id, fields) {
  await grist(env, "PATCH", `/tables/${table}/records`, { records: [{ id, fields }] });
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
