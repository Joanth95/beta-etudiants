/* Gabarit partagé de l'en-tête et du pied de page.
   © Joan Thuillier — Tous droits réservés. Voir LICENSE à la racine du dépôt.

   Objectif : le balisage commun (bloc identité établissement, liens et crédit
   du pied) n'existe qu'à UN seul endroit. Chaque page ne déclare que ses
   spécificités via des attributs data-* sur <header class="fr-header"> et
   <footer class="fr-footer"> :

     <header class="fr-header"
             data-title="Espace étudiant"
             data-tagline="Suivi des stages étudiants"
             data-tagline-dynamic>        (sous-titre piloté par Grist)
       <div class="fr-header-tools">…outils propres à la page…</div>
     </header>

     <footer class="fr-footer"></footer>            (avec lien admin Grist)
     <footer class="fr-footer" data-no-admin></footer>   (page publique)

   - data-title-href : rend le titre cliquable (<a href>).
   - data-tagline-dynamic : ajoute la classe js-etab-tagline pour que le
     sous-titre soit remplacé par celui de l'établissement (Grist).
   - Le bloc .fr-header-tools est PRÉSERVÉ tel quel (déplacé, pas recréé),
     donc les boutons #logout-btn / #print-btn gardent leur nœud DOM.

   Ce script DOIT être chargé après le DOM (fin de <body>) et AVANT
   etablissement.js, qui remplit ensuite les .js-etab-* injectés ici. */

(function () {
  // Lien « Administration (Grist) » par défaut ; remplacé par la colonne
  // ETABLISSEMENT.Url_document_grist (endpoint /api/config) via
  // etablissement.js quand elle est renseignée (classe js-etab-admin).
  const GRIST_URL =
    "https://grist.numerique.gouv.fr/o/chr-metz-thionville/qdm9zxQGmCPH/GESTION-ETUDIANT/";

  // Bloc identité établissement, commun à l'en-tête et au pied.
  // Rempli par etablissement.js (nom, description, logo) depuis Grist.
  function identiteHTML() {
    return (
      '<img class="js-etab-logo" alt="" hidden>' +
      '<div class="brand-logo js-etab" hidden>' +
      '<span class="js-etab-nom"></span>' +
      '<span class="motto js-etab-desc"></span>' +
      "</div>"
    );
  }

  // ---- En-têtes ----
  document.querySelectorAll("header.fr-header").forEach((h) => {
    const tools = h.querySelector(".fr-header-tools"); // slot propre à la page
    const titre = h.dataset.title || "";
    const titreHref = h.dataset.titleHref || "";
    const tagline = h.dataset.tagline || "";
    const taglineDyn = h.hasAttribute("data-tagline-dynamic");

    const body = document.createElement("div");
    body.className = "fr-header-body";

    const brand = document.createElement("div");
    brand.className = "brand-block";
    brand.innerHTML = identiteHTML();

    const service = document.createElement("div");
    service.className = "brand-service";

    const t = document.createElement("div");
    t.className = "service-title";
    if (titreHref) {
      const a = document.createElement("a");
      a.href = titreHref;
      a.textContent = titre;
      t.appendChild(a);
    } else {
      t.textContent = titre;
    }

    const tag = document.createElement("div");
    tag.className = "service-tagline" + (taglineDyn ? " js-etab-tagline" : "");
    tag.textContent = tagline;

    service.appendChild(t);
    service.appendChild(tag);
    brand.appendChild(service);

    body.appendChild(brand);
    if (tools) body.appendChild(tools); // déplace le slot existant (nœuds préservés)

    h.innerHTML = "";
    h.appendChild(body);

    // Nettoyage des attributs de configuration.
    delete h.dataset.title;
    delete h.dataset.titleHref;
    delete h.dataset.tagline;
    h.removeAttribute("data-tagline-dynamic");
  });

  // ---- Pieds ----
  document.querySelectorAll("footer.fr-footer").forEach((f) => {
    const avecAdmin = !f.hasAttribute("data-no-admin");
    f.innerHTML =
      '<div class="fr-footer-inner">' +
      '<div class="fr-footer-top">' +
      identiteHTML() +
      '<p class="fr-footer-desc js-etab-footer-desc">' +
      "Application de suivi des stages étudiants développée par " +
      "<strong>M. Joan THUILLIER</strong>, Cadre de Santé Apprenant — " +
      "Pôle 9 Gérontologie-Gériatrie · CHR Metz-Thionville." +
      "</p>" +
      "</div>" +
      '<div class="fr-footer-links">' +
      '<a href="guide-etudiant.html">Mode d\'emploi étudiant</a><span class="sep">·</span>' +
      '<a href="guide-cadre.html">Mode d\'emploi cadre</a><span class="sep">·</span>' +
      '<a href="guide-admin.html">Guide administrateur</a>' +
      (avecAdmin
        ? '<span class="sep">·</span>' +
          '<a class="js-etab-admin" href="' + GRIST_URL + '" target="_blank" rel="noopener">Administration (Grist)</a>'
        : "") +
      "</div>" +
      '<p class="fr-footer-mention">' +
      '<span class="js-beta-mention"><span class="beta-tag">Version bêta</span> — vos retours sont les bienvenus · </span>' +
      "© M. Joan THUILLIER — Tous droits réservés." +
      "</p>" +
      "</div>";
    f.removeAttribute("data-no-admin");
  });
})();
