/* Espace cadre — gestion des étudiants du service : planning, validations, fiches */

const API = window.CONFIG.API_URL.replace(/\/$/, "");
const $ = (id) => document.getElementById(id);
const DAYS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];
const TABS = [
  { id: "dossier", label: "Dossier" },
  { id: "planning", label: "Planning" },
  { id: "evaluation", label: "Évaluation" },
];

const state = {
  email: sessionStorage.getItem("cadre_email") || null,
  code: sessionStorage.getItem("cadre_code") || null,
  data: null, // { services, niveaux, periodes, semaines, codes, sorties }
  selectedServiceId: null,
  activeTab: "dossier",
  planningStart: null, // ISO date (jour) du mois affiché dans l'onglet Planning
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
  renderPending();
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
    renderPending();
    renderActiveTab();
  };
}

function periodesDuService() {
  return state.data.periodes.filter((p) => p.Service === state.selectedServiceId);
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
  $("tab-dossier").hidden = state.activeTab !== "dossier";
  $("tab-planning").hidden = state.activeTab !== "planning";
  $("tab-evaluation").hidden = state.activeTab !== "evaluation";
  if (state.activeTab === "dossier") renderDossierTab();
  if (state.activeTab === "planning") renderPlanningTab();
  if (state.activeTab === "evaluation") renderEvaluationTab();
}

/* ------------------------------------------------------------------ */
/* Déclarations en attente                                             */
/* ------------------------------------------------------------------ */

function renderPending() {
  const container = $("pending");
  container.innerHTML = "";
  const periodeIds = new Set(periodesDuService().map((p) => p.id));
  const periodesById = new Map(state.data.periodes.map((p) => [p.id, p]));
  const pending = state.data.sorties
    .filter((s) => !s.Valide && periodeIds.has(s.Periode))
    .sort((a, b) => (a.Date || "").localeCompare(b.Date || ""));

  if (!pending.length) {
    container.appendChild(el("p", "empty", "Aucune déclaration en attente pour ce service."));
    return;
  }

  for (const s of pending) {
    const p = periodesById.get(s.Periode);
    const row = el("div", "pending-row");
    const main = el("div", "pending-main");
    const nomEtu = p ? `${p.Etudiant.prenom} ${p.Etudiant.nom}`.trim() : "";
    const titleText = s.Commentaire ? `${s.Motif} — ${s.Commentaire}` : s.Motif;
    main.appendChild(el("div", "sortie-title", `${nomEtu} · ${titleText}`));
    main.appendChild(el("div", "sortie-meta",
      `${frDate(s.Date)} · ${s.Heure_debut || "?"} – ${s.Heure_fin || "?"} · ${formatH(s.Duree_heures)}`));
    row.appendChild(main);

    const btn = el("button", "btn btn-primary", "Valider");
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await api("PATCH", `/api/cadre/sorties/${s.id}`, { Valide: true });
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
/* Onglet Dossier (fiche + planning individuel par étudiant)           */
/* ------------------------------------------------------------------ */

function renderDossierTab() {
  const container = $("dossier-list");
  container.innerHTML = "";
  const periodes = periodesDuService().sort((a, b) =>
    `${a.Etudiant.nom}${a.Etudiant.prenom}`.localeCompare(`${b.Etudiant.nom}${b.Etudiant.prenom}`));

  if (!periodes.length) {
    container.appendChild(el("p", "empty", "Aucun étudiant sur ce service."));
    return;
  }

  for (const p of periodes) {
    const card = el("div", "etu-card");

    const header = el("div", "etu-header");
    header.appendChild(el("div", "etu-nom", `${p.Etudiant.prenom} ${p.Etudiant.nom}`.trim()));
    const metaParts = [];
    if (p.Etudiant.formation) metaParts.push(p.Etudiant.formation);
    if (p.Etudiant.centre) metaParts.push(p.Etudiant.centre);
    metaParts.push(`${formatH(p.FAIT)} effectuées / ${formatH(p.A_FAIRE)} à réaliser`);
    metaParts.push(`Solde ${p.Solde_heures > 0 ? "+" : ""}${formatH(p.Solde_heures)}`);
    header.appendChild(el("div", "etu-meta", metaParts.join(" · ")));
    card.appendChild(header);

    card.appendChild(renderFiche(p));
    card.appendChild(renderMiniPlanning(p));

    container.appendChild(card);
  }
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

/** Tableau du planning d'un seul étudiant : une ligne par semaine. */
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

/* ------------------------------------------------------------------ */
/* Onglet Planning (grille de tout le service)                        */
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
  const prevBtn = el("button", "btn btn-ghost", "◀ Préc.");
  prevBtn.type = "button";
  prevBtn.addEventListener("click", () => shiftMonth(-1));
  const nextBtn = el("button", "btn btn-ghost", "Suiv. ▶");
  nextBtn.type = "button";
  nextBtn.addEventListener("click", () => shiftMonth(1));
  controls.append(dateInput, todayBtn, prevBtn, nextBtn);
  container.appendChild(controls);

  const range = getMonthRange(state.planningStart || isoDate(new Date()));
  const days = [];
  for (let i = 0; i < range.numDays; i++) days.push(addDaysIso(range.startKey, i));

  const periodes = periodesDuService()
    .filter((p) => !(p.Au && p.Au < range.startKey) && !(p.Du && p.Du > range.endKey))
    .sort((a, b) => `${a.Etudiant.nom}${a.Etudiant.prenom}`.localeCompare(`${b.Etudiant.nom}${b.Etudiant.prenom}`));

  if (!periodes.length) {
    container.appendChild(el("p", "empty", "Aucun étudiant sur ce service pour ce mois."));
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

function shiftMonth(delta) {
  const cur = state.planningStart ? new Date(state.planningStart + "T00:00:00") : new Date();
  cur.setMonth(cur.getMonth() + delta);
  state.planningStart = isoDate(cur);
  renderPlanningTab();
}

function getMonthRange(key) {
  const d = new Date(key + "T00:00:00");
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return { startKey: isoDate(first), endKey: isoDate(last), numDays: last.getDate() };
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
/* Onglet Évaluation                                                   */
/* ------------------------------------------------------------------ */

function renderEvaluationTab() {
  const container = $("evaluation-list");
  container.innerHTML = "";
  const periodes = periodesDuService().sort((a, b) => (b.Du || "").localeCompare(a.Du || ""));

  if (!periodes.length) {
    container.appendChild(el("p", "empty", "Aucun étudiant sur ce service."));
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
