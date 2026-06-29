/* ============================================================
   REGNUM AETERNUM — Land Registry System
   Offline/no-backend fallback. Loaded as a plain script so the
   search page, record view, and cadastral map all still work when
   opened directly from disk or if /api/landregistry/data can't be
   reached — same role legal/assets/legal-data.js plays for the
   Legal Information System.

   No example plots are seeded here on purpose — the register starts
   empty and is populated entirely from the admin panel's Land
   Registry tab. This file's job is only to keep the division list
   (and the page chrome that reads it) working before any plots
   exist or if the live API is unreachable.
   ============================================================ */

(function () {
  "use strict";

  var divisions = [
    { code: "RA1M", name: "Ardoritha" },
    { code: "RA2V", name: "Vinland" },
    { code: "RA3D", name: "Meridia" },
    { code: "RA4L", name: "Littoria" },
    { code: "RA5A", name: "Algiers" }
  ];

  var plots = [];

  window.LAND_REGISTRY_DATA = { divisions: divisions, plots: plots };
})();
