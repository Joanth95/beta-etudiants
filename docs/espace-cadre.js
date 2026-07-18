  }[c]));
}
 
function isoDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
 
function firstDayOfMonthIso() {
  const d = new Date();
  return isoDate(new Date(d.getFullYear(), d.getMonth(), 1));
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
