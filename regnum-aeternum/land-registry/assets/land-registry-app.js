/* ============================================================
   REGNUM AETERNUM — Land Registry System
   Shared application logic for the public-facing pages (search/
   browse hub, single-record view, not-found). The cadastral map
   has its own script (land-registry/map/assets is self-contained,
   see map/index.html) since its DynMap/3D logic doesn't overlap
   with this file.

   Register number format: DIVISION/8-DIGIT-BOOK-NUMBER/1-DIGIT
   CONTROL, e.g. "RA1M/00000123/4" — generated the same way the
   reference search tool this replaces did it (zero-pad the book
   number to 8 digits, take a single control digit), so existing
   muscle memory and any paper records using the old tool still work.
   ============================================================ */

var LandApp = (function () {
  "use strict";

  var DATA = (window.LAND_REGISTRY_DATA || { divisions: [], plots: [] });

  // DATA starts as the static fallback (works offline/from disk).
  // loadData() then tries to replace it with the live, admin-edited
  // dataset from D1 via the Worker API — same race-with-timeout
  // pattern as legal/assets/legal-app.js's loadData().
  function loadData() {
    var timeout = new Promise(function (resolve) { setTimeout(function () { resolve(null); }, 4000); });
    var fetched = fetch("/api/landregistry/data").then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
    return Promise.race([fetched, timeout]).then(function (live) {
      if (live && Array.isArray(live.divisions) && Array.isArray(live.plots)) DATA = live;
    });
  }

  // ---------- util ----------

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function formatDate(iso) {
    if (!iso) return "";
    var parts = iso.split("-");
    if (parts.length !== 3) return iso;
    var d = new Date(Date.UTC(+parts[0], +parts[1] - 1, +parts[2]));
    var months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    return d.getUTCDate() + " " + months[d.getUTCMonth()] + " " + d.getUTCFullYear();
  }

  function qs(sel, root) { return (root || document).querySelector(sel); }
  function getQueryParam(name) {
    var re = new RegExp("[?&]" + name + "=([^&]*)");
    var m = re.exec(window.location.search || "");
    return m ? decodeURIComponent(m[1].replace(/\+/g, " ")) : null;
  }

  function divisionName(code) {
    var d = DATA.divisions.filter(function (x) { return x.code === code; })[0];
    return d ? d.name : code;
  }

  function statusMeta(status) {
    if (status === "vacant") return { label: "Vacant", cls: "tag--vacant" };
    if (status === "disputed") return { label: "Disputed", cls: "tag--disputed" };
    if (status === "archived") return { label: "Archived", cls: "tag--archived" };
    return { label: "Registered", cls: "tag--registered" };
  }

  var PLOT_TYPE_LABELS = {
    residential: "Residential", commercial: "Commercial", agricultural: "Agricultural",
    industrial: "Industrial", civic: "Civic", storage: "Storage", vacant: "Vacant Lot", other: "Other"
  };
  function plotTypeLabel(t) { return PLOT_TYPE_LABELS[t] || (t ? t.charAt(0).toUpperCase() + t.slice(1) : "\u2014"); }

  // Builds the canonical register number from raw form input, with
  // the exact zero-pad/truncate rules the reference search tool used:
  // book number -> 8 digits (left-padded with zeros, then capped at
  // 8 characters); control digit -> a single character.
  function buildRegisterNumber(division, bookRaw, controlRaw) {
    var number = String(bookRaw || "0").padStart(8, "0").slice(0, 8);
    var control = String(controlRaw || "0").slice(0, 1);
    return division + "/" + number + "/" + control;
  }

  function findPlotLocal(registerNumber) {
    return DATA.plots.filter(function (p) { return p.registerNumber === registerNumber; })[0] || null;
  }

  // ---------- search form (index.html) ----------

  function initSearchForm() {
    var divisionEl = document.getElementById("divisionCode");
    var bookEl = document.getElementById("bookNumber");
    var controlEl = document.getElementById("controlDigit");
    var generatedEl = document.getElementById("generatedNumber");
    var searchBtn = document.getElementById("searchBookBtn");
    if (!divisionEl || !bookEl || !controlEl || !generatedEl || !searchBtn) return;

    function updatePreview() {
      generatedEl.textContent = buildRegisterNumber(divisionEl.value, bookEl.value, controlEl.value);
    }

    divisionEl.addEventListener("change", updatePreview);
    bookEl.addEventListener("input", function () {
      if (this.value.length > 8) this.value = this.value.slice(0, 8);
      updatePreview();
    });
    controlEl.addEventListener("input", function () {
      if (this.value.length > 1) this.value = this.value.slice(0, 1);
      updatePreview();
    });

    searchBtn.addEventListener("click", function () {
      var fullNumber = buildRegisterNumber(divisionEl.value, bookEl.value, controlEl.value);
      searchBtn.disabled = true;
      fetch("/api/landregistry/plots/" + encodeURIComponent(fullNumber))
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; })
        .then(function (found) {
          searchBtn.disabled = false;
          if (!found) found = findPlotLocal(fullNumber); // offline fallback
          if (!found) {
            window.location.href = "not-found.html?kw=" + encodeURIComponent(fullNumber);
            return;
          }
          window.location.href = "record/view.html?kw=" + encodeURIComponent(fullNumber);
        });
    });

    updatePreview();
  }

  // ---------- browse hub (index.html) ----------

  function plotCardHtml(p) {
    var st = statusMeta(p.status);
    return '<a class="landcard" href="record/view.html?kw=' + encodeURIComponent(p.registerNumber) + '">' +
      '<div class="landcard__top">' +
        '<p class="landcard__number">' + escapeHtml(p.registerNumber) + "</p>" +
        '<span class="tag ' + st.cls + '">' + st.label + "</span>" +
      "</div>" +
      '<p class="landcard__sub">' + escapeHtml(divisionName(p.divisionCode)) + " \u2014 " + escapeHtml(plotTypeLabel(p.plotType)) + "</p>" +
      '<div class="landcard__chips">' +
        '<div class="chip"><span class="chip__label">Owner</span><span class="chip__value">' + escapeHtml(p.owner || "Unclaimed") + "</span></div>" +
        '<div class="chip"><span class="chip__label">Resident</span><span class="chip__value">' + escapeHtml(p.resident || "\u2014") + "</span></div>" +
        (p.isRented ? '<div class="chip"><span class="chip__label">Rented</span><span class="chip__value">Yes</span></div>' : "") +
        '<div class="chip"><span class="chip__label">Y Level</span><span class="chip__value">' + p.yLower + "\u2013" + p.yUpper + "</span></div>" +
      "</div>" +
    "</a>";
  }

  function initHub() {
    var divEl = document.getElementById("land-divisions");
    var listEl = document.getElementById("land-recent-list");
    if (!divEl && !listEl) return;

    if (divEl) {
      divEl.innerHTML = DATA.divisions.map(function (d) {
        var count = DATA.plots.filter(function (p) { return p.divisionCode === d.code; }).length;
        return '<a class="landdivision" href="map/?division=' + d.code + '">' +
          '<p class="landdivision__code">' + d.code + "</p>" +
          '<p class="landdivision__name">' + escapeHtml(d.name) + "</p>" +
          '<p class="landdivision__count">' + count + (count === 1 ? " plot on file" : " plots on file") + "</p>" +
        "</a>";
      }).join("");
    }

    if (listEl) {
      var recent = DATA.plots.slice().sort(function (a, b) {
        return String(b.registeredDate || "").localeCompare(String(a.registeredDate || ""));
      }).slice(0, 6);
      listEl.innerHTML = recent.length ? recent.map(plotCardHtml).join("") :
        '<p class="landempty">No plots have been registered yet.</p>';
    }
  }

  // ---------- single record view ----------

  function initRecordView() {
    var root = document.getElementById("recordview-root");
    if (!root) return;
    var kw = getQueryParam("kw");

    function render(plot) {
      if (!plot) {
        window.location.href = "../not-found.html?kw=" + encodeURIComponent(kw || "");
        return;
      }
      var st = statusMeta(plot.status);
      document.title = plot.registerNumber + " \u2014 Regnum Aeternum";

      var rentBlock = plot.isRented
        ? '<div class="recordview__grid">' +
            '<div class="chip"><span class="chip__label">Renter</span><span class="chip__value">' + escapeHtml(plot.renter || "Unnamed") + "</span></div>" +
            '<div class="chip"><span class="chip__label">Rent</span><span class="chip__value">' + (plot.rentAmount ? escapeHtml(String(plot.rentAmount)) + " " + escapeHtml(plot.rentCurrency || "") : "\u2014") + "</span></div>" +
            '<div class="chip"><span class="chip__label">Due</span><span class="chip__value">' + (plot.rentDueDate ? formatDate(plot.rentDueDate) : "\u2014") + "</span></div>" +
          "</div>"
        : '<p class="recordview__notes">This plot is not currently let.</p>';

      var cornersRows = (plot.corners || []).map(function (c, i) {
        return "<tr><td>Corner " + (i + 1) + "</td><td>" + c.x + "</td><td>" + c.z + "</td></tr>";
      }).join("");

      root.innerHTML =
        '<p class="recordview__eyebrow">' + escapeHtml(divisionName(plot.divisionCode)) + " \u00b7 " + plot.divisionCode + "</p>" +
        '<h1 class="recordview__title">' + escapeHtml(plot.registerNumber) + "</h1>" +
        '<div class="recordview__chips">' +
          '<span class="tag ' + st.cls + '">' + st.label + "</span>" +
          '<span class="tag tag--rented">' + escapeHtml(plotTypeLabel(plot.plotType)) + "</span>" +
          (plot.isRented ? '<span class="tag tag--rented">Rented</span>' : "") +
        "</div>" +

        '<div class="recordview__section"><h2>Ownership &amp; Occupancy</h2>' +
          '<div class="recordview__grid">' +
            '<div class="chip"><span class="chip__label">Owner</span><span class="chip__value">' + escapeHtml(plot.owner || "Unclaimed (Crown land)") + "</span></div>" +
            '<div class="chip"><span class="chip__label">Resident</span><span class="chip__value">' + escapeHtml(plot.resident || "\u2014") + "</span></div>" +
            '<div class="chip"><span class="chip__label">Registered</span><span class="chip__value">' + (plot.registeredDate ? formatDate(plot.registeredDate) : "\u2014") + "</span></div>" +
          "</div>" +
        "</div>" +

        '<div class="recordview__section"><h2>Tenancy</h2>' + rentBlock + "</div>" +

        '<div class="recordview__section"><h2>Location</h2>' +
          '<div class="recordview__grid" style="margin-bottom:14px;">' +
            '<div class="chip"><span class="chip__label">World</span><span class="chip__value">' + escapeHtml(plot.world || "\u2014") + "</span></div>" +
            '<div class="chip"><span class="chip__label">Y Lower</span><span class="chip__value">' + plot.yLower + "</span></div>" +
            '<div class="chip"><span class="chip__label">Y Upper</span><span class="chip__value">' + plot.yUpper + "</span></div>" +
          "</div>" +
          '<table class="cornerstable"><thead><tr><th>Corner</th><th>X</th><th>Z</th></tr></thead><tbody>' + cornersRows + "</tbody></table>" +
          '<p style="margin-top:18px;">' +
            '<a class="recordview__mapcta" href="../map/?focus=' + encodeURIComponent(plot.registerNumber) + '">' +
              "View on the Cadastral Map" +
            "</a>" +
          "</p>" +
        "</div>" +

        (plot.notes ? '<div class="recordview__section"><h2>Notes</h2><p class="recordview__notes">' + escapeHtml(plot.notes) + "</p></div>" : "");
    }

    if (!kw) { window.location.href = "../index.html"; return; }

    fetch("/api/landregistry/plots/" + encodeURIComponent(kw))
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (plot) { render(plot || findPlotLocal(kw)); });
  }

  // ---------- not found ----------

  function initNotFound() {
    var el = document.getElementById("notfound-kw");
    if (!el) return;
    var kw = getQueryParam("kw");
    el.textContent = kw || "(no register number given)";
  }

  function initAll() {
    initSearchForm();
    initHub();
    initRecordView();
    initNotFound();
  }

  return {
    buildRegisterNumber: buildRegisterNumber,
    escapeHtml: escapeHtml,
    formatDate: formatDate,
    divisionName: divisionName,
    init: function () { return loadData().then(initAll); }
  };
})();

document.addEventListener("DOMContentLoaded", LandApp.init);
