/**
 * © Joan Thuillier — Tous droits réservés. Voir LICENSE à la racine du dépôt.
 *
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
 * UTILISATEURS.Code_acces) : un cadre voit/modifie les services dont il est le
 * cadre principal (SERVICES.Cadre_ref), ceux où il figure en cadre secondaire
 * (SERVICES.Cadres_secondaires, liste de références) et, s'il est le CSS du pôle
 * (Pole.CSS, exposé par la formule SERVICES.Pole_CSS), tous les services du pôle.
 *   POST   /api/cadre/login    { email, code }         -> payload des services du cadre
 *   GET    /api/cadre/data                             -> payload complet (rafraîchissement)
 *   PATCH  /api/cadre/sorties/:id   { Valide }         -> valider/invalider une déclaration
 *   POST   /api/cadre/sorties  { periodeId, ... }      -> déclarer des heures pour un étudiant (en attente)
 *   PATCH  /api/cadre/planning/:semaineId { jour, codeId } -> édite une case du planning
 *   PATCH  /api/cadre/periodes/:id  { Tuteur, Niveau, Du, Au } -> édite une fiche de période
 *   PATCH  /api/cadre/profil  { Telephone }                   -> modifie son propre numéro de téléphone
 *   PATCH  /api/cadre/services/:id  { codes: [ids] }          -> codes horaires actifs du service
 *                                                                (SERVICES.Codes_horaires ; vide = tous)
 *   POST   /api/cadre/codes  { Code, Libelle, ... }           -> crée un code horaire (pas de doublon,
 *                                                                pas de suppression possible)
 *   GET    /api/cadre/periodes/:id/planning-imprimable        -> HTML du planning de stage imprimable
 *                                                                (colonne formule PERIODES_DE_STAGE.Planning_HTML)
 *   POST   /api/cadre/rdv  { periodeId, Date_rdv, ... }        -> ajoute un rendez-vous formateur/tuteur
 *   DELETE /api/cadre/rdv/:id                                  -> supprime un rendez-vous formateur
 */

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

const T_ETUDIANTS = "LISTE_DES_ETUDIANTS";
const T_PERIODES = "PERIODES_DE_STAGE";
const T_HEBDO = "PLANNING_HEBDO";
const T_CODES = "CODES_HORAIRES";
const T_SERVICES = "SERVICES";
const T_SITES = "SITES";
const T_SORTIES = "Sortie_de_stage";
const T_UTILISATEURS = "UTILISATEURS";
const T_FERIES = "JOURS_FERIES";
const T_EVALUATIONS = "EVALUATION_STAGE_ETUDIANT";
const T_RDV = "RDV_FORMATEUR";

const DAY_COLUMNS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];

const CIVILITES = ["Madame", "Monsieur"];
const FORMATIONS = ["AIDE SOIGNANT", "INFIRMIER", "AUTRE"];
const NIVEAUX = ["ESI L1", "ESI L2", "ESI L3", "M1", "M2", "Aide-Soignant"];
// Motifs proposés à l'étudiant ; « Retard » est déduit par la formule Grist
// Ajustement_h ; « Sortie de stage » compte ou non selon la case Compte_stage
const MOTIFS = ["Rattrapage", "Retard", "Sortie de stage"];

// Types de rendez-vous proposés au cadre (colonne Choice RDV_FORMATEUR.Type_de_rendez_vous).
// La colonne Grist reste un Choice libre : d'autres valeurs saisies dans Grist
// sont tolérées, ces valeurs ne sont que les propositions de l'espace cadre.
const RDV_TYPES = [
  "Mi-stage avec formateur",
  "Bilan final avec formateur",
  "Visite de stage formateur",
  "Entretien tuteur",
  "Point intermédiaire tuteur",
  "Autre",
];

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
    if (request.method === "POST" && path === "/api/cadre/sorties") {
      return creerSortiePourEtudiant(request, env, cadre);
    }
    const wm = path.match(/^\/api\/cadre\/planning\/(\d+)$/);
    if (request.method === "PATCH" && wm) {
      return updatePlanningJour(request, env, cadre, Number(wm[1]));
    }
    const pm = path.match(/^\/api\/cadre\/periodes\/(\d+)$/);
    if (request.method === "PATCH" && pm) {
      return updatePeriode(request, env, cadre, Number(pm[1]));
    }
    const im = path.match(/^\/api\/cadre\/periodes\/(\d+)\/planning-imprimable$/);
    if (request.method === "GET" && im) {
      return planningImprimable(env, cadre, Number(im[1]));
    }
    if (request.method === "POST" && path === "/api/cadre/rdv") {
      return creerRdv(request, env, cadre);
    }
    const rm = path.match(/^\/api\/cadre\/rdv\/(\d+)$/);
    if (request.method === "DELETE" && rm) {
      return supprimerRdv(env, cadre, Number(rm[1]));
    }
    if (request.method === "PATCH" && path === "/api/cadre/profil") {
      return updateProfilCadre(request, env, cadre);
    }
    const svm = path.match(/^\/api\/cadre\/services\/(\d+)$/);
    if (request.method === "PATCH" && svm) {
      return updateCodesService(request, env, cadre, Number(svm[1]));
    }
    if (request.method === "POST" && path === "/api/cadre/codes") {
      return creerCodeHoraire(request, env, cadre);
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

/** Ids contenus dans une cellule Grist de type Référence (nombre) ou Liste de références (["L", id, ...]). */
function refIds(value) {
  if (typeof value === "number" && value > 0) return [value];
  if (Array.isArray(value) && value[0] === "L") return value.slice(1).filter((id) => typeof id === "number");
  return [];
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
  if (!match.fields.Utilisateur_de_l_outil) {
    throw httpError(403, "Ce compte a été désactivé : contactez l'administrateur");
  }

  const services = await gristAll(env, T_SERVICES);
  const myServices = services.filter((s) => {
    if (!s.fields.Recoit_des_etudiant) return false;
    if (s.fields.Cadre_ref === match.id) return true;
    if (refIds(s.fields.Cadres_secondaires).includes(match.id)) return true;
    return refIds(s.fields.Pole_CSS).includes(match.id);
  });
  if (!myServices.length) {
    throw httpError(403, "Aucun service ouvert aux étudiants ne vous est rattaché : contactez l'administrateur");
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
  const [services, users, sites] = await Promise.all([
    gristAll(env, T_SERVICES),
    gristAll(env, T_UTILISATEURS),
    gristAll(env, T_SITES),
  ]);
  const usersById = new Map(users.map((u) => [u.id, u]));
  const sitesById = new Map(sites.map((s) => [s.id, s]));
  return json({
    services: services
      .filter((s) => s.fields.Recoit_des_etudiant)
      .map((s) => ({
        id: s.id,
        Nom: s.fields.Nom || "",
        Site: siteName(s, sitesById),
        cadre: cadreInfo(s, usersById),
      })),
    civilites: CIVILITES,
    formations: FORMATIONS,
    niveaux: NIVEAUX,
  });
}

/** Nom du site (table SITES) lié à un service. */
function siteName(service, sitesById) {
  const site = sitesById.get(service.fields.Site);
  return (site && site.fields.NOM) || "";
}

/* ------------------------------------------------------------------ */
/* Espace cadre                                                        */
/* ------------------------------------------------------------------ */

/** Payload complet des services/étudiants/planning rattachés au cadre. */
async function buildCadrePayload(env, cadre) {
  const [periodesAll, students, codes, feries, evaluations, servicesAll, sites, rdvsAll] = await Promise.all([
    gristAll(env, T_PERIODES),
    gristAll(env, T_ETUDIANTS),
    gristAll(env, T_CODES),
    gristAll(env, T_FERIES),
    gristAll(env, T_EVALUATIONS),
    gristAll(env, T_SERVICES),
    gristAll(env, T_SITES),
    gristAll(env, T_RDV),
  ]);

  const servicesById = new Map(servicesAll.map((s) => [s.id, s]));
  const sitesById = new Map(sites.map((s) => [s.id, s]));
  const periodes = periodesAll.filter((p) => cadre.serviceIds.has(p.fields.Service));
  // Historique : les stages de ces mêmes étudiants dans d'autres services sont
  // aussi envoyés (lecture seule côté front) pour que le cadre voie le parcours
  // complet. Planning, sorties et déclarations restent limités à ses services.
  const etudiantIds = new Set(periodes.map((p) => p.fields.Etudiant).filter(Boolean));
  const periodesAutres = periodesAll.filter((p) =>
    !cadre.serviceIds.has(p.fields.Service) && etudiantIds.has(p.fields.Etudiant));
  const periodeIds = periodes.map((p) => p.id);
  const periodeIdSet = new Set(periodeIds);
  const etudiantsById = new Map(students.map((e) => [e.id, e]));
  const codesById = new Map(codes.map((c) => [c.id, c]));
  const feriesSet = new Set(feries.map((f) => epochToIso(f.fields.Date)).filter(Boolean));
  const feriesIso = [...feriesSet];

  // Une évaluation se rattache à une période soit par sa clé (Cle_lien ==
  // PERIODES_DE_STAGE.UUID, cas normal du lien envoyé par mail), soit par la
  // référence directe Periode_de_stage (repli).
  const periodeIdByUuid = new Map(
    periodesAll.map((p) => [p.fields.UUID, p.id]).filter(([uuid]) => uuid)
  );
  const periodesAvecReponse = new Set();
  for (const e of evaluations) {
    const periodeId = (e.fields.Cle_lien && periodeIdByUuid.get(e.fields.Cle_lien))
      || e.fields.Periode_de_stage || null;
    if (periodeId) periodesAvecReponse.add(periodeId);
  }

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

  // Rendez-vous formateur/tuteur des seules périodes rattachées au cadre.
  const rdvs = rdvsAll.filter((r) => periodeIdSet.has(r.fields.Periode));

  return {
    services: cadre.services.map((s) => ({
      id: s.id,
      Nom: s.fields.Nom || "",
      Site: siteName(s, sitesById),
      // Codes horaires activés pour ce service (liste vide = tous les codes)
      Codes: refIds(s.fields.Codes_horaires),
    })),
    niveaux: NIVEAUX,
    motifs: MOTIFS,
    rdvTypes: RDV_TYPES,
    moi: {
      nom: cadreNomComplet(cadre),
      prenom: cadre.fields.Prenom || "",
      telephone: cadre.fields.Telephone || "",
    },
    feries: feriesIso,
    periodes: [...periodes, ...periodesAutres].map((p) => {
      // Volontairement PAS de date de naissance ni de numéro de téléphone
      // personnel : ces données sont trop sensibles pour ce niveau de sécurité.
      // Le code anonymat est en revanche nécessaire : c'est le cadre qui le
      // redonne à un étudiant qui l'aurait oublié.
      const etu = etudiantsById.get(p.fields.Etudiant);
      const svc = servicesById.get(p.fields.Service);
      const fait = p.fields.FAIT ?? 0;
      const aFaire = p.fields.A_FAIRE ?? 0;
      return {
        id: p.id,
        Service: p.fields.Service,
        Service_nom: (svc && svc.fields.Nom) || "",
        Etudiant: {
          id: p.fields.Etudiant,
          nom: etu ? etu.fields.NOM || "" : "",
          prenom: etu ? etu.fields.PRENOM || "" : "",
          formation: etu ? etu.fields.FORMATION || "" : "",
          centre: etu ? etu.fields.Centre_de_formation || "" : "",
          email: etu ? etu.fields.Adresse_mail || "" : "",
          anonymat: etu ? etu.fields.Anonymat || "" : "",
        },
        Du: epochToIso(p.fields.Du),
        Au: epochToIso(p.fields.Au),
        Niveau: p.fields.Niveau || "",
        Tuteur: p.fields.Tuteur || "",
        Referent_pedagogique: p.fields.Referent_pedagogique || "",
        En_cours: !!p.fields.En_cours,
        A_FAIRE: aFaire,
        FAIT: fait,
        Solde_heures: Math.round((fait - aFaire) * 100) / 100,
        Lien_evaluation: p.fields.Lien_evaluation || "",
        Evaluation_envoyee: !!p.fields.Evaluation_envoyee,
        Evaluation_repondue: periodesAvecReponse.has(p.id),
        Alertes: computeAlertesPeriode(p.id, semaines, codesById),
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
    rdvs: rdvs.map((r) => ({
      id: r.id,
      Periode: r.fields.Periode || null,
      Date_rdv: epochToIso(r.fields.Date_rdv),
      Type_de_rendez_vous: r.fields.Type_de_rendez_vous || "",
      Formateur: r.fields.Formateur || "",
      Commentaire: r.fields.Commentaire || "",
      Cree_par: r.fields.Cree_par || "",
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

/** Nom complet du cadre connecté (pour l'affichage "Imprimé par"). */
function cadreNomComplet(cadre) {
  return [cadre.fields.Civilite, cadre.fields.Nom, cadre.fields.Prenom]
    .map((x) => (x || "").trim()).filter(Boolean).join(" ");
}

/** Le cadre déclare des heures pour un étudiant de son service (reste en attente de validation). */
async function creerSortiePourEtudiant(request, env, cadre) {
  const body = await request.json().catch(() => ({}));
  const periodeId = Number(body.periodeId);
  const periode = await ensurePeriodeInScope(env, cadre, periodeId);

  const motif = String(body.Motif || "").trim().slice(0, 100);
  const date = String(body.Date || "");
  const debut = String(body.Heure_debut || "").trim();
  const fin = String(body.Heure_fin || "").trim();

  if (!MOTIFS.includes(motif)) throw httpError(400, "Motif invalide");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw httpError(400, "Date invalide");
  if (!TIME_RE.test(debut) || !TIME_RE.test(fin)) {
    throw httpError(400, "Heures invalides (format attendu : HH:MM)");
  }

  const compteStage = motif.toUpperCase() === "RETARD" ? false : body.Compte_stage !== false;
  const dateEpoch = Date.parse(date + "T00:00:00Z") / 1000;

  const fields = {
    Anonymat: periode.fields.Etudiant,
    Code_anonymat: periode.fields.Code_anonymat || "",
    Motif: motif,
    Motif_ou_Commentaire: cleanText(body.Commentaire, 200),
    Date: dateEpoch,
    Heure_debut: debut,
    Heure_fin: fin,
    Compte_stage: compteStage,
    Rapprochement_manuel: periodeId,
  };

  const data = await grist(env, "POST", `/tables/${T_SORTIES}/records`, { records: [{ fields }] });
  return json({ id: data.records[0].id }, 201);
}

/** Valide/dévalide une déclaration, et/ou en modifie le contenu (motif, date,
 * heures) tant qu'elle n'est pas validée. */
async function validerSortie(request, env, cadre, rowId) {
  const body = await request.json().catch(() => ({}));

  const rows = await gristFilter(env, T_SORTIES, { id: [rowId] });
  if (!rows.length) throw httpError(404, "Déclaration introuvable");
  const periodeId = rows[0].fields.Pour_le_stage_du_ || rows[0].fields.Rapprochement_manuel;
  await ensurePeriodeInScope(env, cadre, periodeId);

  const modifieContenu = body.Motif !== undefined || body.Commentaire !== undefined
    || body.Date !== undefined || body.Heure_debut !== undefined
    || body.Heure_fin !== undefined || body.Compte_stage !== undefined;
  if (modifieContenu && rows[0].fields.Valide) {
    throw httpError(403, "Cette déclaration est validée : dévalidez-la avant de la modifier");
  }

  const fields = {};
  if (body.Motif !== undefined) {
    const motif = String(body.Motif || "").trim().slice(0, 100);
    if (!motif) throw httpError(400, "Le motif est obligatoire");
    fields.Motif = motif;
  }
  if (body.Commentaire !== undefined) fields.Motif_ou_Commentaire = cleanText(body.Commentaire, 200);
  if (body.Date !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.Date)) throw httpError(400, "Date invalide");
    fields.Date = Date.parse(body.Date + "T00:00:00Z") / 1000;
  }
  if (body.Heure_debut !== undefined) {
    if (!TIME_RE.test(body.Heure_debut)) throw httpError(400, "Heure de début invalide (format HH:MM)");
    fields.Heure_debut = body.Heure_debut;
  }
  if (body.Heure_fin !== undefined) {
    if (!TIME_RE.test(body.Heure_fin)) throw httpError(400, "Heure de fin invalide (format HH:MM)");
    fields.Heure_fin = body.Heure_fin;
  }
  if (body.Compte_stage !== undefined) fields.Compte_stage = !!body.Compte_stage;
  if (body.Valide !== undefined) {
    if (typeof body.Valide !== "boolean") throw httpError(400, "Le champ Valide doit être un booléen");
    fields.Valide = body.Valide;
  }
  if (!Object.keys(fields).length) throw httpError(400, "Aucune modification fournie");

  await gristUpdate(env, T_SORTIES, rowId, fields);
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
  const periode = await ensurePeriodeInScope(env, cadre, rows[0].fields.Periode);

  if (codeId !== null) {
    const codes = await gristFilter(env, T_CODES, { id: [codeId] });
    if (!codes.length) throw httpError(400, "Code horaire introuvable");
    // Codes limités au service (SERVICES.Codes_horaires ; liste vide = tous)
    const service = cadre.services.find((s) => s.id === periode.fields.Service);
    const actifs = service ? refIds(service.fields.Codes_horaires) : [];
    if (actifs.length && !actifs.includes(codeId)) {
      throw httpError(400, "Ce code horaire n'est pas activé pour ce service");
    }
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

  // La fiche (tuteur/niveau/dates) d'un stage déjà terminé ne se modifie
  // plus : seul le stage en cours (En_cours, formule Grist Au >= aujourd'hui)
  // reste éditable. Evaluation_envoyee reste modifiable même après la fin.
  const modifieLaFiche = body.Tuteur !== undefined || body.Niveau !== undefined
    || body.Du !== undefined || body.Au !== undefined;
  if (modifieLaFiche && !rows[0].fields.En_cours) {
    throw httpError(403, "Ce stage est terminé : sa fiche ne peut plus être modifiée");
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
  if (body.Evaluation_envoyee !== undefined) fields.Evaluation_envoyee = !!body.Evaluation_envoyee;
  const du = fields.Du !== undefined ? fields.Du : rows[0].fields.Du;
  const au = fields.Au !== undefined ? fields.Au : rows[0].fields.Au;
  if (typeof du === "number" && typeof au === "number" && du > au) {
    throw httpError(400, "La fin du stage doit être après le début");
  }
  if (!Object.keys(fields).length) throw httpError(400, "Aucune modification fournie");

  await gristUpdate(env, T_PERIODES, periodeId, fields);
  return json({ ok: true });
}

/** Renvoie le HTML du planning de stage imprimable (colonne formule
 * PERIODES_DE_STAGE.Planning_HTML) pour une période d'un service du cadre. */
async function planningImprimable(env, cadre, periodeId) {
  const periode = await ensurePeriodeInScope(env, cadre, periodeId);
  const html = periode.fields.Planning_HTML;
  if (!html) throw httpError(404, "Le planning imprimable n'est pas disponible pour ce stage");
  return json({ html });
}

/** Le cadre ajoute un rendez-vous formateur/tuteur pour un étudiant de son service. */
async function creerRdv(request, env, cadre) {
  const body = await request.json().catch(() => ({}));
  const periodeId = Number(body.periodeId);
  const periode = await ensurePeriodeInScope(env, cadre, periodeId);

  const type = cleanText(body.Type_de_rendez_vous, 80);
  const date = String(body.Date_rdv || "");
  if (!type) throw httpError(400, "Le type de rendez-vous est obligatoire");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw httpError(400, "Date de rendez-vous invalide");

  const fields = {
    Periode: periodeId,
    Date_rdv: Date.parse(date + "T00:00:00Z") / 1000,
    Type_de_rendez_vous: type,
    Formateur: cleanText(body.Formateur, 80),
    Commentaire: cleanText(body.Commentaire, 300),
    Cree_par: cadreNomComplet(cadre),
  };

  const data = await grist(env, "POST", `/tables/${T_RDV}/records`, { records: [{ fields }] });
  return json({ id: data.records[0].id }, 201);
}

/** Le cadre supprime un rendez-vous formateur d'un étudiant de son service. */
async function supprimerRdv(env, cadre, rowId) {
  const rows = await gristFilter(env, T_RDV, { id: [rowId] });
  if (!rows.length) throw httpError(404, "Rendez-vous introuvable");
  await ensurePeriodeInScope(env, cadre, rows[0].fields.Periode);
  await grist(env, "POST", `/tables/${T_RDV}/data/delete`, [rowId]);
  return json({ ok: true });
}

/** Le cadre choisit les codes horaires actifs de son service
 * (SERVICES.Codes_horaires, liste de références ; vide = tous les codes). */
async function updateCodesService(request, env, cadre, serviceId) {
  if (!cadre.serviceIds.has(serviceId)) {
    throw httpError(403, "Ce service ne vous est pas rattaché");
  }
  const body = await request.json().catch(() => ({}));
  if (!Array.isArray(body.codes)) throw httpError(400, "Liste de codes invalide");
  const ids = [...new Set(body.codes.map(Number))];
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw httpError(400, "Liste de codes invalide");
  }
  if (ids.length) {
    const codes = await gristFilter(env, T_CODES, { id: ids });
    if (codes.length !== ids.length) throw httpError(400, "Code horaire introuvable");
  }
  await gristUpdate(env, T_SERVICES, serviceId, {
    Codes_horaires: ids.length ? ["L", ...ids] : null,
  });
  return json({ ok: true, codes: ids });
}

/** Le cadre crée un code horaire (table CODES_HORAIRES, partagée entre tous
 * les services). Doublon refusé sur le texte du Code ; aucune suppression
 * possible via l'espace cadre. Si serviceId est fourni et que le service a
 * une liste de codes explicite, le nouveau code y est ajouté. */
async function creerCodeHoraire(request, env, cadre) {
  const body = await request.json().catch(() => ({}));
  const code = cleanText(body.Code, 10).toUpperCase();
  const libelle = cleanText(body.Libelle, 80);
  const debut = String(body.Heure_debut || "").trim();
  const fin = String(body.Heure_fin || "").trim();

  if (!code) throw httpError(400, "Le code est obligatoire");
  if (!libelle) throw httpError(400, "Le libellé est obligatoire");
  // Les deux heures ensemble, ou aucune (code sans horaire type absence)
  if (!!debut !== !!fin) throw httpError(400, "Renseignez l'heure de début ET de fin, ou aucune des deux");
  if (debut && (!TIME_RE.test(debut) || !TIME_RE.test(fin))) {
    throw httpError(400, "Heures invalides (format attendu : HH:MM)");
  }

  const existants = await gristAll(env, T_CODES);
  if (existants.some((c) => (c.fields.Code || "").trim().toUpperCase() === code)) {
    throw httpError(409, `Le code « ${code} » existe déjà : reprenez-le dans la liste des codes disponibles`);
  }

  const created = await grist(env, "POST", `/tables/${T_CODES}/records`, {
    records: [{ fields: {
      Code: code,
      Libelle: libelle,
      Heure_debut: debut,
      Heure_fin: fin,
      Compte_stage: body.Compte_stage !== false,
    } }],
  });
  const newId = created.records[0].id;

  // Active le nouveau code dans le service demandé si sa liste est explicite
  // (liste vide = tous les codes : rien à faire, il est déjà inclus).
  const serviceId = Number(body.serviceId);
  if (cadre.serviceIds.has(serviceId)) {
    const service = cadre.services.find((s) => s.id === serviceId);
    const actifs = refIds(service.fields.Codes_horaires);
    if (actifs.length) {
      await gristUpdate(env, T_SERVICES, serviceId, { Codes_horaires: ["L", ...actifs, newId] });
    }
  }

  return json({ id: newId }, 201);
}

/** Le cadre modifie son propre numéro de téléphone (UTILISATEURS.Telephone). */
async function updateProfilCadre(request, env, cadre) {
  const body = await request.json().catch(() => ({}));
  if (body.Telephone === undefined) throw httpError(400, "Aucune modification fournie");
  const telephone = cleanText(body.Telephone, 30);
  await gristUpdate(env, T_UTILISATEURS, cadre.rowId, { Telephone: telephone });
  return json({ ok: true, telephone });
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

/* ------------------------------------------------------------------ */
/* Alertes de conformité au droit du travail (repos, durées)           */
/* Contrôle indicatif à partir des codes horaires posés sur le         */
/* planning ; ne remplace pas une vérification humaine.                */
/* ------------------------------------------------------------------ */

const DUREE_MAX_HEBDO = 48; // heures — Code du travail, art. L3121-20
const REPOS_MIN_QUOTIDIEN = 11; // heures entre deux postes — art. L3131-1
const REPOS_MIN_HEBDO = 35; // heures consécutives (24h + 11h) — art. L3132-2

function timeToMinutes(hhmm) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function addDaysIso(iso, n) {
  return epochToIso(Date.parse(iso + "T00:00:00Z") / 1000 + n * 86400);
}

function mondayOfIso(iso) {
  const day = new Date(iso + "T00:00:00Z").getUTCDay(); // 0 = dimanche .. 6 = samedi
  return addDaysIso(iso, day === 0 ? -6 : 1 - day);
}

function frDateShort(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function formatH(hours) {
  if (hours == null) return "0h";
  const neg = hours < 0;
  const totalMin = Math.round(Math.abs(hours) * 60);
  const hh = Math.floor(totalMin / 60);
  const mm = totalMin % 60;
  return (neg ? "-" : "") + hh + "h" + (mm ? String(mm).padStart(2, "0") : "");
}

/** Jours (ISO, triés) d'une période avec le code horaire posé ce jour-là. */
function joursDetailPeriode(periodeId, semaines, codesById) {
  const jours = [];
  for (const s of semaines) {
    if (s.fields.Periode !== periodeId) continue;
    const debut = s.fields.Semaine_debut;
    if (!debut) continue;
    DAY_COLUMNS.forEach((d, i) => {
      const codeRec = codesById.get(s.fields[d]);
      jours.push({ iso: epochToIso(debut + i * 86400), code: codeRec ? codeRec.fields : null });
    });
  }
  return jours.sort((a, b) => a.iso.localeCompare(b.iso));
}

/** Calcule les alertes de conformité d'une période : repos entre deux postes,
 *  durée hebdomadaire max, présence d'un repos hebdomadaire. */
function computeAlertesPeriode(periodeId, semaines, codesById) {
  const alertes = [];
  const jours = joursDetailPeriode(periodeId, semaines, codesById);

  // 1) Repos minimal entre deux postes travaillés consécutifs (jours calendaires successifs).
  let prev = null;
  for (const j of jours) {
    const travaille = j.code && j.code.Heure_debut && j.code.Heure_fin;
    if (travaille) {
      if (prev && addDaysIso(prev.iso, 1) === j.iso) {
        const finPrev = timeToMinutes(prev.code.Heure_fin);
        const debutPrev = timeToMinutes(prev.code.Heure_debut);
        const debutCur = timeToMinutes(j.code.Heure_debut);
        // Un code de nuit (ex. 19:00–07:00) se termine le lendemain matin :
        // on décale sa fin d'une journée avant de calculer le repos.
        const finPrevAbs = (finPrev <= debutPrev ? 24 * 60 : 0) + finPrev;
        const reposH = (24 * 60 + debutCur - finPrevAbs) / 60;
        if (reposH < REPOS_MIN_QUOTIDIEN) {
          alertes.push(`Repos insuffisant entre le ${frDateShort(prev.iso)} (fin ${prev.code.Heure_fin}) `
            + `et le ${frDateShort(j.iso)} (début ${j.code.Heure_debut}) : ${formatH(reposH)} au lieu de ${REPOS_MIN_QUOTIDIEN}h minimum.`);
        }
      }
      prev = j;
    }
  }

  // 2) Durée hebdomadaire et repos hebdomadaire (semaine calendaire lundi → dimanche).
  const heuresParSemaine = new Map();
  const joursTravaillesParSemaine = new Map();
  for (const j of jours) {
    if (!j.code) continue;
    const lundi = mondayOfIso(j.iso);
    if (j.code.Compte_stage) {
      const h = (j.code.Duree_heures || 0) + (j.code.Ajustement_h || 0);
      heuresParSemaine.set(lundi, (heuresParSemaine.get(lundi) || 0) + h);
    }
    if (j.code.Heure_debut && j.code.Heure_fin) {
      joursTravaillesParSemaine.set(lundi, (joursTravaillesParSemaine.get(lundi) || 0) + 1);
    }
  }
  for (const [lundi, heures] of heuresParSemaine) {
    if (heures > DUREE_MAX_HEBDO) {
      alertes.push(`Semaine du ${frDateShort(lundi)} : ${formatH(heures)} travaillées, `
        + `au-delà du maximum légal de ${DUREE_MAX_HEBDO}h.`);
    }
  }
  for (const [lundi, nbJours] of joursTravaillesParSemaine) {
    if (nbJours >= 7) {
      alertes.push(`Semaine du ${frDateShort(lundi)} : aucun jour de repos posé sur les 7 jours `
        + `(repos hebdomadaire de ${REPOS_MIN_HEBDO}h non garanti).`);
    }
  }

  return alertes;
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
  const referent = cleanText(p.Referent_pedagogique, 80);

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
        Referent_pedagogique: referent,
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
