/* Espace étudiant — logique de l'application */

const API = window.CONFIG.API_URL.replace(/\/$/, "");
const $ = (id) => document.getElementById(id);

const state = {
  code: sessionStorage.getItem("code") || null,
  name: sessionStorage.getItem("name") || "",
  entries: [],           // { id, fields: { Date, Heure_Debut, Heure_Fin, Activite, Lieu, Notes } }
  weekStart: mondayOf(new Date()),
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
    state.code = $("login-code").value.trim();
    const info = await api("POST", "/api/login", { code: state.code });
    state.name = [info.prenom, info.nom].filter(Boolean).join(" ");
    sessionStorage.setItem("code", state.code);
    sessionStorage.setItem("name", state.name);
    await enterApp();
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

async function enterApp() {
  $("login-screen").hidden = true;
  $("app-screen").hidden = false;
  $("student-name").textContent = state.name;
  await refresh();
}

/* ------------------------------------------------------------------ */
/* Planning                                                            */
/* ------------------------------------------------------------------ */

async function refresh() {
  const data = await api("GET", "/api/planning");
  state.entries = data.records || [];
  render();
}

function render() {
  $("week-label").textContent = weekLabel(state.weekStart);
  const container = $("planning");
  container.innerHTML = "";

  const todayIso = isoDate(new Date());
  let hasEntries = false;

  for (let i = 0; i < 7; i++) {
    const day = addDays(state.weekStart, i);
    const dayIso = isoDate(day);
    const entries = state.entries
      .filter((e) => e.fields.Date === dayIso)
      .sort((a, b) => (a.fields.Heure_Debut || "").localeCompare(b.fields.Heure_Debut || ""));

    if (entries.length === 0) continue;
    hasEntries = true;

    const section = document.createElement("section");
    section.className = "day" + (dayIso === todayIso ? " today" : "");
    const h3 = document.createElement("h3");
    h3.textContent = day.toLocaleDateString("fr-FR", {
      weekday: "long", day: "numeric", month: "long",
    }) + (dayIso === todayIso ? " — aujourd'hui" : "");
    section.appendChild(h3);

    for (const entry of entries) section.appendChild(renderEntry(entry));
    container.appendChild(section);
  }

  if (!hasEntries) {
    const empty = document.createElement("p");
    empty.className = "empty-week";
    empty.textContent = "Aucun créneau cette semaine.";
    container.appendChild(empty);
  }
}

function renderEntry(entry) {
  const f = entry.fields;
  const div = document.createElement("div");
  div.className = "entry";

  const time = document.createElement("span");
  time.className = "entry-time";
  time.textContent = `${f.Heure_Debut || "?"} – ${f.Heure_Fin || "?"}`;

  const main = document.createElement("div");
  main.className = "entry-main";
  const title = document.createElement("div");
  title.className = "entry-title";
  title.textContent = f.Activite || "(sans titre)";
  main.appendChild(title);
  const metaText = [f.Lieu, f.Notes].filter(Boolean).join(" · ");
  if (metaText) {
    const meta = document.createElement("div");
    meta.className = "entry-meta";
    meta.textContent = metaText;
    main.appendChild(meta);
  }

  const actions = document.createElement("div");
  actions.className = "entry-actions";
  const editBtn = document.createElement("button");
  editBtn.textContent = "✏️";
  editBtn.title = "Modifier";
  editBtn.addEventListener("click", () => openDialog(entry));
  const delBtn = document.createElement("button");
  delBtn.textContent = "🗑️";
  delBtn.title = "Supprimer";
  delBtn.addEventListener("click", () => removeEntry(entry));
  actions.append(editBtn, delBtn);

  div.append(time, main, actions);
  return div;
}

async function removeEntry(entry) {
  const f = entry.fields;
  if (!confirm(`Supprimer « ${f.Activite || "ce créneau"} » du ${frDate(f.Date)} ?`)) return;
  try {
    await api("DELETE", `/api/planning/${entry.id}`);
    await refresh();
  } catch (err) {
    alert(err.message);
  }
}

/* ------------------------------------------------------------------ */
/* Dialogue ajout / modification                                       */
/* ------------------------------------------------------------------ */

const dialog = $("entry-dialog");

$("add-btn").addEventListener("click", () => openDialog(null));
$("cancel-btn").addEventListener("click", () => dialog.close());

function openDialog(entry) {
  $("dialog-title").textContent = entry ? "Modifier le créneau" : "Nouveau créneau";
  $("entry-id").value = entry ? entry.id : "";
  $("entry-date").value = entry ? entry.fields.Date : isoDate(new Date());
  $("entry-start").value = entry ? entry.fields.Heure_Debut || "" : "";
  $("entry-end").value = entry ? entry.fields.Heure_Fin || "" : "";
  $("entry-activity").value = entry ? entry.fields.Activite || "" : "";
  $("entry-place").value = entry ? entry.fields.Lieu || "" : "";
  $("entry-notes").value = entry ? entry.fields.Notes || "" : "";
  $("entry-error").hidden = true;
  dialog.showModal();
}

$("entry-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = $("entry-error");
  errEl.hidden = true;

  const fields = {
    Date: $("entry-date").value,
    Heure_Debut: $("entry-start").value,
    Heure_Fin: $("entry-end").value,
    Activite: $("entry-activity").value.trim(),
    Lieu: $("entry-place").value.trim(),
    Notes: $("entry-notes").value.trim(),
  };

  if (fields.Heure_Fin && fields.Heure_Debut && fields.Heure_Fin <= fields.Heure_Debut) {
    errEl.textContent = "L'heure de fin doit être après l'heure de début.";
    errEl.hidden = false;
    return;
  }

  const saveBtn = $("save-btn");
  saveBtn.disabled = true;
  try {
    const id = $("entry-id").value;
    if (id) {
      await api("PATCH", `/api/planning/${id}`, { fields });
    } else {
      await api("POST", "/api/planning", { fields });
    }
    dialog.close();
    // Affiche la semaine du créneau créé/modifié
    state.weekStart = mondayOf(new Date(fields.Date + "T00:00:00"));
    await refresh();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  } finally {
    saveBtn.disabled = false;
  }
});

/* ------------------------------------------------------------------ */
/* Navigation semaine                                                  */
/* ------------------------------------------------------------------ */

$("prev-week").addEventListener("click", () => shiftWeek(-7));
$("next-week").addEventListener("click", () => shiftWeek(7));
$("today-btn").addEventListener("click", () => {
  state.weekStart = mondayOf(new Date());
  render();
});

function shiftWeek(days) {
  state.weekStart = addDays(state.weekStart, days);
  render();
}

/* ------------------------------------------------------------------ */
/* Utilitaires dates                                                   */
/* ------------------------------------------------------------------ */

function mondayOf(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const shift = (d.getDay() + 6) % 7; // lundi = 0
  d.setDate(d.getDate() - shift);
  return d;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function isoDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function frDate(iso) {
  if (!iso) return "?";
  return new Date(iso + "T00:00:00").toLocaleDateString("fr-FR", {
    day: "numeric", month: "long",
  });
}

function weekLabel(monday) {
  const sunday = addDays(monday, 6);
  const opts = { day: "numeric", month: "short" };
  return `Semaine du ${monday.toLocaleDateString("fr-FR", opts)} au ${sunday.toLocaleDateString("fr-FR", opts)}`;
}

/* ------------------------------------------------------------------ */
/* Démarrage                                                           */
/* ------------------------------------------------------------------ */

if (state.code) {
  enterApp().catch(() => {
    sessionStorage.clear();
    state.code = null;
  });
}
