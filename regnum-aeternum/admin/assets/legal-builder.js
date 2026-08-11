/* ============================================================
   REGNUM AETERNUM — Admin: Legal Act Builder
   A self-contained, vanilla-JS, click-to-build editor for an Act's
   `preamble` and `chapters` (see legal-data.js's header comment for
   the exact shapes). No build step, no dependencies — same
   philosophy as legal-app.js and auth-widget.js.

   Usage:
     var instance = LegalBuilder.mount(containerEl, { chapters, preamble }, {
       onChange: function (data) { ... },       // called after every edit
       getOwnActSlug: function () { ... },      // for "(this act)" self-refs
       getOwnActShortTitle: function () { ... }
     });
     instance.getData()         -> { chapters, preamble }
     instance.setData(data)
     instance.destroy()

   Design notes (so future edits don't have to reverse-engineer this):
   - `state` is the single source of truth, mutated in place. Every
     field in the rendered HTML carries a `data-path` describing where
     in `state` it lives, e.g. "chapters.0.articles.1.history.0.content.2.text".
     getByPath/setByPath just walk that dot-path against plain objects
     and arrays (numeric path segments work as array indices for free).
   - Typing in a text input/textarea mutates state directly via the
     `input` listener WITHOUT a full re-render, so focus/cursor position
     is never disturbed. Structural changes (add/remove/move/insert a
     reference token) DO re-render the whole builder from `state` — like
     legal-app.js's own list re-renders, this trades a little redundant
     DOM work for not having to hand-write a diffing renderer.
   - Cross-reference / case-law tokens stay inline text tokens
     ({{ref:slug:number}} / {{case:slug}}), matching the public site's
     renderer in legal-app.js — the picker UI just inserts that token
     text at the cursor, it isn't a separate structured field.
   ============================================================ */

(function () {
  "use strict";

  // ---------- generic helpers ----------

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function deepClone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function todayISO() {
    var d = new Date();
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  function toRoman(num) {
    var map = [[50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
    var res = "", n = num;
    map.forEach(function (pair) { while (n >= pair[0]) { res += pair[1]; n -= pair[0]; } });
    return res || "I";
  }

  // dot-path access against plain objects/arrays — numeric segments
  // work as array indices since `arr["3"] === arr[3]` in JS.
  function getByPath(obj, path) {
    var parts = String(path).split(".");
    var cur = obj;
    for (var i = 0; i < parts.length; i++) {
      if (cur == null) return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }
  function setByPath(obj, path, value) {
    var parts = String(path).split(".");
    var cur = obj;
    for (var i = 0; i < parts.length - 1; i++) {
      if (cur[parts[i]] == null) return;
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
  }

  // ---------- node / item factories ----------

  function newParagraphNode() { return { type: "paragraph", text: "" }; }
  function newHeadingNode() { return { type: "heading", level: 3, text: "" }; }
  function newListNode(style) { return { type: "list", style: style === "ordered" ? "ordered" : "unordered", items: [newListItem()] }; }
  function newListItem() { return { text: "" }; }
  function newChapter(state) {
    var n = state.chapters.length + 1;
    return { id: "ch-" + n, title: "Chapter " + toRoman(n) + " \u2014 New Chapter", articles: [] };
  }
  function newArticle(chapter) {
    var maxNum = 0;
    (chapter.articles || []).forEach(function (a) { if (a.number > maxNum) maxNum = a.number; });
    var n = maxNum + 1;
    return {
      id: "art-" + n, number: n, title: "New Article",
      history: [{ version: 1, date: todayISO(), changeNote: "Original text.", content: [newParagraphNode()] }],
      crossRefs: [], caseLawIds: []
    };
  }

  // ---------- lazy, cached lookups for the reference/case pickers ----------

  var dataCache = { acts: null, cases: null, actsPromise: null, casesPromise: null };
  function loadActs() {
    if (dataCache.acts) return Promise.resolve(dataCache.acts);
    if (!dataCache.actsPromise) {
      dataCache.actsPromise = fetch("/api/legal/acts")
        .then(function (r) { return r.ok ? r.json() : []; })
        .catch(function () { return []; })
        .then(function (list) { dataCache.acts = list; return list; });
    }
    return dataCache.actsPromise;
  }
  function loadCases() {
    if (dataCache.cases) return Promise.resolve(dataCache.cases);
    if (!dataCache.casesPromise) {
      dataCache.casesPromise = fetch("/api/legal/case-law")
        .then(function (r) { return r.ok ? r.json() : []; })
        .catch(function () { return []; })
        .then(function (list) { dataCache.cases = list; return list; });
    }
    return dataCache.casesPromise;
  }
  function caseLabelFor(slug) {
    if (dataCache.cases) {
      var found = dataCache.cases.filter(function (c) { return c.slug === slug; })[0];
      if (found) return found.refNumber + " \u2014 " + found.title;
    }
    return slug;
  }

  // ---------- the mountable instance ----------

  function mount(containerEl, initialData, opts) {
    var container = containerEl;
    var options = opts || {};
    var state = {
      chapters: deepClone((initialData && initialData.chapters) || []),
      preamble: deepClone((initialData && initialData.preamble) || [])
    };

    // -------- rendering --------

    function renderRoot() {
      return (
        '<div class="lb-section">' +
          '<div class="lb-section__head">' +
            '<h3 class="lb-section__title">Preamble</h3>' +
            '<p class="lb-hint">Recitals / "Whereas" clauses shown above Chapter I. Optional — leave empty if this document doesn\u2019t need one.</p>' +
          "</div>" +
          renderContentEditor(state.preamble, "preamble", { allowHeading: false }) +
        "</div>" +
        '<div class="lb-section">' +
          '<div class="lb-section__head lb-section__head--row">' +
            '<h3 class="lb-section__title">Chapters</h3>' +
            '<span class="lb-section__spacer"></span>' +
            '<button type="button" class="lb-btn lb-btn--sm" data-action="collapse-all-chapters">Collapse All</button>' +
            '<button type="button" class="lb-btn lb-btn--sm" data-action="expand-all-chapters">Expand All</button>' +
          "</div>" +
          '<div class="lb-chapters">' + state.chapters.map(renderChapter).join("") + "</div>" +
          '<div class="lb-addbar"><button type="button" class="lb-btn lb-btn--add" data-action="add-chapter">+ Add Chapter</button></div>' +
        "</div>"
      );
    }

    function renderChapter(chapter, ci) {
      var base = "chapters." + ci;
      var articleCount = (chapter.articles || []).length;
      return (
        '<div class="lb-chapter">' +
          '<div class="lb-chapter__head">' +
            '<button type="button" class="lb-toggle-btn" data-action="collapse" data-target="chapter-body-' + ci + '" title="Collapse/Expand chapter">\u25BC</button>' +
            '<div class="lb-field lb-field--grow"><label>Chapter Title</label><input class="lb-input" data-path="' + base + '.title" value="' + escapeHtml(chapter.title) + '"/></div>' +
            '<div class="lb-field lb-field--sm"><label>ID</label><input class="lb-input" data-path="' + base + '.id" value="' + escapeHtml(chapter.id) + '"/></div>' +
            '<span class="lb-collapse-count">' + articleCount + ' article' + (articleCount !== 1 ? 's' : '') + '</span>' +
            '<div class="lb-chapter__moves">' +
              '<button type="button" class="lb-icon-btn" data-action="move" data-path="chapters" data-index="' + ci + '" data-delta="-1" title="Move up">\u2191</button>' +
              '<button type="button" class="lb-icon-btn" data-action="move" data-path="chapters" data-index="' + ci + '" data-delta="1" title="Move down">\u2193</button>' +
              '<button type="button" class="lb-icon-btn lb-icon-btn--danger" data-action="remove" data-path="chapters" data-index="' + ci + '" data-confirm="Delete this chapter and all its articles?" title="Delete chapter">\u2715</button>' +
            "</div>" +
          "</div>" +
          '<div class="lb-chapter__body" id="chapter-body-' + ci + '">' +
            '<div class="lb-articles">' + chapter.articles.map(function (a, ai) { return renderArticle(a, base + ".articles", ai); }).join("") + "</div>" +
            '<div class="lb-addbar"><button type="button" class="lb-btn" data-action="add-article" data-path="' + base + '.articles">+ Add Article</button></div>' +
          "</div>" +
        "</div>"
      );
    }

    function renderArticle(article, arrPath, ai) {
      var base = arrPath + "." + ai;
      var lastIdx = article.history.length - 1;
      var current = article.history[lastIdx];
      var contentPath = base + ".history." + lastIdx + ".content";
      var articleBodyId = "article-body-" + arrPath.replace(/\./g, "-") + "-" + ai;
      return (
        '<div class="lb-article">' +
          '<div class="lb-article__head">' +
            '<button type="button" class="lb-toggle-btn" data-action="collapse" data-target="' + articleBodyId + '" title="Collapse/Expand article">\u25BC</button>' +
            '<div class="lb-field lb-field--num"><label>No.</label><input type="number" class="lb-input" data-num="1" data-path="' + base + '.number" value="' + article.number + '"/></div>' +
            '<div class="lb-field lb-field--grow"><label>Article Title</label><input class="lb-input" data-path="' + base + '.title" value="' + escapeHtml(article.title) + '"/></div>' +
            '<div class="lb-field lb-field--sm"><label>ID</label><input class="lb-input" data-path="' + base + '.id" value="' + escapeHtml(article.id) + '"/></div>' +
            '<div class="lb-article__moves">' +
              '<button type="button" class="lb-icon-btn" data-action="move" data-path="' + arrPath + '" data-index="' + ai + '" data-delta="-1" title="Move up">\u2191</button>' +
              '<button type="button" class="lb-icon-btn" data-action="move" data-path="' + arrPath + '" data-index="' + ai + '" data-delta="1" title="Move down">\u2193</button>' +
              '<button type="button" class="lb-icon-btn lb-icon-btn--danger" data-action="remove" data-path="' + arrPath + '" data-index="' + ai + '" data-confirm="Delete this article?" title="Delete article">\u2715</button>' +
            "</div>" +
          "</div>" +

          '<div class="lb-article__body" id="' + articleBodyId + '">' +
            '<div class="lb-version-bar">' +
              '<span class="lb-version-tag">v' + current.version + " \u00b7 " + escapeHtml(current.date || "") + "</span>" +
              '<input class="lb-input lb-input--note" data-path="' + base + ".history." + lastIdx + '.changeNote" value="' + escapeHtml(current.changeNote || "") + '" placeholder="Change note"/>' +
              '<button type="button" class="lb-btn lb-btn--ghost" data-action="new-version" data-path="' + base + '">+ New Version</button>' +
              (article.history.length > 1 ? '<span class="lb-version-count">' + article.history.length + " versions on file</span>" : "") +
            "</div>" +

            renderContentEditor(current.content || [], contentPath, { allowHeading: true }) +
            renderRefChips(article.crossRefs || [], base + ".crossRefs", "ref") +
            renderRefChips(article.caseLawIds || [], base + ".caseLawIds", "case") +
          "</div>" +
        "</div>"
      );
    }

    // Generic editor for an array of ContentNodes (paragraph/list/heading).
    // Used for an Act's preamble, an article's current-version content, and
    // recursively for a list item's nested `children`.
    function renderContentEditor(nodes, path, nodeOpts) {
      nodeOpts = nodeOpts || {};
      nodes = nodes || [];
      var nodesHtml = nodes.map(function (node, i) { return renderContentNode(node, path, i); }).join("");
      var buttons =
        '<button type="button" class="lb-btn lb-btn--sm" data-action="add-node" data-type="paragraph" data-path="' + path + '">+ Paragraph</button>' +
        '<button type="button" class="lb-btn lb-btn--sm" data-action="add-node" data-type="list" data-style="unordered" data-path="' + path + '">+ Bullet List</button>' +
        '<button type="button" class="lb-btn lb-btn--sm" data-action="add-node" data-type="list" data-style="ordered" data-path="' + path + '">+ Numbered List</button>' +
        (nodeOpts.allowHeading ? '<button type="button" class="lb-btn lb-btn--sm" data-action="add-node" data-type="heading" data-path="' + path + '">+ Sub-heading</button>' : "");
      return (
        '<div class="lb-content">' +
          (nodesHtml || '<p class="lb-empty">No content yet — add a paragraph or list below.</p>') +
          '<div class="lb-addbar lb-addbar--inline">' + buttons + "</div>" +
        "</div>"
      );
    }

    function renderMoveRemove(arrPath, i, removeLabel) {
      return (
        '<button type="button" class="lb-icon-btn" data-action="move" data-path="' + arrPath + '" data-index="' + i + '" data-delta="-1" title="Move up">\u2191</button>' +
        '<button type="button" class="lb-icon-btn" data-action="move" data-path="' + arrPath + '" data-index="' + i + '" data-delta="1" title="Move down">\u2193</button>' +
        '<button type="button" class="lb-icon-btn lb-icon-btn--danger" data-action="remove" data-path="' + arrPath + '" data-index="' + i + '" title="' + (removeLabel || "Remove") + '">\u2715</button>'
      );
    }

    function renderContentNode(node, arrPath, i) {
      var path = arrPath + "." + i;
      var moves = renderMoveRemove(arrPath, i, "Remove");

      if (node.type === "list") {
        var itemsHtml = (node.items || []).map(function (item, ii) { return renderListItem(item, path + ".items", ii); }).join("");
        return (
          '<div class="lb-node lb-node--list">' +
            '<div class="lb-node__bar">' +
              '<span class="lb-node__tag">' + (node.style === "ordered" ? "Numbered List" : "Bullet List") + "</span>" +
              '<select class="lb-select lb-select--sm" data-path="' + path + '.style">' +
                '<option value="unordered"' + (node.style !== "ordered" ? " selected" : "") + ">Bulleted</option>" +
                '<option value="ordered"' + (node.style === "ordered" ? " selected" : "") + ">Numbered</option>" +
              "</select>" +
              '<span class="lb-node__spacer"></span>' + moves +
            "</div>" +
            '<div class="lb-list-items">' + itemsHtml + "</div>" +
            '<button type="button" class="lb-btn lb-btn--sm lb-btn--ghost" data-action="add-list-item" data-path="' + path + '.items">+ Point</button>' +
          "</div>"
        );
      }

      if (node.type === "heading") {
        return (
          '<div class="lb-node lb-node--heading">' +
            '<div class="lb-node__bar">' +
              '<span class="lb-node__tag">Sub-heading</span>' +
              '<select class="lb-select lb-select--sm" data-num="1" data-path="' + path + '.level">' +
                [2, 3, 4].map(function (l) { return '<option value="' + l + '"' + (node.level === l ? " selected" : "") + ">H" + l + "</option>"; }).join("") +
              "</select>" +
              '<span class="lb-node__spacer"></span>' + moves +
            "</div>" +
            '<input class="lb-input" data-path="' + path + '.text" value="' + escapeHtml(node.text) + '" placeholder="Heading text"/>' +
          "</div>"
        );
      }

      // paragraph (default)
      return (
        '<div class="lb-node lb-node--paragraph">' +
          '<div class="lb-node__bar">' +
            '<span class="lb-node__tag">Paragraph</span>' +
            '<label class="lb-inline-check"><input type="checkbox" data-path="' + path + '.numbered"' + (node.numbered ? " checked" : "") + "/> Numbered (\u00a7)</label>" +
            '<span class="lb-node__spacer"></span>' +
            '<button type="button" class="lb-icon-btn" data-action="open-inline-picker" data-kind="ref" data-path="' + path + '.text" title="Insert cross-reference">[Art.]</button>' +
            '<button type="button" class="lb-icon-btn" data-action="open-inline-picker" data-kind="case" data-path="' + path + '.text" title="Insert case-law citation">[Case]</button>' +
            '<button type="button" class="lb-icon-btn" data-action="open-inline-picker" data-kind="heading" data-path="' + path + '.text" title="Insert sub-heading reference">[\u00a7]</button>' +
            moves +
          "</div>" +
          '<textarea class="lb-textarea" data-path="' + path + '.text" rows="2" placeholder="Paragraph text">' + escapeHtml(node.text || "") + "</textarea>" +
        "</div>"
      );
    }

    function renderListItem(item, arrPath, i) {
      var path = arrPath + "." + i;
      var hasChildren = Array.isArray(item.children) && item.children.length > 0;
      return (
        '<div class="lb-list-item">' +
          '<div class="lb-list-item__row">' +
            '<span class="lb-list-item__bullet">\u2022</span>' +
            '<input class="lb-input lb-input--grow" data-path="' + path + '.text" value="' + escapeHtml(item.text) + '" placeholder="Point text"/>' +
            '<button type="button" class="lb-icon-btn" data-action="open-inline-picker" data-kind="ref" data-path="' + path + '.text" title="Insert cross-reference">[Art.]</button>' +
            '<button type="button" class="lb-icon-btn" data-action="open-inline-picker" data-kind="case" data-path="' + path + '.text" title="Insert case-law citation">[Case]</button>' +
            '<button type="button" class="lb-icon-btn" data-action="open-inline-picker" data-kind="heading" data-path="' + path + '.text" title="Insert sub-heading reference">[\u00a7]</button>' +
            (hasChildren ? "" : '<button type="button" class="lb-icon-btn" data-action="add-sublist" data-path="' + path + '" title="Add sub-points">\u21B3</button>') +
            renderMoveRemove(arrPath, i, "Remove point") +
          "</div>" +
          (hasChildren ? '<div class="lb-list-item__children">' + renderContentEditor(item.children, path + ".children", { allowHeading: false }) + "</div>" : "") +
        "</div>"
      );
    }

    function renderRefChips(items, path, kind) {
      var chips = items.map(function (item, i) {
        var label = kind === "case" ? caseLabelFor(item) : (item.label || (item.actSlug + ", Art. " + item.number));
        return '<span class="lb-chip">' + escapeHtml(label) +
          '<button type="button" class="lb-chip__x" data-action="remove" data-path="' + path + '" data-index="' + i + '" title="Remove">\u2715</button>' +
        "</span>";
      }).join("");
      var heading = kind === "case" ? "Related Case Law" : "Cross-References";
      return (
        '<div class="lb-refs">' +
          '<div class="lb-refs__head">' +
            '<span class="lb-refs__label">' + heading + "</span>" +
            '<button type="button" class="lb-btn lb-btn--ghost lb-btn--sm" data-action="open-array-picker" data-kind="' + kind + '" data-target="' + path + '">+ Add</button>' +
          "</div>" +
          '<div class="lb-chips">' + (chips || '<span class="lb-empty">None</span>') + "</div>" +
        "</div>"
      );
    }

    // -------- structural mutation helpers --------

    function moveInArrayAtPath(path, index, delta) {
      var arr = getByPath(state, path);
      if (!Array.isArray(arr)) return;
      var to = index + delta;
      if (to < 0 || to >= arr.length) return;
      var tmp = arr[index]; arr[index] = arr[to]; arr[to] = tmp;
    }
    function removeFromArrayAtPath(path, index) {
      var arr = getByPath(state, path);
      if (Array.isArray(arr)) arr.splice(index, 1);
    }
    function pushToArrayAtPath(path, value) {
      var arr = getByPath(state, path);
      if (Array.isArray(arr)) arr.push(value);
    }

    var collapsedIds = {};

    function setAllCollapsed(collapse) {
      // Walk all chapter and article body elements and collapse/expand them.
      var bodies = container.querySelectorAll(".lb-chapter__body, .lb-article__body");
      for (var i = 0; i < bodies.length; i++) {
        var body = bodies[i];
        var id = body.id;
        var btn = container.querySelector('[data-target="' + id + '"]');
        if (collapse) {
          body.classList.add("collapsed");
          collapsedIds[id] = true;
          if (btn) { btn.classList.add("lb-toggle-btn--collapsed"); btn.innerHTML = "\u25B6"; }
        } else {
          body.classList.remove("collapsed");
          delete collapsedIds[id];
          if (btn) { btn.classList.remove("lb-toggle-btn--collapsed"); btn.innerHTML = "\u25BC"; }
        }
      }
    }

    function rerender() {
      container.innerHTML = renderRoot();
      // Re-apply collapsed state after full re-render
      Object.keys(collapsedIds).forEach(function (id) {
        var body = document.getElementById(id);
        var btn = container.querySelector('[data-target="' + id + '"]');
        if (body) body.classList.add("collapsed");
        if (btn) { btn.classList.add("lb-toggle-btn--collapsed"); btn.innerHTML = "\u25B6"; }
      });
      notifyChange();
    }
    function notifyChange() {
      if (typeof options.onChange === "function") {
        try { options.onChange(getData()); } catch (e) { /* ignore listener errors */ }
      }
    }

    // -------- pickers (insert {{ref:..}}/{{case:..}} tokens, or add a chip) --------

    function closeOpenPickers() {
      var open = container.querySelectorAll(".lb-picker");
      for (var i = 0; i < open.length; i++) open[i].parentNode.removeChild(open[i]);
    }

    // Given a field path inside an article's content (e.g.
    // "chapters.0.articles.1.history.0.content.2.text"), walk the current
    // version's content array and return all heading texts found.
    function getHeadingsInArticle(fieldPath) {
      var parts = fieldPath.split(".");
      var histIdx = parts.indexOf("history");
      if (histIdx === -1) return [];
      var articlePath = parts.slice(0, histIdx).join(".");
      var article = getByPath(state, articlePath);
      if (!article || !Array.isArray(article.history)) return [];
      var current = article.history[article.history.length - 1];
      if (!current || !Array.isArray(current.content)) return [];
      var headings = [];
      function walk(nodes) {
        (nodes || []).forEach(function (node) {
          if (node && node.type === "heading" && node.text && node.text.trim()) {
            headings.push(node.text.trim());
          }
          if (node && node.type === "list" && Array.isArray(node.items)) {
            node.items.forEach(function (item) {
              if (Array.isArray(item.children)) walk(item.children);
            });
          }
        });
      }
      walk(current.content);
      return headings;
    }

    function buildHeadingPickerPanel(onInsert) {
      var panel = document.createElement("div");
      panel.className = "lb-picker";
      panel.innerHTML =
        '<div class="lb-picker__row"><select class="lb-select lb-picker-heading"><option value="">Choose a sub-heading\u2026</option></select></div>' +
        '<div class="lb-picker__actions">' +
          '<button type="button" class="lb-btn lb-btn--sm" data-pk="cancel">Cancel</button>' +
          '<button type="button" class="lb-btn lb-btn--sm lb-btn--primary" data-pk="go">Insert</button>' +
        "</div>";

      panel.querySelector('[data-pk="cancel"]').addEventListener("click", function () { panel.parentNode.removeChild(panel); });
      panel.querySelector('[data-pk="go"]').addEventListener("click", function () {
        var val = panel.querySelector(".lb-picker-heading").value;
        if (val) onInsert(val);
        if (panel.parentNode) panel.parentNode.removeChild(panel);
      });
      return panel;
    }

    // Fills a heading picker panel's dropdown with headings from the
    // article that contains the given field path.
    function populateHeadingPicker(panel, fieldPath) {
      var sel = panel.querySelector(".lb-picker-heading");
      if (!sel) return;
      var headings = getHeadingsInArticle(fieldPath);
      sel.innerHTML = headings.length
        ? '<option value="">Choose a sub-heading\u2026</option>' +
          headings.map(function (h) { return '<option value="' + escapeHtml(h) + '">' + escapeHtml(h) + "</option>"; }).join("")
        : '<option value="">No sub-headings in this article</option>';
    }

    function buildCasePickerPanel(onInsert) {
      var panel = document.createElement("div");
      panel.className = "lb-picker";
      panel.innerHTML =
        '<div class="lb-picker__row"><select class="lb-select lb-picker-case"><option value="">Loading\u2026</option></select></div>' +
        '<div class="lb-picker__actions">' +
          '<button type="button" class="lb-btn lb-btn--sm" data-pk="cancel">Cancel</button>' +
          '<button type="button" class="lb-btn lb-btn--sm lb-btn--primary" data-pk="go">Add</button>' +
        "</div>";
      loadCases().then(function (cases) {
        var sel = panel.querySelector(".lb-picker-case");
        sel.innerHTML = cases.length
          ? cases.map(function (c) { return '<option value="' + escapeHtml(c.slug) + '">' + escapeHtml(c.refNumber + " \u2014 " + c.title) + "</option>"; }).join("")
          : '<option value="">No case law on file</option>';
      });
      panel.querySelector('[data-pk="cancel"]').addEventListener("click", function () { panel.parentNode.removeChild(panel); });
      panel.querySelector('[data-pk="go"]').addEventListener("click", function () {
        var slug = panel.querySelector(".lb-picker-case").value;
        if (slug) onInsert(slug);
        if (panel.parentNode) panel.parentNode.removeChild(panel);
      });
      return panel;
    }

    function buildRefPickerPanel(onInsert) {
      var panel = document.createElement("div");
      panel.className = "lb-picker";
      panel.innerHTML =
        '<div class="lb-picker__row">' +
          '<select class="lb-select lb-picker-act"><option value="__own__">(this act)</option></select>' +
          '<select class="lb-select lb-picker-art"><option value="">Loading\u2026</option></select>' +
        "</div>" +
        '<div class="lb-picker__actions">' +
          '<button type="button" class="lb-btn lb-btn--sm" data-pk="cancel">Cancel</button>' +
          '<button type="button" class="lb-btn lb-btn--sm lb-btn--primary" data-pk="go">Add</button>' +
        "</div>";

      var actSel = panel.querySelector(".lb-picker-act");
      var artSel = panel.querySelector(".lb-picker-art");

      function fillOwnArticles() {
        var list = [];
        state.chapters.forEach(function (c) { c.articles.forEach(function (a) { list.push(a); }); });
        artSel.innerHTML = list.length
          ? list.map(function (a) { return '<option value="' + a.number + '">Art. ' + a.number + " \u2014 " + escapeHtml(a.title) + "</option>"; }).join("")
          : '<option value="">No articles yet</option>';
      }
      fillOwnArticles();

      loadActs().then(function (acts) {
        actSel.innerHTML = '<option value="__own__">(this act)</option>' +
          acts.map(function (a) { return '<option value="' + escapeHtml(a.slug) + '">' + escapeHtml(a.shortTitle) + "</option>"; }).join("");
        actSel.addEventListener("change", function () {
          if (actSel.value === "__own__") { fillOwnArticles(); return; }
          var act = acts.filter(function (a) { return a.slug === actSel.value; })[0];
          var list = [];
          (act ? act.chapters : []).forEach(function (c) { c.articles.forEach(function (a) { list.push(a); }); });
          artSel.innerHTML = list.length
            ? list.map(function (a) { return '<option value="' + a.number + '">Art. ' + a.number + " \u2014 " + escapeHtml(a.title) + "</option>"; }).join("")
            : '<option value="">No articles</option>';
        });
      });

      panel.querySelector('[data-pk="cancel"]').addEventListener("click", function () { panel.parentNode.removeChild(panel); });
      panel.querySelector('[data-pk="go"]').addEventListener("click", function () {
        var num = parseInt(artSel.value, 10);
        if (!num) { if (panel.parentNode) panel.parentNode.removeChild(panel); return; }
        var isOwn = actSel.value === "__own__";
        var actSlug = isOwn ? (options.getOwnActSlug ? options.getOwnActSlug() : "") : actSel.value;
        var actShortTitle = isOwn
          ? (options.getOwnActShortTitle ? options.getOwnActShortTitle() : "This Act")
          : (actSel.options[actSel.selectedIndex] ? actSel.options[actSel.selectedIndex].text : actSlug);
        var artText = artSel.options[artSel.selectedIndex] ? artSel.options[artSel.selectedIndex].text : "";
        var artTitle = artText.replace(/^Art\.\s*\d+\s*\u2014\s*/, "");
        onInsert({ actSlug: actSlug, number: num, actShortTitle: actShortTitle, artTitle: artTitle });
        if (panel.parentNode) panel.parentNode.removeChild(panel);
      });
      return panel;
    }

    // Adds a structured chip to article.crossRefs / article.caseLawIds.
    function openArrayPicker(btn) {
      closeOpenPickers();
      var kind = btn.getAttribute("data-kind");
      var target = btn.getAttribute("data-target");
      var anchor = btn.closest(".lb-refs");
      if (!anchor) return;

      if (kind === "case") {
        anchor.appendChild(buildCasePickerPanel(function (slug) {
          pushToArrayAtPath(target, slug);
          rerender();
        }));
      } else {
        anchor.appendChild(buildRefPickerPanel(function (picked) {
          var label = picked.actShortTitle + ", Art. " + picked.number + (picked.artTitle ? " \u2014 " + picked.artTitle : "");
          pushToArrayAtPath(target, { actSlug: picked.actSlug, number: picked.number, label: label });
          rerender();
        }));
      }
    }

    // Inserts an inline {{ref:..}}/{{case:..}}/{{heading:..}} token into a paragraph/point's text field.
    function openInlinePicker(btn) {
      closeOpenPickers();
      var kind = btn.getAttribute("data-kind");
      var path = btn.getAttribute("data-path");
      var fieldEl = container.querySelector('[data-path="' + path + '"]');
      if (!fieldEl) return;

      function insertToken(token) {
        var start = fieldEl.selectionStart != null ? fieldEl.selectionStart : fieldEl.value.length;
        var end = fieldEl.selectionEnd != null ? fieldEl.selectionEnd : fieldEl.value.length;
        var next = fieldEl.value.slice(0, start) + token + fieldEl.value.slice(end);
        fieldEl.value = next;
        setByPath(state, path, next);
        var newPos = start + token.length;
        fieldEl.focus();
        try { fieldEl.setSelectionRange(newPos, newPos); } catch (e) { /* not all input types support this */ }
        notifyChange();
      }

      if (kind === "heading") {
        var hpanel = buildHeadingPickerPanel(function (headingText) {
          insertToken("{{heading:" + headingText + "}}");
        });
        populateHeadingPicker(hpanel, path);
        hpanel.className += " lb-picker--inline";
        fieldEl.insertAdjacentElement("afterend", hpanel);
        return;
      }

      var panel = kind === "case"
        ? buildCasePickerPanel(function (slug) { insertToken("{{case:" + slug + "}}"); })
        : buildRefPickerPanel(function (picked) { insertToken("{{ref:" + picked.actSlug + ":" + picked.number + "}}"); });
      panel.className += " lb-picker--inline";
      fieldEl.insertAdjacentElement("afterend", panel);
    }

    // -------- event delegation --------

    function onInput(e) {
      var fld = e.target;
      var path = fld.getAttribute && fld.getAttribute("data-path");
      if (!path) return;
      if (fld.type === "checkbox") setByPath(state, path, fld.checked);
      else if (fld.hasAttribute("data-num")) {
        var n = parseFloat(fld.value);
        setByPath(state, path, isNaN(n) ? 0 : n);
      } else setByPath(state, path, fld.value);
      notifyChange();
    }

    function onChangeEvt(e) {
      var fld = e.target;
      if (!fld || fld.tagName !== "SELECT") return;
      var path = fld.getAttribute("data-path");
      if (!path) return;
      if (fld.hasAttribute("data-num")) {
        var n = parseInt(fld.value, 10);
        setByPath(state, path, isNaN(n) ? fld.value : n);
      } else {
        setByPath(state, path, fld.value);
      }
      rerender();
    }

    function onClick(e) {
      var btn = e.target.closest && e.target.closest("[data-action]");
      if (!btn || !container.contains(btn)) return;
      var action = btn.getAttribute("data-action");

      if (action === "add-chapter") { state.chapters.push(newChapter(state)); return rerender(); }

      if (action === "add-article") {
        var chapterPath = btn.getAttribute("data-path").replace(/\.articles$/, "");
        var chapter = getByPath(state, chapterPath);
        var list = getByPath(state, btn.getAttribute("data-path"));
        if (chapter && list) list.push(newArticle(chapter));
        return rerender();
      }

      if (action === "new-version") {
        var article = getByPath(state, btn.getAttribute("data-path"));
        if (!article) return;
        var note = window.prompt("Change note for this new version:", "");
        if (note === null) return; // cancelled
        var last = article.history[article.history.length - 1];
        article.history.push({ version: last.version + 1, date: todayISO(), changeNote: note || "Revised text.", content: deepClone(last.content || []) });
        return rerender();
      }

      if (action === "add-node") {
        var arr = getByPath(state, btn.getAttribute("data-path"));
        if (!arr) return;
        var type = btn.getAttribute("data-type");
        arr.push(type === "list" ? newListNode(btn.getAttribute("data-style")) : type === "heading" ? newHeadingNode() : newParagraphNode());
        return rerender();
      }

      if (action === "add-list-item") {
        var items = getByPath(state, btn.getAttribute("data-path"));
        if (items) items.push(newListItem());
        return rerender();
      }

      if (action === "add-sublist") {
        var item = getByPath(state, btn.getAttribute("data-path"));
        if (item) item.children = [newListNode("unordered")];
        return rerender();
      }

      if (action === "move") {
        moveInArrayAtPath(btn.getAttribute("data-path"), parseInt(btn.getAttribute("data-index"), 10), parseInt(btn.getAttribute("data-delta"), 10));
        return rerender();
      }

      if (action === "remove") {
        var confirmMsg = btn.getAttribute("data-confirm");
        if (confirmMsg && !window.confirm(confirmMsg)) return;
        removeFromArrayAtPath(btn.getAttribute("data-path"), parseInt(btn.getAttribute("data-index"), 10));
        return rerender();
      }

      if (action === "collapse-all-chapters") {
        setAllCollapsed(true);
        return;
      }

      if (action === "expand-all-chapters") {
        setAllCollapsed(false);
        return;
      }

      if (action === "collapse") {
        var targetId = btn.getAttribute("data-target");
        var target = document.getElementById(targetId);
        if (!target) return;
        if (target.classList.contains("collapsed")) {
          target.classList.remove("collapsed");
          btn.classList.remove("lb-toggle-btn--collapsed");
          btn.innerHTML = "\u25BC";
          delete collapsedIds[targetId];
        } else {
          target.classList.add("collapsed");
          btn.classList.add("lb-toggle-btn--collapsed");
          btn.innerHTML = "\u25B6";
          collapsedIds[targetId] = true;
        }
        return;
      }

      if (action === "open-array-picker") return openArrayPicker(btn);
      if (action === "open-inline-picker") return openInlinePicker(btn);
    }

    container.addEventListener("input", onInput);
    container.addEventListener("change", onChangeEvt);
    container.addEventListener("click", onClick);

    // Warm the act/case caches early so the first picker open feels instant.
    loadActs();
    loadCases().then(function () { rerender(); });

    rerender();

    // -------- public instance API --------

    function getData() { return { chapters: deepClone(state.chapters), preamble: deepClone(state.preamble) }; }
    function setData(data) {
      state.chapters = deepClone((data && data.chapters) || []);
      state.preamble = deepClone((data && data.preamble) || []);
      rerender();
    }
    function destroy() {
      container.removeEventListener("input", onInput);
      container.removeEventListener("change", onChangeEvt);
      container.removeEventListener("click", onClick);
      container.innerHTML = "";
    }

    return { getData: getData, setData: setData, destroy: destroy };
  }

  window.LegalBuilder = { mount: mount };
})();
