/* Espace cadre — gestion des étudiants du service : planning, validations, fiches */

const API = window.CONFIG.API_URL.replace(/\/$/, "");
const $ = (id) => document.getElementById(id);
const DAYS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];
const TABS = [
  { id: "declarations", label: "Déclarations à valider" },
  { id: "dossier", label: "Dossier étudiants" },
  { id: "planning", label: "Planning de service" },
  { id: "evaluation", label: "Envoi des évaluations" },
];

const state = {
  email: sessionStorage.getItem("cadre_email") || null,
  code: sessionStorage.getItem("cadre_code") || null,
  data: null, // { services, niveaux, motifs, moi, periodes, semaines, codes, sorties }
  selectedServiceId: null,
  activeTab: "declarations",
  dossierSubTab: {}, // studentId -> 'stages' | 'planning'
  dossierSelectedPeriode: {}, // studentId -> periodeId
  planningStart: null, // ISO date : début de la fenêtre de 30 jours affichée
};

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

$("refresh-btn").addEventListener("click", () => refresh().catch((err) => alert(err.message)));

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
  renderServiceSelect();
  renderMainTabs();
  renderActiveTab();
}

function renderServiceSelect() {
  const sel = $("service-select");
  const services = state.data.services;
  if (!services.some((s) => s.id === state.selectedServiceId)) {
    state.selectedServiceId = services[0] ? services[0].id : null;
  }
  sel.innerHTML = services.map((s) => `<option value="${s.id}">${escapeHtml(s.Nom)}</option>`).join("");
  sel.value = state.selectedServiceId;
  sel.onchange = () => {
    state.selectedServiceId = Number(sel.value);
    renderActiveTab();
  };
}

function periodesDuService() {
  return state.data.periodes.filter((p) => p.Service === state.selectedServiceId);
}

/** Regroupe les périodes du service par étudiant. */
function studentsDuService() {
  const map = new Map();
  for (const p of periodesDuService()) {
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
  if (state.activeTab === "declarations") renderDeclarationsTab();
  if (state.activeTab === "dossier") renderDossierTab();
  if (state.activeTab === "planning") renderPlanningTab();
  if (state.activeTab === "evaluation") renderEvaluationTab();
}

/* ------------------------------------------------------------------ */
/* Onglet Déclarations à valider (en attente + validées)               */
/* ------------------------------------------------------------------ */

function renderDeclarationsTab() {
  const periodeIds = new Set(periodesDuService().map((p) => p.id));
  const periodesById = new Map(state.data.periodes.map((p) => [p.id, p]));
  const sorties = state.data.sorties.filter((s) => periodeIds.has(s.Periode));
  const pending = sorties.filter((s) => !s.Valide).sort((a, b) => (a.Date || "").localeCompare(b.Date || ""));
  const valid = sorties.filter((s) => s.Valide).sort((a, b) => (b.Date || "").localeCompare(a.Date || ""));

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
    const row = el("div", "pending-row");
    const main = el("div", "pending-main");
    const nomEtu = p ? `${p.Etudiant.prenom} ${p.Etudiant.nom}`.trim() : "";
    const titleText = s.Commentaire ? `${s.Motif} — ${s.Commentaire}` : s.Motif;
    main.appendChild(el("div", "sortie-title", `${nomEtu} · ${titleText}`));
    main.appendChild(el("div", "sortie-meta",
      `${frDate(s.Date)} · ${s.Heure_debut || "?"} – ${s.Heure_fin || "?"} · ${formatH(s.Duree_heures)}`));
    row.appendChild(main);

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
    row.appendChild(btn);
    container.appendChild(row);
  }
}

/* ------------------------------------------------------------------ */
/* Onglet Dossier étudiants                                            */
/* ------------------------------------------------------------------ */

function renderDossierTab() {
  const container = $("dossier-list");
  container.innerHTML = "";
  const students = studentsDuService();

  if (!students.length) {
    container.appendChild(el("p", "empty", "Aucun étudiant sur ce service."));
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
    header.appendChild(left);
    const metaParts = [st.etudiant.formation, st.etudiant.centre].filter(Boolean);
    if (metaParts.length) header.appendChild(el("div", "etu-meta", metaParts.join(" · ")));
    card.appendChild(header);

    const subTabs = el("div", "sub-tabs");
    const current = state.dossierSubTab[st.id] || "stages";
    const subTabDefs = [
      { id: "stages", label: "Stages faits" },
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

    card.appendChild(current === "stages" ? renderStagesFaits(st) : renderPlanningPersonnel(st));

    container.appendChild(card);
  }
}

/** Sous-onglet "Stages faits" : liste des périodes de ce service, fiche éditable pour chacune. */
function renderStagesFaits(st) {
  const wrap = el("div", "");
  const periodes = [...st.periodes].sort((a, b) => (b.Du || "").localeCompare(a.Du || ""));
  for (const p of periodes) {
    const block = el("div", "stage-block");
    block.appendChild(el("div", "etu-meta",
      `${frDate(p.Du)} → ${frDate(p.Au)} · ${formatH(p.FAIT)} effectuées / ${formatH(p.A_FAIRE)} à réaliser · `
      + `Solde ${p.Solde_heures > 0 ? "+" : ""}${formatH(p.Solde_heures)}`));
    block.appendChild(renderFiche(p));
    wrap.appendChild(block);
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
/* ------------------------------------------------------------------ */

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

  const table = document.createElement("table");
  table.className = "service-planning";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  headRow.appendChild(el("th", "student-col", "Étudiant"));
  for (const dk of days) {
    headRow.appendChild(el("th", "", dayNum(dk)));
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const p of periodes) {
    const dayMap = buildDayMap(p.id);
    const tr = document.createElement("tr");
    const th = el("th", "student-col");
    th.appendChild(el("div", "", `${p.Etudiant.prenom} ${p.Etudiant.nom}`.trim()));
    th.appendChild(el("div", "etu-meta-small", [p.Niveau, p.Tuteur].filter(Boolean).join(" · ")));
    tr.appendChild(th);
    for (const dk of days) {
      if ((p.Du && dk < p.Du) || (p.Au && dk > p.Au)) {
        tr.appendChild(el("td", "hors-periode", ""));
        continue;
      }
      const entry = dayMap.get(dk);
      if (!entry) {
        tr.appendChild(el("td", "", "—"));
      } else {
        tr.appendChild(codeCell(entry.semaineId, entry.jour, entry.codeId));
      }
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.appendChild(table);
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

function codeCell(semaineId, jour, codeId) {
  const codeById = new Map(state.data.codes.map((c) => [c.id, c]));
  const td = document.createElement("td");
  td.className = "code-cell";

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
      .concat(state.data.codes.map((c) => `<option value="${c.id}">${escapeHtml(c.Code)} — ${escapeHtml(c.Libelle)}</option>`));
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
    main.appendChild(el("div", "sortie-title", `${p.Etudiant.prenom} ${p.Etudiant.nom}`.trim()));
    main.appendChild(el("div", "sortie-meta", `${frDate(p.Du)} → ${frDate(p.Au)}`));
    row.appendChild(main);

    if (p.Lien_evaluation && p.Etudiant.email) {
      const a = document.createElement("a");
      a.className = "btn btn-primary";
      a.textContent = "Envoyer l'évaluation";
      a.href = mailtoEvaluation(p);
      row.appendChild(a);
    } else if (!p.Lien_evaluation) {
      row.appendChild(badge("Lien non généré", "warn"));
    } else {
      row.appendChild(badge("Email étudiant manquant", "warn"));
    }
    container.appendChild(row);
  }
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
