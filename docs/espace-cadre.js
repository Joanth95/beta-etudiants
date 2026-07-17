/* Espace cadre — gestion des étudiants du service : planning, validations, fiches */
/* © Joan Thuillier — Tous droits réservés. Voir LICENSE à la racine du dépôt. */

const APP_VERSION = "v16"; // à incrémenter à chaque mise à jour (cf. ?v= dans espace-cadre.html)
const API = window.CONFIG.API_URL.replace(/\/$/, "");
const $ = (id) => document.getElementById(id);
const DAYS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];
const TABS = [
  { id: "declarations", label: "Déclarations à valider" },
  { id: "dossier", label: "Dossier étudiants" },
  { id: "planning", label: "Planning de service" },
  { id: "evaluation", label: "Envoi des évaluations" },
  { id: "codes", label: "Codes horaires" },
];

// Lien direct (?email=...&code=...) : permet d'ouvrir l'espace cadre déjà
// connecté, sans ressaisir les identifiants (ex. lien fourni depuis Grist).
const urlParams = new URLSearchParams(location.search);
const urlEmail = urlParams.get("email");
const urlCadreCode = urlParams.get("code");
if (urlEmail && urlCadreCode) {
  sessionStorage.setItem("cadre_email", urlEmail.trim());
  sessionStorage.setItem("cadre_code", urlCadreCode.trim());
  history.replaceState(null, "", location.pathname);
}

const state = {
  email: sessionStorage.getItem("cadre_email") || null,
  code: sessionStorage.getItem("cadre_code") || null,
  data: null, // { services, niveaux, motifs, moi, periodes, semaines, codes, sorties }
  selectedSite: null,
  selectedServiceId: null,
  activeTab: "declarations",
  dossierCategory: "cours", // 'passe' | 'cours' | 'avenir'
  dossierSubTab: {}, // studentId -> 'stages' | 'planning'
  dossierSelectedPeriode: {}, // studentId -> periodeId
  planningStart: null, // ISO date : début de la fenêtre de 30 jours affichée
  planningPaintCode: undefined, // code "armé" dans la palette (id, null = gomme, undefined = mode sélection)
  planningSel: null, // rectangle sélectionné dans la grille : { r1, c1, r2, c2 }
};

const DOSSIER_CATEGORIES = [
  { id: "cours", label: "En cours" },
  { id: "avenir", label: "À venir" },
  { id: "passe", label: "Passé" },
];

/** Classe une période par rapport à aujourd'hui : en cours, à venir ou passée. */
function periodeCategory(p) {
  if (p.En_cours) return "cours";
  const today = isoDate(new Date());
  if (p.Du && p.Du > today) return "avenir";
  return "passe";
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(state.email ? { "X-Cadre-Email": state.email, "X-Cadre-Code": state.code } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}

/* ------------------------------------------------------------------ */
/* Connexion                                                           */
/* ------------------------------------------------------------------ */

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("login-btn");
  const errEl = $("login-error");
  errEl.hidden = true;
  btn.disabled = true;
  btn.textContent = "Connexion…";
  try {
    state.email = $("login-email").value.trim();
    state.code = $("login-code").value.trim();
    state.data = await api("POST", "/api/cadre/login", { email: state.email, code: state.code });
    sessionStorage.setItem("cadre_email", state.email);
    sessionStorage.setItem("cadre_code", state.code);
    enterApp();
  } catch (err) {
    state.email = null;
    state.code = null;
    errEl.textContent = err.message;
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "Se connecter";
  }
});

$("logout-btn").addEventListener("click", () => {
  sessionStorage.clear();
  location.reload();
});

function enterApp() {
  $("login-screen").hidden = true;
  $("app-screen").hidden = false;
  render();
}

async function refresh() {
  state.data = await api("GET", "/api/cadre/data");
  render();
}

/* ------------------------------------------------------------------ */
/* Rendu général                                                       */
/* ------------------------------------------------------------------ */

function render() {
  renderMoiInfo();
  renderServiceSelect();
  renderMainTabs();
  renderActiveTab();
}

let moiEditing = false;

function renderMoiInfo() {
  const moi = state.data.moi || {};
  const el = $("moi-info");
  if (moiEditing) {
    el.innerHTML = `
      <span class="moi-nom">${escapeHtml(moi.nom || "")}</span>
      <input type="tel" id="moi-tel-input" value="${escapeHtml(moi.telephone || "")}" placeholder="Numéro de téléphone" maxlength="30">
      <button type="button" class="btn btn-primary btn-small" id="moi-save-btn">Enregistrer</button>
      <button type="button" class="btn btn-ghost btn-small" id="moi-cancel-btn">Annuler</button>
      <span id="moi-error" class="error" hidden></span>
    `;
    $("moi-cancel-btn").addEventListener("click", () => { moiEditing = false; renderMoiInfo(); });
    $("moi-save-btn").addEventListener("click", async () => {
      const btn = $("moi-save-btn");
      const errEl = $("moi-error");
      errEl.hidden = true;
      btn.disabled = true;
      try {
        const telephone = $("moi-tel-input").value.trim();
        await api("PATCH", "/api/cadre/profil", { Telephone: telephone });
        state.data.moi.telephone = telephone;
        moiEditing = false;
        renderMoiInfo();
      } catch (err) {
        errEl.textContent = err.message;
        errEl.hidden = false;
        btn.disabled = false;
      }
    });
  } else {
    el.innerHTML = `
      <span class="moi-nom">${escapeHtml(moi.nom || "")}</span>
      <span class="moi-tel">${moi.telephone ? escapeHtml(moi.telephone) : "Aucun numéro de téléphone renseigné"}</span>
      <button type="button" class="btn btn-ghost btn-small" id="moi-edit-btn">Modifier le numéro</button>
    `;
    $("moi-edit-btn").addEventListener("click", () => { moiEditing = true; renderMoiInfo(); });
  }
}

function updateServiceSubtitle() {
  const service = state.data.services.find((s) => s.id === state.selectedServiceId);
  const subtitle = $("service-subtitle");
  if (subtitle && service) {
    subtitle.textContent = escapeHtml(service.Nom);
  }
}

function renderServiceSelect() {
  const siteSel = $("site-select");
  const siteWrap = $("cadre-site-select");
  const allServices = state.data.services;
  const sites = [...new Set(allServices.map((s) => s.Site || "Autre"))].sort((a, b) => a.localeCompare(b, "fr"));

  if (!sites.includes(state.selectedSite)) {
    const current = allServices.find((s) => s.id === state.selectedServiceId);
    state.selectedSite = (current && (current.Site || "Autre")) || sites[0] || null;
  }
  siteSel.innerHTML = sites.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");
  siteSel.value = state.selectedSite;
  siteWrap.hidden = sites.length <= 1;
  siteSel.onchange = () => {
    state.selectedSite = siteSel.value;
    state.selectedServiceId = null; // force la sélection du premier service du site choisi
    renderServiceOptions();
    updateServiceSubtitle();
    renderActiveTab();
  };

  renderServiceOptions();
  updateServiceSubtitle();
}

function renderServiceOptions() {
  const sel = $("service-select");
  const services = state.data.services.filter((s) => (s.Site || "Autre") === state.selectedSite);
  if (!services.some((s) => s.id === state.selectedServiceId)) {
    state.selectedServiceId = services[0] ? services[0].id : null;
  }
  sel.innerHTML = services.map((s) => `<option value="${s.id}">${escapeHtml(s.Nom)}</option>`).join("");
  sel.value = state.selectedServiceId;
  sel.onchange = () => {
    state.selectedServiceId = Number(sel.value);
    updateServiceSubtitle();
    renderActiveTab();
  };
}

function periodesDuService() {
  return state.data.periodes.filter((p) => p.Service === state.selectedServiceId);
}

/** Codes horaires proposés pour le service sélectionné (SERVICES.Codes ;
 *  liste vide = tous les codes). */
function codesDuService() {
  const service = state.data.services.find((s) => s.id === state.selectedServiceId);
  const actifs = service && Array.isArray(service.Codes) ? service.Codes : [];
  if (!actifs.length) return state.data.codes;
  return state.data.codes.filter((c) => actifs.includes(c.id));
}

/** Codes à proposer dans une liste déroulante : ceux du service, plus le code
 *  déjà posé sur la case s'il n'y figure pas (pour ne pas le perdre à l'écran). */
function codesPourSelect(currentCodeId) {
  const codes = codesDuService();
  if (currentCodeId && !codes.some((c) => c.id === currentCodeId)) {
    const cur = state.data.codes.find((c) => c.id === currentCodeId);
    if (cur) return [...codes, cur];
  }
  return codes;
}

/** Regroupe par étudiant les périodes du service appartenant à une catégorie
 *  donnée ('passe' | 'cours' | 'avenir'). Sans catégorie, prend tout. */
function studentsDuService(category) {
  const map = new Map();
  for (const p of periodesDuService()) {
    if (category && periodeCategory(p) !== category) continue;
    const id = p.Etudiant.id;
    if (!map.has(id)) map.set(id, { id, etudiant: p.Etudiant, periodes: [] });
    map.get(id).periodes.push(p);
  }
  return [...map.values()].sort((a, b) =>
    `${a.etudiant.nom}${a.etudiant.prenom}`.localeCompare(`${b.etudiant.nom}${b.etudiant.prenom}`));
}

function renderMainTabs() {
  const bar = $("main-tabs");
  bar.innerHTML = "";
  for (const tab of TABS) {
    const btn = el("button", "main-tab" + (state.activeTab === tab.id ? " active" : ""), tab.label);
    btn.type = "button";
    btn.addEventListener("click", () => {
      state.activeTab = tab.id;
      renderMainTabs();
      renderActiveTab();
    });
    bar.appendChild(btn);
  }
}

function renderActiveTab() {
  $("tab-declarations").hidden = state.activeTab !== "declarations";
  $("tab-dossier").hidden = state.activeTab !== "dossier";
  $("tab-planning").hidden = state.activeTab !== "planning";
  $("tab-evaluation").hidden = state.activeTab !== "evaluation";
  $("tab-codes").hidden = state.activeTab !== "codes";
  if (state.activeTab === "declarations") renderDeclarationsTab();
  if (state.activeTab === "dossier") renderDossierTab();
  if (state.activeTab === "planning") renderPlanningTab();
  if (state.activeTab === "evaluation") renderEvaluationTab();
  if (state.activeTab === "codes") renderCodesTab();
}

/* ------------------------------------------------------------------ */
/* Onglet Déclarations à valider (en attente + validées)               */
/* ------------------------------------------------------------------ */

function renderDeclarationsTab() {
  // Seuls les stages EN COURS apparaissent ici ; les stages terminés ne sont
  // plus à traiter (leurs déclarations restent visibles dans le dossier
  // étudiant, onglet Planning personnel).
  const periodeIds = new Set(periodesDuService().filter((p) => p.En_cours).map((p) => p.id));
  const periodesById = new Map(state.data.periodes.map((p) => [p.id, p]));
  const sorties = state.data.sorties.filter((s) => periodeIds.has(s.Periode));
  const pending = sorties.filter((s) => !s.Valide).sort((a, b) => (a.Date || "").localeCompare(b.Date || ""));
  const valid = sorties.filter((s) => s.Valide).sort((a, b) => (b.Date || "").localeCompare(a.Date || ""));

  $("declarations-pending-count").textContent = pending.length;
  $("declarations-valid-count").textContent = valid.length;

  renderSortieActionList($("declarations-pending"), pending, periodesById, false);
  renderSortieActionList($("declarations-valid"), valid, periodesById, true);
}

function renderSortieActionList(container, list, periodesById, isValid) {
  container.innerHTML = "";
  if (!list.length) {
    container.appendChild(el("p", "empty",
      isValid ? "Aucune déclaration validée pour ce service." : "Aucune déclaration en attente pour ce service."));
    return;
  }

  for (const s of list) {
    const p = periodesById.get(s.Periode);
    const row = el("div", "pending-row " + (isValid ? "row-valid" : "row-pending"));
    const main = el("div", "pending-main");
    const nomEtu = p ? `${p.Etudiant.prenom} ${p.Etudiant.nom}`.trim() : "";
    const titleText = s.Commentaire ? `${s.Motif} — ${s.Commentaire}` : s.Motif;
    main.appendChild(el("div", "sortie-title", `${nomEtu} · ${titleText}`));
    main.appendChild(el("div", "sortie-meta",
      `${frDate(s.Date)} · ${s.Heure_debut || "?"} – ${s.Heure_fin || "?"} · ${formatH(s.Duree_heures)}`));
    row.appendChild(main);

    const actions = el("div", "");
    actions.style.display = "flex";
    actions.style.gap = "0.4rem";

    if (!isValid) {
      const editBtn = el("button", "btn btn-ghost", "Modifier");
      editBtn.type = "button";
      editBtn.addEventListener("click", () => openEditDeclarationDialog(s));
      actions.appendChild(editBtn);
    }

    const btn = el("button", isValid ? "btn btn-ghost" : "btn btn-primary", isValid ? "Dévalider" : "Valider");
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await api("PATCH", `/api/cadre/sorties/${s.id}`, { Valide: !isValid });
        await refresh();
      } catch (err) {
        alert(err.message);
        btn.disabled = false;
      }
    });
    actions.appendChild(btn);
    row.appendChild(actions);
    container.appendChild(row);
  }
}

/* ------------------------------------------------------------------ */
/* Dialogue : modifier une déclaration en attente (motif, date, heures) */
/* ------------------------------------------------------------------ */

const editSortieDialog = $("edit-sortie-dialog");
let editingSortieId = null;

function openEditDeclarationDialog(s) {
  editingSortieId = s.id;
  $("edit-sortie-motif").value = s.Motif || "";
  $("edit-sortie-commentaire").value = s.Commentaire || "";
  $("edit-sortie-date").value = s.Date || "";
  $("edit-sortie-debut").value = s.Heure_debut || "";
  $("edit-sortie-fin").value = s.Heure_fin || "";
  $("edit-sortie-compte").checked = s.Compte_stage !== false;
  $("edit-sortie-error").hidden = true;
  editSortieDialog.showModal();
}

$("edit-sortie-cancel-btn").addEventListener("click", () => editSortieDialog.close());

$("edit-sortie-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = $("edit-sortie-error");
  errEl.hidden = true;

  const body = {
    Motif: $("edit-sortie-motif").value.trim(),
    Commentaire: $("edit-sortie-commentaire").value.trim(),
    Date: $("edit-sortie-date").value,
    Heure_debut: $("edit-sortie-debut").value,
    Heure_fin: $("edit-sortie-fin").value,
    Compte_stage: $("edit-sortie-compte").checked,
  };

  const btn = $("edit-sortie-save-btn");
  btn.disabled = true;
  try {
    await api("PATCH", `/api/cadre/sorties/${editingSortieId}`, body);
    editSortieDialog.close();
    await refresh();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

/* ------------------------------------------------------------------ */
/* Onglet Dossier étudiants                                            */
/* ------------------------------------------------------------------ */

/** Sous-onglets de classement des dossiers : Passé / En cours / À venir. */
function renderDossierCategoryTabs() {
  const bar = $("dossier-category-tabs");
  bar.innerHTML = "";
  for (const c of DOSSIER_CATEGORIES) {
    const btn = el("button", "sub-tab" + (state.dossierCategory === c.id ? " active" : ""), c.label);
    btn.type = "button";
    btn.addEventListener("click", () => {
      state.dossierCategory = c.id;
      renderDossierTab();
    });
    bar.appendChild(btn);
  }
}

function renderDossierTab() {
  renderDossierCategoryTabs();

  const container = $("dossier-list");
  container.innerHTML = "";
  const students = studentsDuService(state.dossierCategory);

  if (!students.length) {
    const label = { cours: "en cours", avenir: "à venir", passe: "passé" }[state.dossierCategory];
    container.appendChild(el("p", "empty", `Aucun étudiant avec un stage ${label} sur ce service.`));
    return;
  }

  for (const st of students) {
    const card = el("div", "etu-card");

    const header = el("div", "etu-header");
    const left = el("div", "");
    left.appendChild(el("span", "etu-nom", `${st.etudiant.prenom} ${st.etudiant.nom}`.trim()));
    if (st.etudiant.anonymat) {
      left.append(document.createTextNode(" "));
      left.appendChild(el("span", "anonymat-badge", st.etudiant.anonymat));
    }
    const datesText = [...st.periodes]
      .sort((a, b) => (b.Du || "").localeCompare(a.Du || ""))
      .map((p) => `${frDate(p.Du)} → ${frDate(p.Au)}`)
      .join(" · ");
    left.appendChild(el("div", "etu-dates", datesText));
    header.appendChild(left);
    const metaParts = [st.etudiant.formation, st.etudiant.centre].filter(Boolean);
    if (metaParts.length) header.appendChild(el("div", "etu-meta", metaParts.join(" · ")));
    card.appendChild(header);

    // Historique complet : toutes les périodes de l'étudiant visibles par le
    // cadre (tous ses services confondus), pas seulement celles de la
    // catégorie affichée.
    const allPeriodes = state.data.periodes.filter((p) => p.Etudiant.id === st.id);

    const subTabs = el("div", "sub-tabs");
    const current = state.dossierSubTab[st.id] || "stages";
    const subTabDefs = [
      { id: "stages", label: `Historique des stages (${allPeriodes.length})` },
      { id: "planning", label: "Planning personnel" },
    ];
    for (const t of subTabDefs) {
      const btn = el("button", "sub-tab" + (current === t.id ? " active" : ""), t.label);
      btn.type = "button";
      btn.addEventListener("click", () => {
        state.dossierSubTab[st.id] = t.id;
        renderDossierTab();
      });
      subTabs.appendChild(btn);
    }
    card.appendChild(subTabs);

    card.appendChild(current === "stages" ? renderStagesFaits(allPeriodes) : renderPlanningPersonnel(st));

    container.appendChild(card);
  }
}

/** Sous-onglet "Historique des stages" : toutes les périodes de l'étudiant
 *  visibles par le cadre, du plus récent au plus ancien ; seul le stage en
 *  cours reste éditable, les autres s'affichent en lecture seule. */
function renderStagesFaits(allPeriodes) {
  const wrap = el("div", "");
  const periodes = [...allPeriodes].sort((a, b) => (b.Du || "").localeCompare(a.Du || ""));
  for (const p of periodes) {
    const cat = periodeCategory(p);
    const item = el("div", `stage-item stage-${cat}`);

    const header = el("div", "stage-item-header");
    const service = state.data.services.find((s) => s.id === p.Service);
    header.appendChild(el("span", "stage-service",
      p.Service_nom || (service ? service.Nom : "Service inconnu")));
    header.appendChild(el("span", "stage-dates", `${frDate(p.Du)} → ${frDate(p.Au)}`));
    header.appendChild(badge(
      { cours: "En cours", avenir: "À venir", passe: "Terminé" }[cat],
      { cours: "info", avenir: "pending", passe: "neutral" }[cat]));
    item.appendChild(header);

    // La fiche n'est éditable que pour un stage en cours dans l'un de MES
    // services ; les stages des autres services sont en lecture seule.
    const monService = state.data.services.some((s) => s.id === p.Service);
    const editable = p.En_cours && monService;

    const infoParts = [];
    if (!editable && p.Niveau) infoParts.push(p.Niveau);
    if (p.Referent_pedagogique) infoParts.push(`Référent pédagogique : ${p.Referent_pedagogique}`);
    if (!editable && p.Tuteur) infoParts.push(`Tuteur : ${p.Tuteur}`);
    infoParts.push(`${formatH(p.FAIT)} effectuées / ${formatH(p.A_FAIRE)} à réaliser`);
    infoParts.push(`Solde ${p.Solde_heures > 0 ? "+" : ""}${formatH(p.Solde_heures)}`);
    item.appendChild(el("div", "etu-meta", infoParts.join(" · ")));

    if (editable) {
      item.appendChild(renderFiche(p));
    } else if (!monService) {
      item.appendChild(el("p", "save-hint", "Stage suivi par un autre service : fiche non modifiable ici."));
    } else if (cat === "passe") {
      item.appendChild(el("p", "save-hint", "Stage terminé : la fiche n'est plus modifiable."));
    }
    wrap.appendChild(item);
  }
  return wrap;
}

function renderFiche(p) {
  const wrap = el("div", "etu-fiche");

  const tuteurLabel = el("label", "", "Tuteur");
  const tuteurInput = document.createElement("input");
  tuteurInput.type = "text";
  tuteurInput.value = p.Tuteur || "";
  tuteurLabel.appendChild(tuteurInput);

  const niveauLabel = el("label", "", "Niveau");
  const niveauSelect = document.createElement("select");
  niveauSelect.innerHTML = state.data.niveaux.map((n) =>
    `<option value="${n}" ${n === p.Niveau ? "selected" : ""}>${n}</option>`).join("");
  niveauLabel.appendChild(niveauSelect);

  const duLabel = el("label", "", "Du");
  const duInput = document.createElement("input");
  duInput.type = "date";
  duInput.value = p.Du || "";
  duLabel.appendChild(duInput);

  const auLabel = el("label", "", "Au");
  const auInput = document.createElement("input");
  auInput.type = "date";
  auInput.value = p.Au || "";
  auLabel.appendChild(auInput);

  const saveBtn = el("button", "btn btn-ghost", "Enregistrer la fiche");
  saveBtn.type = "button";

  wrap.append(tuteurLabel, niveauLabel, duLabel, auLabel, saveBtn);

  const hint = el("p", "save-hint", "");

  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    hint.textContent = "";
    try {
      await api("PATCH", `/api/cadre/periodes/${p.id}`, {
        Tuteur: tuteurInput.value,
        Niveau: niveauSelect.value,
        Du: duInput.value,
        Au: auInput.value,
      });
      hint.textContent = "Enregistré.";
      await refresh();
    } catch (err) {
      hint.textContent = err.message;
    } finally {
      saveBtn.disabled = false;
    }
  });

  const container = el("div", "");
  container.append(wrap, hint);
  return container;
}

/** Sous-onglet "Planning personnel" : sélecteur de période (si plusieurs), planning, déclarations, bouton +Déclarer. */
function renderPlanningPersonnel(st) {
  const wrap = el("div", "");
  const periodes = [...st.periodes].sort((a, b) => (b.Du || "").localeCompare(a.Du || ""));

  let selectedId = state.dossierSelectedPeriode[st.id];
  if (!periodes.some((p) => p.id === selectedId)) {
    selectedId = (periodes.find((p) => p.En_cours) || periodes[0]).id;
    state.dossierSelectedPeriode[st.id] = selectedId;
  }

  if (periodes.length > 1) {
    const sel = document.createElement("select");
    sel.innerHTML = periodes.map((p) =>
      `<option value="${p.id}" ${p.id === selectedId ? "selected" : ""}>${frDate(p.Du)} → ${frDate(p.Au)}</option>`).join("");
    sel.addEventListener("change", () => {
      state.dossierSelectedPeriode[st.id] = Number(sel.value);
      renderDossierTab();
    });
    wrap.appendChild(sel);
  }

  const p = periodes.find((x) => x.id === selectedId);
  wrap.appendChild(renderMiniPlanning(p));

  const declareBtn = el("button", "btn btn-primary", "+ Déclarer");
  declareBtn.type = "button";
  declareBtn.style.marginTop = "0.6rem";
  declareBtn.addEventListener("click", () => openSortieDialog(periodes, selectedId));
  wrap.appendChild(declareBtn);

  wrap.appendChild(renderSortiesList(p));
  return wrap;
}

/** Tableau du planning d'une seule période : une ligne par semaine. */
function renderMiniPlanning(p) {
  const weeks = state.data.semaines
    .filter((s) => s.Periode === p.id)
    .sort((a, b) => (a.Semaine_debut || "").localeCompare(b.Semaine_debut || ""));

  if (!weeks.length) return el("p", "empty", "Planning non encore établi.");

  const table = document.createElement("table");
  table.className = "mini-planning";
  const thead = document.createElement("thead");
  thead.innerHTML = "<tr><th>Semaine</th>" + DAYS.map((d) => `<th>${d.slice(0, 3)}</th>`).join("") + "</tr>";
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const week of weeks) {
    const tr = document.createElement("tr");
    tr.appendChild(el("th", "", frDate(week.Semaine_debut)));
    DAYS.forEach((day) => {
      tr.appendChild(codeCell(week.id, day, week[day] || null));
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

/** Liste (lecture seule) des déclarations d'une période. */
function renderSortiesList(p) {
  const wrap = el("div", "");
  wrap.style.marginTop = "0.75rem";
  const sorties = state.data.sorties.filter((s) => s.Periode === p.id)
    .sort((a, b) => (b.Date || "").localeCompare(a.Date || ""));

  if (!sorties.length) {
    wrap.appendChild(el("p", "empty", "Aucune déclaration pour cette période."));
    return wrap;
  }

  for (const s of sorties) {
    const row = el("div", "pending-row");
    const main = el("div", "pending-main");
    const titleText = s.Commentaire ? `${s.Motif} — ${s.Commentaire}` : s.Motif;
    const title = el("div", "sortie-title", titleText);
    title.appendChild(badge(s.Valide ? "Validé" : "En attente", s.Valide ? "ok" : "pending"));
    main.appendChild(title);
    main.appendChild(el("div", "sortie-meta",
      `${frDate(s.Date)} · ${s.Heure_debut || "?"} – ${s.Heure_fin || "?"} · ${formatH(s.Duree_heures)}`));
    row.appendChild(main);
    wrap.appendChild(row);
  }
  return wrap;
}

/* ------------------------------------------------------------------ */
/* Dialogue : déclarer des heures pour un étudiant                    */
/* ------------------------------------------------------------------ */

const sortieDialog = $("sortie-dialog");
let sortieDialogPeriodes = [];

function openSortieDialog(periodes, defaultPeriodeId) {
  sortieDialogPeriodes = periodes;
  const wrap = $("sortie-periode-wrap");
  if (periodes.length > 1) {
    wrap.hidden = false;
    $("sortie-periode").innerHTML = periodes.map((p) =>
      `<option value="${p.id}" ${p.id === defaultPeriodeId ? "selected" : ""}>${frDate(p.Du)} → ${frDate(p.Au)}</option>`).join("");
  } else {
    wrap.hidden = true;
  }
  document.querySelector('input[name="sortie-type"][value="Rattrapage"]').checked = true;
  $("sortie-motif-texte").value = "";
  $("sortie-compte").checked = true;
  $("sortie-date").value = isoDate(new Date());
  $("sortie-debut").value = "";
  $("sortie-fin").value = "";
  $("sortie-error").hidden = true;
  syncSortieTypeUI();
  sortieDialog.showModal();
}

function selectedSortieType() {
  return document.querySelector('input[name="sortie-type"]:checked').value;
}

function syncSortieTypeUI() {
  $("sortie-compte-wrap").hidden = selectedSortieType() !== "Sortie de stage";
}

for (const radio of document.querySelectorAll('input[name="sortie-type"]')) {
  radio.addEventListener("change", syncSortieTypeUI);
}

$("sortie-cancel-btn").addEventListener("click", () => sortieDialog.close());

$("sortie-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = $("sortie-error");
  errEl.hidden = true;

  const type = selectedSortieType();
  let compte = true;
  if (type === "Retard") compte = false;
  if (type === "Sortie de stage") compte = $("sortie-compte").checked;

  const periodeId = sortieDialogPeriodes.length > 1
    ? Number($("sortie-periode").value)
    : sortieDialogPeriodes[0].id;

  const body = {
    periodeId,
    Motif: type,
    Commentaire: $("sortie-motif-texte").value.trim(),
    Date: $("sortie-date").value,
    Heure_debut: $("sortie-debut").value,
    Heure_fin: $("sortie-fin").value,
    Compte_stage: compte,
  };

  const btn = $("sortie-save-btn");
  btn.disabled = true;
  try {
    await api("POST", "/api/cadre/sorties", body);
    sortieDialog.close();
    await refresh();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

/* ------------------------------------------------------------------ */
/* Onglet Planning de service (grille 30 jours + impression)          */
/* Édition façon tableur : palette de codes à "peindre", sélection à  */
/* la souris, copier-coller (Ctrl+C / Ctrl+V), Suppr pour effacer.    */
/* ------------------------------------------------------------------ */

// Grille courante : rows[r].cells[c] = { td, semaineId, jour, codeId } ou null
// (case hors période / sans semaine générée, non éditable).
let planningGrid = null;
let planningCodeById = new Map();
let planningDrag = null; // 'paint' | 'select' | null pendant un glisser
const planningPendingPaint = new Map(); // "semaineId|jour" -> changement à envoyer
let planningClipboard = null; // tableau 2D de codeId copiés
let planningStatusEl = null;

function renderPlanningTab() {
  const container = $("planning-service");
  container.innerHTML = "";

  const controls = el("div", "planning-controls");
  const dateInput = document.createElement("input");
  dateInput.type = "date";
  dateInput.value = state.planningStart || isoDate(new Date());
  dateInput.addEventListener("change", () => {
    state.planningStart = dateInput.value;
    renderPlanningTab();
  });
  const todayBtn = el("button", "btn btn-ghost", "Aujourd'hui");
  todayBtn.type = "button";
  todayBtn.addEventListener("click", () => { state.planningStart = isoDate(new Date()); renderPlanningTab(); });
  const prevBtn = el("button", "btn btn-ghost", "◀ Préc. 30j");
  prevBtn.type = "button";
  prevBtn.addEventListener("click", () => shiftWindow(-30));
  const nextBtn = el("button", "btn btn-ghost", "Suiv. 30j ▶");
  nextBtn.type = "button";
  nextBtn.addEventListener("click", () => shiftWindow(30));
  const printBtn = el("button", "btn btn-primary", "🖨 Imprimer");
  printBtn.type = "button";
  printBtn.addEventListener("click", () => window.print());
  controls.append(dateInput, todayBtn, prevBtn, nextBtn, printBtn);
  container.appendChild(controls);

  const startKey = state.planningStart || isoDate(new Date());
  const days = [];
  for (let i = 0; i < 30; i++) days.push(addDaysIso(startKey, i));
  const endKey = days[days.length - 1];

  updatePrintHeader(startKey, endKey);

  const periodes = periodesDuService()
    .filter((p) => !(p.Au && p.Au < startKey) && !(p.Du && p.Du > endKey))
    .sort((a, b) => `${a.Etudiant.nom}${a.Etudiant.prenom}`.localeCompare(`${b.Etudiant.nom}${b.Etudiant.prenom}`));

  if (!periodes.length) {
    container.appendChild(el("p", "empty", "Aucun étudiant sur ce service pour cette période."));
    return;
  }

  const feriesSet = new Set(state.data.feries || []);
  const isJourOff = (dk) => isWeekendIso(dk) || feriesSet.has(dk);

  planningCodeById = new Map(state.data.codes.map((c) => [c.id, c]));
  container.appendChild(renderCodePalette());

  const table = document.createElement("table");
  table.className = "service-planning" + (state.planningPaintCode !== undefined ? " painting" : "");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  headRow.appendChild(el("th", "student-col", "Étudiant"));
  for (const dk of days) {
    headRow.appendChild(el("th", isJourOff(dk) ? "jour-off" : "", dayNum(dk)));
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  planningGrid = { rows: [] };
  const tbody = document.createElement("tbody");
  periodes.forEach((p, r) => {
    const dayMap = buildDayMap(p.id);
    const tr = document.createElement("tr");
    const th = el("th", "student-col");
    th.appendChild(el("div", "", `${p.Etudiant.prenom} ${p.Etudiant.nom}`.trim()));
    th.appendChild(el("div", "etu-meta-small", `${frDateCourt(p.Du)} → ${frDateCourt(p.Au)}`));
    th.appendChild(el("div", "etu-meta-small", [p.Niveau, p.Tuteur].filter(Boolean).join(" · ")));
    tr.appendChild(th);

    const cells = [];
    days.forEach((dk, c) => {
      const off = isJourOff(dk);
      if ((p.Du && dk < p.Du) || (p.Au && dk > p.Au)) {
        tr.appendChild(el("td", "hors-periode" + (off ? " jour-off" : ""), ""));
        cells.push(null);
        return;
      }
      const entry = dayMap.get(dk);
      if (!entry) {
        tr.appendChild(el("td", off ? "jour-off" : "", "—"));
        cells.push(null);
        return;
      }
      const td = el("td", "code-cell" + (off ? " jour-off" : ""));
      const code = planningCodeById.get(entry.codeId);
      td.textContent = code ? code.Code : "—";
      if (code) td.title = code.Libelle;
      td.dataset.r = r;
      td.dataset.c = c;
      tr.appendChild(td);
      cells.push({ td, semaineId: entry.semaineId, jour: entry.jour, codeId: entry.codeId });
    });
    planningGrid.rows.push({ cells });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  table.addEventListener("mousedown", onPlanningMouseDown);
  table.addEventListener("mouseover", onPlanningMouseOver);
  table.addEventListener("dblclick", onPlanningDblClick);

  container.appendChild(table);
  container.appendChild(renderCodesLegend());
  updateSelHighlight();
}

/** Palette : un chip par code à "peindre", plus le mode Sélection et la gomme. */
function renderCodePalette() {
  const wrap = el("div", "code-palette");
  const mkChip = (label, value, title) => {
    const btn = el("button", "sub-tab" + (state.planningPaintCode === value ? " active" : ""), label);
    btn.type = "button";
    if (title) btn.title = title;
    btn.addEventListener("click", () => {
      state.planningPaintCode = value;
      renderPlanningTab();
    });
    return btn;
  };
  wrap.appendChild(mkChip("🖱 Sélection", undefined, "Sélectionner des cases pour copier-coller"));
  for (const c of codesDuService()) {
    const horaire = (c.Heure_debut && c.Heure_fin) ? ` (${c.Heure_debut}–${c.Heure_fin})` : "";
    wrap.appendChild(mkChip(c.Code, c.id, `${c.Libelle}${horaire}`));
  }
  wrap.appendChild(mkChip("Gomme", null, "Effacer les cases cliquées"));

  const hint = el("p", "palette-hint",
    state.planningPaintCode !== undefined
      ? "Cliquez ou glissez sur les cases pour appliquer ce code. "
      : "Glissez (ou Maj+clic) pour sélectionner · Ctrl+C copier · Ctrl+V coller · Suppr effacer · double-clic : liste des codes. ");
  planningStatusEl = el("span", "palette-status", "");
  hint.appendChild(planningStatusEl);
  wrap.appendChild(hint);
  return wrap;
}

function planningCellFromEvent(e) {
  if (e.target.tagName === "SELECT") return null;
  const td = e.target.closest("td.code-cell");
  if (!td || td.dataset.r === undefined) return null;
  return { r: Number(td.dataset.r), c: Number(td.dataset.c) };
}

function onPlanningMouseDown(e) {
  if (e.button !== 0) return;
  const pos = planningCellFromEvent(e);
  if (!pos) return;
  e.preventDefault();
  if (state.planningPaintCode !== undefined) {
    planningDrag = "paint";
    paintCellAt(pos.r, pos.c);
  } else {
    planningDrag = "select";
    if (e.shiftKey && state.planningSel) {
      state.planningSel.r2 = pos.r;
      state.planningSel.c2 = pos.c;
    } else {
      state.planningSel = { r1: pos.r, c1: pos.c, r2: pos.r, c2: pos.c };
    }
    updateSelHighlight();
  }
}

function onPlanningMouseOver(e) {
  if (!(e.buttons & 1)) return; // bouton gauche relâché : pas un glisser
  const pos = planningCellFromEvent(e);
  if (!pos) return;
  if (state.planningPaintCode !== undefined) {
    planningDrag = "paint"; // garantit l'envoi au mouseup même si le mousedown a été manqué
    paintCellAt(pos.r, pos.c);
  } else if (state.planningSel) {
    state.planningSel.r2 = pos.r;
    state.planningSel.c2 = pos.c;
    updateSelHighlight();
  }
}

document.addEventListener("mouseup", () => {
  if (planningDrag === "paint") commitPendingPaint();
  planningDrag = null;
});

function onPlanningDblClick(e) {
  if (state.planningPaintCode !== undefined) return;
  const pos = planningCellFromEvent(e);
  if (!pos) return;
  openPlanningCellEditor(planningGrid.rows[pos.r].cells[pos.c]);
}

/** Applique le code "armé" à la case (r, c) ; l'envoi est différé au mouseup. */
function paintCellAt(r, c) {
  const cell = planningGrid && planningGrid.rows[r] && planningGrid.rows[r].cells[c];
  if (!cell) return;
  const codeId = state.planningPaintCode; // null = effacer
  if (cell.codeId === codeId) return;
  cell.codeId = codeId;
  const code = planningCodeById.get(codeId);
  cell.td.textContent = code ? code.Code : "—";
  cell.td.title = code ? code.Libelle : "";
  planningPendingPaint.set(`${cell.semaineId}|${cell.jour}`,
    { semaineId: cell.semaineId, jour: cell.jour, codeId });
}

function commitPendingPaint() {
  const changes = [...planningPendingPaint.values()];
  planningPendingPaint.clear();
  if (changes.length) patchPlanningBatch(changes);
}

async function patchPlanningBatch(changes) {
  try {
    await Promise.all(changes.map((ch) =>
      api("PATCH", `/api/cadre/planning/${ch.semaineId}`, { jour: ch.jour, codeId: ch.codeId })));
  } catch (err) {
    alert(err.message);
  }
  try { await refresh(); } catch (err) { alert(err.message); }
}

function selRect() {
  const s = state.planningSel;
  return {
    rMin: Math.min(s.r1, s.r2), rMax: Math.max(s.r1, s.r2),
    cMin: Math.min(s.c1, s.c2), cMax: Math.max(s.c1, s.c2),
  };
}

function updateSelHighlight() {
  if (!planningGrid) return;
  const rect = state.planningSel ? selRect() : null;
  planningGrid.rows.forEach((row, r) => row.cells.forEach((cell, c) => {
    if (!cell) return;
    const on = rect && r >= rect.rMin && r <= rect.rMax && c >= rect.cMin && c <= rect.cMax;
    cell.td.classList.toggle("sel", !!on);
  }));
}

function copySelection() {
  if (!state.planningSel || !planningGrid) return;
  const { rMin, rMax, cMin, cMax } = selRect();
  planningClipboard = [];
  const lines = [];
  for (let r = rMin; r <= rMax; r++) {
    const rowIds = [];
    const rowTxt = [];
    for (let c = cMin; c <= cMax; c++) {
      const cell = planningGrid.rows[r] && planningGrid.rows[r].cells[c];
      const codeId = cell ? cell.codeId : null;
      rowIds.push(codeId);
      const code = planningCodeById.get(codeId);
      rowTxt.push(code ? code.Code : "");
    }
    planningClipboard.push(rowIds);
    lines.push(rowTxt.join("\t"));
  }
  // Copie aussi en texte (tabulations) : collable dans Excel ou ailleurs.
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(lines.join("\n")).catch(() => {});
  }
  const n = (rMax - rMin + 1) * (cMax - cMin + 1);
  if (planningStatusEl) planningStatusEl.textContent = `✓ ${n} case${n > 1 ? "s copiées" : " copiée"}.`;
}

function pasteSelection() {
  if (!planningClipboard || !state.planningSel || !planningGrid) return;
  const { rMin, rMax, cMin, cMax } = selRect();
  const ch = planningClipboard.length;
  const cw = planningClipboard[0].length;
  // Une seule case sélectionnée : on colle le bloc entier à partir d'elle.
  // Sélection plus grande : on la remplit en répétant le bloc copié.
  const single = rMin === rMax && cMin === cMax;
  const destH = single ? ch : rMax - rMin + 1;
  const destW = single ? cw : cMax - cMin + 1;
  const changes = [];
  for (let dr = 0; dr < destH; dr++) {
    for (let dc = 0; dc < destW; dc++) {
      const row = planningGrid.rows[rMin + dr];
      const cell = row && row.cells[cMin + dc];
      if (!cell) continue;
      const codeId = planningClipboard[dr % ch][dc % cw];
      if (codeId !== cell.codeId) {
        changes.push({ semaineId: cell.semaineId, jour: cell.jour, codeId });
      }
    }
  }
  if (changes.length) patchPlanningBatch(changes);
}

function clearSelectionCells() {
  if (!state.planningSel || !planningGrid) return;
  const { rMin, rMax, cMin, cMax } = selRect();
  const changes = [];
  for (let r = rMin; r <= rMax; r++) {
    for (let c = cMin; c <= cMax; c++) {
      const cell = planningGrid.rows[r] && planningGrid.rows[r].cells[c];
      if (cell && cell.codeId) changes.push({ semaineId: cell.semaineId, jour: cell.jour, codeId: null });
    }
  }
  if (changes.length) patchPlanningBatch(changes);
}

document.addEventListener("keydown", (e) => {
  if (state.activeTab !== "planning" || !planningGrid || !state.planningSel) return;
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  const sel = state.planningSel;
  const clamp = (v, max) => Math.max(0, Math.min(max, v));
  const maxR = planningGrid.rows.length - 1;
  const maxC = 29;
  const dr = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
  const dc = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
  if (dr || dc) {
    if (e.shiftKey) {
      sel.r2 = clamp(sel.r2 + dr, maxR);
      sel.c2 = clamp(sel.c2 + dc, maxC);
    } else {
      const r = clamp(sel.r2 + dr, maxR);
      const c = clamp(sel.c2 + dc, maxC);
      sel.r1 = sel.r2 = r;
      sel.c1 = sel.c2 = c;
    }
    e.preventDefault();
    updateSelHighlight();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
    e.preventDefault();
    copySelection();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
    e.preventDefault();
    pasteSelection();
  } else if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    clearSelectionCells();
  } else if (e.key === "Escape") {
    state.planningSel = null;
    updateSelHighlight();
  }
});

/** Repli : double-clic sur une case ouvre la liste déroulante des codes. */
function openPlanningCellEditor(cell) {
  if (!cell) return;
  const select = document.createElement("select");
  select.innerHTML = ['<option value="">—</option>']
    .concat(codesPourSelect(cell.codeId).map((c) =>
      `<option value="${c.id}">${escapeHtml(c.Code)} — ${escapeHtml(c.Libelle)}</option>`)).join("");
  select.value = cell.codeId || "";
  cell.td.innerHTML = "";
  cell.td.appendChild(select);
  select.focus();
  let done = false;
  const restore = () => {
    const code = planningCodeById.get(cell.codeId);
    cell.td.innerHTML = "";
    cell.td.textContent = code ? code.Code : "—";
  };
  select.addEventListener("change", () => {
    if (done) return;
    done = true;
    const codeId = select.value ? Number(select.value) : null;
    if (codeId === cell.codeId) { restore(); return; }
    select.disabled = true;
    patchPlanningBatch([{ semaineId: cell.semaineId, jour: cell.jour, codeId }]);
  });
  select.addEventListener("blur", () => setTimeout(() => { if (!done) { done = true; restore(); } }, 0));
}

/** Légende affichée sous le planning : horaires de chaque code + repère week-end/férié. */
function renderCodesLegend() {
  const wrap = el("div", "codes-legend");
  wrap.appendChild(el("div", "codes-legend-title", "Codes horaires"));
  const list = el("div", "codes-legend-list");
  for (const c of codesDuService()) {
    const horaire = (c.Heure_debut && c.Heure_fin) ? ` (${c.Heure_debut}–${c.Heure_fin})` : "";
    list.appendChild(el("span", "codes-legend-item", `${c.Code} — ${c.Libelle}${horaire}`));
  }
  const offItem = el("span", "codes-legend-item legend-off-item");
  offItem.appendChild(el("span", "legend-off-swatch"));
  offItem.appendChild(document.createTextNode("Week-end / jour férié"));
  list.appendChild(offItem);
  wrap.appendChild(list);
  return wrap;
}

function isWeekendIso(iso) {
  const day = new Date(iso + "T00:00:00").getDay();
  return day === 0 || day === 6;
}

function shiftWindow(deltaDays) {
  const cur = state.planningStart ? new Date(state.planningStart + "T00:00:00") : new Date();
  cur.setDate(cur.getDate() + deltaDays);
  state.planningStart = isoDate(cur);
  renderPlanningTab();
}

function updatePrintHeader(startKey, endKey) {
  const service = state.data.services.find((s) => s.id === state.selectedServiceId);
  const serviceName = service ? service.Nom : "";
  const now = new Date();
  const genDate = now.toLocaleDateString("fr-FR") + " à "
    + now.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  const printedBy = (state.data.moi && state.data.moi.nom) || "";
  $("print-header").innerHTML =
    `<h2 style="margin:0 0 4px;">Planning de service — ${escapeHtml(serviceName)}</h2>`
    + `<p style="margin:0;color:#555;font-size:0.85rem;">Du ${frDate(startKey)} au ${frDate(endKey)} · Généré le ${genDate}`
    + (printedBy ? ` · Imprimé par ${escapeHtml(printedBy)}` : "") + `</p>`;

  $("print-footer").innerHTML =
    `Application développée par <strong>M. Joan THUILLIER</strong>, Cadre de Santé Apprenant — `
    + `Pôle 9 Gérontologie-Gériatrie · CHR Metz-Thionville<br>`
    + `Version bêta ${APP_VERSION} — vos retours sont les bienvenus`;
}

/** Associe chaque jour (ISO) d'une période à sa case de planning (semaine + colonne). */
function buildDayMap(periodeId) {
  const map = new Map();
  const weeks = state.data.semaines.filter((s) => s.Periode === periodeId);
  for (const week of weeks) {
    DAYS.forEach((day, i) => {
      const dayIso = addDaysIso(week.Semaine_debut, i);
      map.set(dayIso, { semaineId: week.id, jour: day, codeId: week[day] || null });
    });
  }
  return map;
}

/* ------------------------------------------------------------------ */
/* Case de planning éditable (clic -> liste déroulante, comme dans Grist) */
/* ------------------------------------------------------------------ */

function codeCell(semaineId, jour, codeId, extraClass) {
  const codeById = new Map(state.data.codes.map((c) => [c.id, c]));
  const td = document.createElement("td");
  td.className = "code-cell" + (extraClass ? " " + extraClass : "");

  function renderText() {
    td.innerHTML = "";
    const code = codeById.get(codeId);
    td.textContent = code ? code.Code : "—";
    if (code) td.title = code.Libelle;
  }
  renderText();

  td.addEventListener("click", () => {
    const select = document.createElement("select");
    const options = ['<option value="">—</option>']
      .concat(codesPourSelect(codeId).map((c) => `<option value="${c.id}">${escapeHtml(c.Code)} — ${escapeHtml(c.Libelle)}</option>`));
    select.innerHTML = options.join("");
    select.value = codeId || "";
    td.innerHTML = "";
    td.appendChild(select);
    select.focus();

    let done = false;
    async function commit() {
      if (done) return;
      done = true;
      const value = select.value;
      const newCodeId = value ? Number(value) : null;
      if (newCodeId === codeId) { renderText(); return; }
      select.disabled = true;
      try {
        await api("PATCH", `/api/cadre/planning/${semaineId}`, { jour, codeId: newCodeId });
        await refresh();
      } catch (err) {
        alert(err.message);
        renderText();
      }
    }
    function cancel() {
      if (done) return;
      done = true;
      renderText();
    }
    select.addEventListener("change", commit);
    select.addEventListener("blur", () => setTimeout(cancel, 0));
  });

  return td;
}

/* ------------------------------------------------------------------ */
/* Onglet Envoi des évaluations (étudiants éligibles)                  */
/* ------------------------------------------------------------------ */

function renderEvaluationTab() {
  const container = $("evaluation-list");
  container.innerHTML = "";

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Éligible entre 10 jours avant la fin du stage et 40 jours après.
  const periodes = periodesDuService().filter((p) => {
    if (!p.Au) return false;
    const au = new Date(p.Au + "T00:00:00");
    const diffDays = Math.round((today - au) / 86400000);
    return diffDays >= -10 && diffDays <= 40;
  }).sort((a, b) => (a.Au || "").localeCompare(b.Au || ""));

  if (!periodes.length) {
    container.appendChild(el("p", "empty",
      "Aucun étudiant éligible actuellement (de 10 jours avant la fin du stage à 40 jours après)."));
    return;
  }

  for (const p of periodes) {
    const row = el("div", "pending-row");
    const main = el("div", "pending-main");
    const title = el("div", "sortie-title", `${p.Etudiant.prenom} ${p.Etudiant.nom}`.trim());
    if (p.Evaluation_repondue) {
      title.appendChild(badge("✅ — a répondu", "ok"));
    } else if (p.Evaluation_envoyee) {
      title.appendChild(badge("⚠️ — envoyé, en attente de réponse", "pending"));
    }
    main.appendChild(title);
    main.appendChild(el("div", "sortie-meta", `${frDate(p.Du)} → ${frDate(p.Au)}`));
    row.appendChild(main);

    if (p.Lien_evaluation && p.Etudiant.email) {
      const a = document.createElement("a");
      a.className = "btn btn-primary";
      a.textContent = p.Evaluation_envoyee ? "Renvoyer l'évaluation" : "Envoyer l'évaluation";
      a.href = mailtoEvaluation(p);
      a.addEventListener("click", () => {
        if (!p.Evaluation_envoyee) {
          api("PATCH", `/api/cadre/periodes/${p.id}`, { Evaluation_envoyee: true })
            .then(refresh)
            .catch(() => {});
        }
      });
      row.appendChild(a);
    } else if (!p.Lien_evaluation) {
      row.appendChild(badge("Lien non généré", "warn"));
    } else {
      row.appendChild(badge("Email étudiant manquant", "warn"));
    }
    container.appendChild(row);
  }
}

/* ------------------------------------------------------------------ */
/* Onglet Codes horaires (codes actifs du service)                     */
/* ------------------------------------------------------------------ */

// Sélection en cours (non enregistrée) de l'onglet : Set d'ids « utilisés »
// par service, pour survivre aux re-rendus tant qu'on n'a pas enregistré.
const codesTabDraft = {}; // serviceId -> Set(codeId)

function renderCodesTab() {
  const container = $("codes-service-list");
  container.innerHTML = "";
  const service = state.data.services.find((s) => s.id === state.selectedServiceId);
  if (!service) return;

  if (!codesTabDraft[service.id]) {
    const actifs = Array.isArray(service.Codes) ? service.Codes : [];
    // Liste vide côté Grist = tous les codes utilisés
    codesTabDraft[service.id] = new Set(actifs.length ? actifs : state.data.codes.map((c) => c.id));
  }
  const utilises = codesTabDraft[service.id];

  const libelleCode = (c) => {
    const horaire = (c.Heure_debut && c.Heure_fin) ? ` (${c.Heure_debut}–${c.Heure_fin})` : "";
    return `${c.Code} — ${c.Libelle}${horaire}`;
  };

  const mkColumn = (titre, codes, fleche, action) => {
    const col = el("div", "dual-list-col");
    col.appendChild(el("div", "dual-list-title", `${titre} (${codes.length})`));
    const list = el("div", "dual-list-items");
    for (const c of codes) {
      const btn = el("button", "dual-list-item", `${fleche} ${libelleCode(c)}`);
      btn.type = "button";
      btn.title = action === "add" ? "Ajouter aux codes utilisés" : "Retirer des codes utilisés";
      btn.addEventListener("click", () => {
        if (action === "add") utilises.add(c.id);
        else utilises.delete(c.id);
        renderCodesTab();
      });
      list.appendChild(btn);
    }
    if (!codes.length) list.appendChild(el("p", "empty", "Aucun code."));
    col.appendChild(list);
    return col;
  };

  const dispo = state.data.codes.filter((c) => !utilises.has(c.id));
  const usedList = state.data.codes.filter((c) => utilises.has(c.id));
  const wrap = el("div", "dual-list");
  wrap.appendChild(mkColumn("Codes disponibles", dispo, "▶", "add"));
  wrap.appendChild(mkColumn("Codes utilisés dans ce service", usedList, "◀", "remove"));
  container.appendChild(wrap);

  const hint = el("p", "save-hint", "");
  const saveBtn = el("button", "btn btn-primary", "Enregistrer");
  saveBtn.type = "button";
  saveBtn.style.marginTop = "0.75rem";
  saveBtn.addEventListener("click", async () => {
    if (!utilises.size) {
      hint.textContent = "Gardez au moins un code horaire utilisé.";
      return;
    }
    // Tous utilisés = on enregistre « tous » (liste vide) : les codes créés
    // plus tard seront alors proposés automatiquement.
    const codes = utilises.size === state.data.codes.length ? [] : [...utilises];
    saveBtn.disabled = true;
    hint.textContent = "";
    try {
      await api("PATCH", `/api/cadre/services/${service.id}`, { codes });
      delete codesTabDraft[service.id];
      hint.textContent = "Enregistré.";
      await refresh();
    } catch (err) {
      hint.textContent = err.message;
      saveBtn.disabled = false;
    }
  });
  container.appendChild(saveBtn);
  container.appendChild(hint);

  container.appendChild(renderNouveauCode(service, utilises, hint));
}

/** Formulaire « créer un code horaire » : le code créé est partagé (visible de
 *  tous les services) et ajouté d'office aux codes utilisés de ce service.
 *  Les doublons sont refusés (ici et côté serveur) ; pas de suppression. */
function renderNouveauCode(service, utilises, hint) {
  const box = el("div", "nouveau-code");
  box.appendChild(el("div", "dual-list-title", "Créer un code horaire"));
  box.appendChild(el("p", "save-hint",
    "Le nouveau code sera ajouté aux codes utilisés de ce service ; les autres services pourront aussi le reprendre. Un code créé ne peut plus être supprimé."));

  const form = el("div", "nouveau-code-form");
  const mkInput = (labelTxt, type, attrs = {}) => {
    const label = el("label", "", labelTxt);
    const input = document.createElement("input");
    input.type = type;
    Object.assign(input, attrs);
    label.appendChild(input);
    form.appendChild(label);
    return input;
  };
  const codeInput = mkInput("Code", "text", { maxLength: 10, placeholder: "ex. M12" });
  const libelleInput = mkInput("Libellé", "text", { maxLength: 80, placeholder: "ex. Matin 12h" });
  const debutInput = mkInput("De", "time");
  const finInput = mkInput("À", "time");
  const compteLabel = el("label", "checkbox-label");
  const compteInput = document.createElement("input");
  compteInput.type = "checkbox";
  compteInput.checked = true;
  compteLabel.appendChild(compteInput);
  compteLabel.appendChild(document.createTextNode(" Compte en temps de stage"));
  form.appendChild(compteLabel);

  const createBtn = el("button", "btn btn-ghost", "+ Créer le code");
  createBtn.type = "button";
  createBtn.addEventListener("click", async () => {
    const code = codeInput.value.trim().toUpperCase();
    if (code && state.data.codes.some((c) => (c.Code || "").trim().toUpperCase() === code)) {
      hint.textContent = `Le code « ${code} » existe déjà : reprenez-le dans les codes disponibles.`;
      return;
    }
    createBtn.disabled = true;
    hint.textContent = "";
    try {
      const res = await api("POST", "/api/cadre/codes", {
        Code: code,
        Libelle: libelleInput.value.trim(),
        Heure_debut: debutInput.value,
        Heure_fin: finInput.value,
        Compte_stage: compteInput.checked,
        serviceId: service.id,
      });
      utilises.add(res.id);
      hint.textContent = `Code « ${code} » créé.`;
      await refresh();
    } catch (err) {
      hint.textContent = err.message;
      createBtn.disabled = false;
    }
  });
  form.appendChild(createBtn);
  box.appendChild(form);
  return box;
}

function mailtoEvaluation(p) {
  const service = state.data.services.find((s) => s.id === p.Service);
  const serviceName = service ? service.Nom : "";
  const subject = `Votre avis sur votre stage${serviceName ? " de " + serviceName : ""} (${frDate(p.Du)} - ${frDate(p.Au)})`;
  const body = `Bonjour ${p.Etudiant.prenom},

Votre stage touche à sa fin.

Service : ${serviceName || "-"}
Période : du ${frDate(p.Du)} au ${frDate(p.Au)}

Nous vous serions reconnaissants de prendre quelques minutes pour répondre à notre questionnaire d'évaluation de stage.

${p.Lien_evaluation}

Vos réponses restent confidentielles. Merci pour votre implication durant ce stage.`;
  return `mailto:${encodeURIComponent(p.Etudiant.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/* ------------------------------------------------------------------ */
/* Utilitaires                                                         */
/* ------------------------------------------------------------------ */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function badge(text, kind) {
  return el("span", "badge " + kind, text);
}

function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function isoDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addDaysIso(iso, n) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return isoDate(d);
}

function dayNum(iso) {
  return new Date(iso + "T00:00:00").toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

function frDate(iso) {
  if (!iso) return "?";
  return new Date(iso + "T00:00:00").toLocaleDateString("fr-FR", {
    day: "numeric", month: "long", year: "numeric",
  });
}

function frDateCourt(iso) {
  if (!iso) return "?";
  return new Date(iso + "T00:00:00").toLocaleDateString("fr-FR", {
    day: "2-digit", month: "2-digit", year: "numeric",
  });
}

function formatH(hours) {
  if (hours == null) return "0h";
  const neg = hours < 0;
  const totalMin = Math.round(Math.abs(hours) * 60);
  const hh = Math.floor(totalMin / 60);
  const mm = totalMin % 60;
  return (neg ? "-" : "") + hh + "h" + (mm ? String(mm).padStart(2, "0") : "");
}

/* ------------------------------------------------------------------ */
/* Démarrage                                                           */
/* ------------------------------------------------------------------ */

if (state.email && state.code) {
  api("GET", "/api/cadre/data")
    .then((data) => { state.data = data; enterApp(); })
    .catch(() => { sessionStorage.clear(); state.email = null; state.code = null; });
}
