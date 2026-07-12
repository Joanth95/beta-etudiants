/* Espace étudiant — consultation du planning + déclarations d'heures */

const API = window.CONFIG.API_URL.replace(/\/$/, "");
const $ = (id) => document.getElementById(id);
const DAYS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];

const state = {
  code: sessionStorage.getItem("code") || null,
  data: null, // { etudiant, motifs, periodes, semaines, codes, sorties }
};

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(state.code ? { "X-Student-Code": state.code } : {}),
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
    state.code = $("login-code").value.trim().toUpperCase();
    state.data = await api("POST", "/api/login", { code: state.code });
    sessionStorage.setItem("code", state.code);
    enterApp();
  } catch (err) {
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
  const e = state.data.etudiant;
  $("student-name").textContent = `${e.prenom} ${e.nom}`.trim();
  render();
}

async function refresh() {
  state.data = await api("GET", "/api/data");
  render();
}

/* ------------------------------------------------------------------ */
/* Rendu                                                               */
/* ------------------------------------------------------------------ */

function currentPeriode() {
  const p = state.data.periodes;
  return p.find((x) => x.En_cours) || p[p.length - 1] || null;
}

function render() {
  renderPeriode();
  renderSorties();
  renderWeeks();
}

function renderPeriode() {
  const container = $("periode-info");
  container.innerHTML = "";
  const p = currentPeriode();
  if (!p) {
    container.appendChild(el("p", "empty", "Aucune période de stage enregistrée. Contactez votre encadrant."));
    return;
  }

  const card = el("div", "periode-card");
  card.appendChild(el("div", "periode-service", p.Service || "Stage"));
  card.appendChild(el("div", "periode-dates",
    `Du ${frDate(p.Du)} au ${frDate(p.Au)}` +
    (p.Niveau ? ` · ${p.Niveau}` : "") +
    (p.Tuteur ? ` · Tuteur : ${p.Tuteur}` : "")));

  if (p.A_FAIRE != null) {
    const fait = p.FAIT ?? 0;
    const stats = el("div", "periode-stats");
    stats.appendChild(badge(`${fait} h effectuées`, "ok"));
    stats.appendChild(badge(`${p.A_FAIRE} h à réaliser`, ""));
    if (p.Solde_heures != null) {
      stats.appendChild(badge(`Solde : ${p.Solde_heures > 0 ? "+" : ""}${p.Solde_heures} h`,
        p.Solde_heures >= 0 ? "ok" : "warn"));
    }
    card.appendChild(stats);
  }
  container.appendChild(card);
}

/* ---------- Déclarations (sorties de stage) ---------- */

function renderSorties() {
  const container = $("sorties");
  container.innerHTML = "";
  const sorties = [...state.data.sorties].sort((a, b) => (b.Date || "").localeCompare(a.Date || ""));

  if (!sorties.length) {
    container.appendChild(el("p", "empty", "Aucune déclaration pour l'instant."));
    return;
  }

  for (const s of sorties) {
    const row = el("div", "sortie-row");

    // Heures affichées : réelles si validé, prévues sinon
    const adj = s.Valide ? s.Ajustement_h : expectedAdjustment(s);
    const sign = adj > 0 ? "+" : "";
    const badgeEl = badge(`${sign}${adj} h`,
      s.Valide ? (adj > 0 ? "ok" : (adj < 0 ? "warn" : "")) : "");
    badgeEl.classList.add("sortie-hours");

    const main = el("div", "sortie-main");
    const title = el("div", "sortie-title", s.Motif || "(sans motif)");
    title.appendChild(badge(s.Valide ? "Validé" : "En attente", s.Valide ? "ok" : "pending"));
    main.appendChild(title);
    main.appendChild(el("div", "sortie-meta",
      `${frDate(s.Date)} · ${s.Heure_debut || "?"} – ${s.Heure_fin || "?"}`));

    row.append(badgeEl, main);

    if (!s.Valide) {
      const delBtn = el("button", "sortie-delete", "🗑️");
      delBtn.title = "Supprimer cette déclaration";
      delBtn.addEventListener("click", () => removeSortie(s));
      row.appendChild(delBtn);
    }
    container.appendChild(row);
  }
}

/** Heures qu'une déclaration en attente vaudra une fois validée. */
function expectedAdjustment(s) {
  const d = s.Duree_heures || 0;
  if ((s.Motif || "").trim().toUpperCase() === "RETARD") return -d;
  return s.Compte_stage ? d : 0;
}

async function removeSortie(s) {
  if (!confirm(`Supprimer la déclaration « ${s.Motif} » du ${frDate(s.Date)} ?`)) return;
  try {
    await api("DELETE", `/api/sorties/${s.id}`);
    await refresh();
  } catch (err) {
    alert(err.message);
  }
}

/* ---------- Planning (lecture seule) ---------- */

function renderWeeks() {
  const container = $("weeks");
  container.innerHTML = "";
  const p = currentPeriode();
  if (!p) return;

  const codeById = new Map(state.data.codes.map((c) => [c.id, c]));
  const weeks = state.data.semaines
    .filter((s) => s.Periode === p.id)
    .sort((a, b) => (a.Semaine_debut || "").localeCompare(b.Semaine_debut || ""));

  if (!weeks.length) {
    container.appendChild(el("p", "empty", "Le planning n'a pas encore été établi par le service."));
    return;
  }

  const todayIso = isoDate(new Date());
  for (const week of weeks) {
    const card = el("section", "week-card");

    const header = el("div", "week-header");
    header.appendChild(el("h3", "", `Semaine du ${frDate(week.Semaine_debut)}`));
    if (week.Total_h_semaine != null) {
      header.appendChild(el("span", "week-total", `${week.Total_h_semaine} h`));
    }
    card.appendChild(header);

    const grid = el("div", "week-grid");
    DAYS.forEach((day, i) => {
      const dayIso = addDaysIso(week.Semaine_debut, i);
      const code = codeById.get(week[day]);
      const cell = el("div", "day-cell readonly" + (dayIso === todayIso ? " today" : ""));
      cell.appendChild(el("div", "day-label", `${day.slice(0, 3)}. ${dayNum(dayIso)}`));
      const chip = el("div", "day-chip", code ? code.Code : "—");
      if (code && code.Heure_debut && code.Heure_fin) {
        chip.title = `${code.Libelle} (${code.Heure_debut}–${code.Heure_fin})`;
        cell.appendChild(el("div", "day-hours", `${code.Heure_debut}–${code.Heure_fin}`));
      } else if (code) {
        chip.title = code.Libelle;
      }
      cell.insertBefore(chip, cell.children[1] || null);
      grid.appendChild(cell);
    });
    card.appendChild(grid);

    if (week.Commentaire) {
      card.appendChild(el("p", "week-comment", week.Commentaire));
    }
    container.appendChild(card);
  }
}

/* ------------------------------------------------------------------ */
/* Dialogue de déclaration                                             */
/* ------------------------------------------------------------------ */

const dialog = $("sortie-dialog");

function selectedType() {
  return document.querySelector('input[name="sortie-type"]:checked').value;
}

$("add-sortie-btn").addEventListener("click", () => {
  document.querySelector('input[name="sortie-type"][value="Rattrapage"]').checked = true;
  $("sortie-details").hidden = true;
  $("sortie-motif-texte").value = "";
  $("sortie-compte").checked = true;
  $("sortie-date").value = isoDate(new Date());
  $("sortie-debut").value = "";
  $("sortie-fin").value = "";
  $("sortie-error").hidden = true;
  dialog.showModal();
});

for (const radio of document.querySelectorAll('input[name="sortie-type"]')) {
  radio.addEventListener("change", () => {
    // Le motif libre et la case « compte en temps de stage » ne concernent
    // que la sortie de stage (heures sup / retard sont autoporteurs).
    $("sortie-details").hidden = selectedType() !== "Sortie de stage";
  });
}

$("sortie-cancel-btn").addEventListener("click", () => dialog.close());

$("sortie-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = $("sortie-error");
  errEl.hidden = true;

  const type = selectedType();
  let motif = type;
  let compte = true;
  if (type === "Retard") compte = false;
  if (type === "Sortie de stage") {
    compte = $("sortie-compte").checked;
    const precision = $("sortie-motif-texte").value.trim();
    if (precision) motif = precision; // motif libre saisi par l'étudiant
  }

  const body = {
    Motif: motif,
    Date: $("sortie-date").value,
    Heure_debut: $("sortie-debut").value,
    Heure_fin: $("sortie-fin").value,
    Compte_stage: compte,
  };

  const btn = $("sortie-save-btn");
  btn.disabled = true;
  try {
    await api("POST", "/api/sorties", body);
    dialog.close();
    await refresh();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

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

/* ------------------------------------------------------------------ */
/* Démarrage                                                           */
/* ------------------------------------------------------------------ */

if (state.code) {
  api("GET", "/api/data")
    .then((data) => { state.data = data; enterApp(); })
    .catch(() => { sessionStorage.clear(); state.code = null; });
}
