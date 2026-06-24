/* ============================================================
   REGNUM AETERNUM — Legal Information System
   Shared application logic. One file, several small modules:
     - util: formatting helpers
     - stem/levenshtein: lightweight typo & word-form tolerance
     - index/search: builds a flat search index and ranks matches
     - articleQuery: parses "art. 15" / "art. 15 penal code"
     - diff: word-level diff for version comparison
     - render: page-specific render/init functions, auto-detected
   No build step, no external dependencies — works from disk or
   from any static host.
   ============================================================ */

var LegalApp = (function () {
  "use strict";

  var DATA = (window.LEGAL_DATA || { acts: [], caseLaw: [] });

  // ---------- data loading ----------
  // DATA starts as whatever legal-data.js provided (loaded synchronously,
  // works offline/from disk — that's an intentional fallback, not a bug).
  // On a real deployment we then try to replace it with the live,
  // admin-editable dataset from D1 via the Worker API. If that fetch
  // fails or times out (offline, opened from disk, API down), the
  // static fallback already in DATA is left exactly as-is.
  function loadData() {
    var timeout = new Promise(function (resolve) { setTimeout(function () { resolve(null); }, 4000); });
    var fetched = fetch("/api/legal/data").then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });

    return Promise.race([fetched, timeout]).then(function (live) {
      if (live && Array.isArray(live.acts) && Array.isArray(live.caseLaw)) {
        DATA = live;
        INDEX = null; // invalidate the memoized search index so it rebuilds against the new DATA
      }
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
    var d = new Date(Date.UTC(+parts[0], +parts[1] - 1, +parts[2]));
    var months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    return d.getUTCDate() + " " + months[d.getUTCMonth()] + " " + d.getUTCFullYear();
  }

  function debounce(fn, ms) {
    var t;
    return function () {
      var args = arguments, ctx = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(ctx, args); }, ms);
    };
  }

  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function getQueryParam(name) {
    var search = window.location.search || "";
    var re = new RegExp("[?&]" + name + "=([^&]*)");
    var m = re.exec(search);
    return m ? decodeURIComponent(m[1].replace(/\+/g, " ")) : null;
  }

  function statusMeta(status) {
    if (status === "repealed") return { label: "Repealed", cls: "tag--repealed" };
    if (status === "amended") return { label: "Amended", cls: "tag--amended" };
    return { label: "In Force", cls: "tag--inforce" };
  }

  function categoryLabel(cat) {
    var map = { constitution: "Constitution", code: "Code", act: "Act", regulation: "Regulation" };
    return map[cat] || cat;
  }

  // ---------- data accessors ----------

  function getAct(slug) {
    for (var i = 0; i < DATA.acts.length; i++) if (DATA.acts[i].slug === slug) return DATA.acts[i];
    return null;
  }

  function getArticle(actSlug, number) {
    var act = getAct(actSlug);
    if (!act) return null;
    for (var c = 0; c < act.chapters.length; c++) {
      var arts = act.chapters[c].articles;
      for (var a = 0; a < arts.length; a++) {
        if (arts[a].number === Number(number)) return { act: act, chapter: act.chapters[c], article: arts[a] };
      }
    }
    return null;
  }

  function getCase(slug) {
    for (var i = 0; i < DATA.caseLaw.length; i++) if (DATA.caseLaw[i].slug === slug) return DATA.caseLaw[i];
    return null;
  }

  function currentText(article) {
    return historyEntryFlatText(article.history[article.history.length - 1]);
  }

  // ---------- structured content model (paragraphs / lists / headings) ----------
  // An article version (and an Act's `preamble`) is an array of ContentNodes:
  //   { type: "paragraph", text, numbered }
  //   { type: "list", style: "ordered"|"unordered", items: [{ text, children }] }
  //   { type: "heading", text, level }
  // Older data may instead have a flat `text` string on the history entry —
  // historyEntryContent() normalizes both shapes to a ContentNode array so
  // every renderer below only ever has to deal with one shape.

  function historyEntryContent(h) {
    if (!h) return [];
    if (Array.isArray(h.content)) return h.content;
    if (h.text) return [{ type: "paragraph", text: h.text }];
    return [];
  }

  // Linearizes a ContentNode array to plain text — used for search
  // indexing, suggestion previews, and as the input to the word-level
  // diff (which only knows how to compare plain strings). Inline
  // {{ref:...}}/{{case:...}} tokens are resolved to their human-readable
  // label rather than left as raw token syntax.
  function flattenContent(nodes) {
    if (!Array.isArray(nodes) || !nodes.length) return "";
    var lines = [];
    function walk(list, depth) {
      (list || []).forEach(function (node) {
        if (!node) return;
        if (node.type === "heading" || node.type === "paragraph") {
          lines.push(flattenInlineToText(node.text || ""));
        } else if (node.type === "list") {
          (node.items || []).forEach(function (item, i) {
            var marker = node.style === "ordered" ? (i + 1) + "." : "\u2022";
            var indent = depth > 0 ? new Array(depth + 1).join("  ") : "";
            lines.push(indent + marker + " " + flattenInlineToText(item.text || ""));
            if (Array.isArray(item.children) && item.children.length) walk(item.children, depth + 1);
          });
        }
      });
    }
    walk(nodes, 0);
    return lines.join("\n");
  }

  function flattenInlineToText(text) {
    return String(text || "")
      .replace(/\{\{ref:([a-z0-9-]+):(\d+)\}\}/g, function (_, slug, num) {
        var found = getArticle(slug, num);
        return found ? (found.act.shortTitle + ", Art. " + num) : ("Art. " + num);
      })
      .replace(/\{\{case:([a-z0-9-]+)\}\}/g, function (_, slug) {
        var c = getCase(slug);
        return c ? c.refNumber : slug;
      });
  }

  function historyEntryFlatText(h) {
    return flattenContent(historyEntryContent(h));
  }

  function actArticleCount(act) {
    var n = 0;
    act.chapters.forEach(function (c) { n += c.articles.length; });
    return n;
  }

  // ---------- typo / word-form tolerance ----------

  // Very small heuristic stemmer — not linguistically rigorous,
  // just enough to match "taxation/taxations", "seize/seized/seizure"-ish forms.
  function stem(word) {
    word = word.toLowerCase();
    var suffixes = ["isations", "izations", "isation", "ization", "ments", "ment", "ions", "ion", "ings", "ing", "edly", "ed", "ies", "ied", "ly", "es", "s"];
    for (var i = 0; i < suffixes.length; i++) {
      var suf = suffixes[i];
      if (word.length > suf.length + 3 && word.slice(-suf.length) === suf) {
        return word.slice(0, -suf.length);
      }
    }
    return word;
  }

  function levenshtein(a, b) {
    a = a.toLowerCase(); b = b.toLowerCase();
    var m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    var prev = new Array(n + 1), cur = new Array(n + 1);
    for (var j = 0; j <= n; j++) prev[j] = j;
    for (var i = 1; i <= m; i++) {
      cur[0] = i;
      for (j = 1; j <= n; j++) {
        var cost = a[i - 1] === b[j - 1] ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      var tmp = prev; prev = cur; cur = tmp;
    }
    return prev[n];
  }

  function tokenize(text) {
    return (text || "").toLowerCase().match(/[a-z0-9]+/g) || [];
  }

  // score one query token against one indexed token: higher is better, 0 = no match
  function tokenScore(qTok, iTok) {
    if (qTok === iTok) return 10;
    if (iTok.indexOf(qTok) === 0) return 7; // prefix match, good for live typing
    if (iTok.indexOf(qTok) !== -1) return 5; // substring
    if (stem(qTok) === stem(iTok)) return 6; // word-form match
    var maxLen = Math.max(qTok.length, iTok.length);
    if (maxLen >= 4) {
      var dist = levenshtein(qTok, iTok);
      var tolerance = maxLen <= 5 ? 1 : 2;
      if (dist <= tolerance) return 4 - dist; // typo tolerance
    }
    return 0;
  }

  // ---------- search index ----------

  var INDEX = null;

  function buildIndex() {
    var entries = [];

    DATA.acts.forEach(function (act) {
      entries.push({
        type: "act", actSlug: act.slug,
        title: act.title, sub: categoryLabel(act.category),
        tokens: tokenize(act.title + " " + act.shortTitle + " " + (act.aliases || []).join(" ") + " " + flattenContent(act.preamble)),
        href: "acts/view.html?act=" + act.slug
      });
      act.chapters.forEach(function (chapter) {
        chapter.articles.forEach(function (article) {
          var text = currentText(article);
          entries.push({
            type: "article", actSlug: act.slug, number: article.number,
            title: "Art. " + article.number + " — " + article.title,
            sub: act.shortTitle,
            preview: text,
            tokens: tokenize(article.title + " " + text),
            href: "acts/view.html?act=" + act.slug + "#" + article.id
          });
        });
      });
    });

    DATA.caseLaw.forEach(function (c) {
      entries.push({
        type: "case", caseSlug: c.slug,
        title: c.title, sub: c.refNumber + " — " + c.subject,
        preview: c.summary,
        tokens: tokenize(c.title + " " + c.subject + " " + c.summary + " " + c.refNumber),
        href: "case-law/view.html?case=" + c.slug
      });
    });

    return entries;
  }

  function getIndex() {
    if (!INDEX) INDEX = buildIndex();
    return INDEX;
  }

  function search(query, limit) {
    limit = limit || 8;
    query = (query || "").trim();
    if (!query) return [];

    var artQuery = resolveArticleQuery(query);
    if (artQuery && artQuery.matches.length) {
      return artQuery.matches.slice(0, limit).map(function (m) {
        return {
          type: "article", title: "Art. " + m.article.number + " — " + m.article.title,
          sub: m.act.shortTitle, preview: currentText(m.article),
          href: "acts/view.html?act=" + m.act.slug + "#" + m.article.id,
          score: 100
        };
      });
    }

    var qTokens = tokenize(query);
    if (!qTokens.length) return [];

    var scored = getIndex().map(function (entry) {
      var total = 0;
      qTokens.forEach(function (qt) {
        var best = 0;
        entry.tokens.forEach(function (it) {
          var s = tokenScore(qt, it);
          if (s > best) best = s;
        });
        total += best;
      });
      if (total > 0 && entry.type === "act") total += 1; // tie-break: the act itself beats articles that merely mention it
      return { entry: entry, score: total };
    }).filter(function (s) { return s.score > 0; });

    scored.sort(function (a, b) { return b.score - a.score; });

    return scored.slice(0, limit).map(function (s) {
      var e = s.entry;
      return { type: e.type, title: e.title, sub: e.sub, preview: e.preview, href: e.href, score: s.score };
    });
  }

  // ---------- "art. 15" / "art. 15 penal code" parsing ----------

  function parseArticleQuery(query) {
    var m = /^art(?:icle|\.)?\s*(\d+)\s*(.*)$/i.exec(query.trim());
    if (!m) return null;
    return { number: parseInt(m[1], 10), actGuess: m[2].trim() };
  }

  function resolveArticleQuery(query) {
    var parsed = parseArticleQuery(query);
    if (!parsed) return null;

    var candidates = [];
    DATA.acts.forEach(function (act) {
      act.chapters.forEach(function (chapter) {
        chapter.articles.forEach(function (article) {
          if (article.number === parsed.number) candidates.push({ act: act, article: article });
        });
      });
    });

    if (parsed.actGuess) {
      var guessTokens = tokenize(parsed.actGuess);
      candidates.forEach(function (c) {
        var nameTokens = tokenize(c.act.title + " " + c.act.shortTitle + " " + (c.act.aliases || []).join(" "));
        var score = 0;
        guessTokens.forEach(function (gt) {
          var best = 0;
          nameTokens.forEach(function (nt) { var s = tokenScore(gt, nt); if (s > best) best = s; });
          score += best;
        });
        c.matchScore = score;
      });
      candidates.sort(function (a, b) { return b.matchScore - a.matchScore; });
      if (candidates.length && candidates[0].matchScore >= 5) {
        return { exact: candidates[0], matches: [candidates[0]] };
      }
    }

    return { exact: candidates.length === 1 ? candidates[0] : null, matches: candidates };
  }

  // ---------- word-level diff ----------

  function diffTokens(text) {
    return (text || "").match(/\s+|[^\s]+/g) || [];
  }

  function diffWords(oldText, newText) {
    var a = diffTokens(oldText), b = diffTokens(newText);
    var n = a.length, m = b.length;
    var lcs = [];
    for (var i = 0; i <= n; i++) lcs.push(new Array(m + 1).fill(0));
    for (i = n - 1; i >= 0; i--) {
      for (var j = m - 1; j >= 0; j--) {
        lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    var ops = [];
    i = 0; j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { ops.push({ type: "equal", text: a[i] }); i++; j++; }
      else if (lcs[i + 1][j] >= lcs[i][j + 1]) { ops.push({ type: "remove", text: a[i] }); i++; }
      else { ops.push({ type: "add", text: b[j] }); j++; }
    }
    while (i < n) { ops.push({ type: "remove", text: a[i] }); i++; }
    while (j < m) { ops.push({ type: "add", text: b[j] }); j++; }
    return ops;
  }

  function renderDiff(oldText, newText) {
    var ops = diffWords(oldText, newText);
    var html = "";
    ops.forEach(function (op) {
      var safe = escapeHtml(op.text);
      if (op.type === "equal") html += safe;
      else if (op.type === "add") html += "<ins>" + safe + "</ins>";
      else html += "<del>" + safe + "</del>";
    });
    return html;
  }

  // ---------- cross-reference rendering ----------

  function renderInlineText(text, fromActSlug) {
    var html = escapeHtml(String(text || ""));
    html = html.replace(/\{\{ref:([a-z0-9-]+):(\d+)\}\}/g, function (_, slug, num) {
      var act = getAct(slug);
      var label = act ? act.shortTitle + ", Art. " + num : "Art. " + num;
      // Resolve the *actual* DOM id of the target article rather than
      // assuming it's always "art-<number>" — that was true for every
      // article in the original seed data, but the Legal admin editor
      // now lets anyone set an article's id to anything. Looking it up
      // via getArticle() keeps the link correct even for custom ids,
      // and degrades to the old assumption only if the target can't be
      // found at all (e.g. a typo'd reference, or the article was since
      // deleted) — in which case the link still goes somewhere sensible
      // rather than silently pointing at nothing.
      var found = getArticle(slug, num);
      var anchorId = found ? found.article.id : ("art-" + num);
      var href = slug === fromActSlug ? ("#" + anchorId) : ("view.html?act=" + slug + "#" + anchorId);
      return '<a class="xref" href="' + href + '">' + escapeHtml(label) + "</a>";
    });
    html = html.replace(/\{\{case:([a-z0-9-]+)\}\}/g, function (_, slug) {
      var c = getCase(slug);
      var label = c ? c.refNumber : slug;
      return '<a class="xref" href="../case-law/view.html?case=' + slug + '">' + escapeHtml(label) + "</a>";
    });
    return html;
  }

  // Renders an array of ContentNodes (paragraph / list / heading) to HTML.
  // Lists recurse into renderContentNodes for any nested `children` so a
  // sub-point list nests structurally (a real <ol>/<ul> inside its parent
  // <li>), not just visually.
  function renderContentNodes(nodes, fromActSlug) {
    if (!Array.isArray(nodes) || !nodes.length) return "";
    function renderList(node) {
      var tag = node.style === "ordered" ? "ol" : "ul";
      var itemsHtml = (node.items || []).map(function (item) {
        var childHtml = Array.isArray(item.children) && item.children.length ? renderContentNodes(item.children, fromActSlug) : "";
        return "<li>" + renderInlineText(item.text || "", fromActSlug) + childHtml + "</li>";
      }).join("");
      return "<" + tag + ' class="article__list">' + itemsHtml + "</" + tag + ">";
    }
    return nodes.map(function (node) {
      if (!node) return "";
      if (node.type === "list") return renderList(node);
      if (node.type === "heading") {
        var lvl = Math.min(4, Math.max(3, node.level || 3));
        return "<h" + lvl + ' class="article__subhead">' + renderInlineText(node.text || "", fromActSlug) + "</h" + lvl + ">";
      }
      var cls = node.numbered ? " article__para--numbered" : "";
      return '<p class="article__para' + cls + '">' + renderInlineText(node.text || "", fromActSlug) + "</p>";
    }).join("");
  }

  // ============================================================
  // PAGE RENDERERS
  // ============================================================

  function initHubSearch(inputId, suggId) {
    var input = document.getElementById(inputId);
    var sugg = document.getElementById(suggId);
    if (!input || !sugg) return;

    function close() { sugg.innerHTML = ""; sugg.classList.remove("is-open"); }

    function renderSuggestions(results) {
      if (!results.length) { close(); return; }
      sugg.innerHTML = results.map(function (r) {
        var typeLabel = r.type === "act" ? "ACT" : r.type === "case" ? "CASE LAW" : "ARTICLE";
        return '<a class="legalsearch__suggestion" href="' + r.href + '">' +
          '<span class="legalsearch__type">' + typeLabel + "</span>" +
          '<span class="legalsearch__suggestion-title">' + escapeHtml(r.title) + "</span>" +
          '<span class="legalsearch__suggestion-sub">' + escapeHtml(r.sub || "") + "</span>" +
        "</a>";
      }).join("");
      sugg.classList.add("is-open");
    }

    var onType = debounce(function () {
      var results = search(input.value, 8);
      renderSuggestions(results);
    }, 120);

    input.addEventListener("input", onType);
    input.addEventListener("focus", function () { if (input.value.trim()) onType(); });
    document.addEventListener("click", function (e) {
      if (e.target !== input && !sugg.contains(e.target)) close();
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        var first = sugg.querySelector(".legalsearch__suggestion");
        if (first) { window.location.href = first.getAttribute("href"); }
      }
    });
  }

  function initActsList() {
    var listEl = document.getElementById("acts-list");
    if (!listEl) return;
    var filterInput = document.getElementById("acts-filter");
    var statEl = document.getElementById("acts-stat-num");

    var acts = DATA.acts.slice().sort(function (a, b) { return b.dateEnacted.localeCompare(a.dateEnacted); });
    if (statEl) statEl.textContent = acts.length;

    function cardHtml(act) {
      var st = statusMeta(act.status);
      return '<a class="legalcard" href="view.html?act=' + act.slug + '">' +
        '<div class="legalcard__top">' +
          '<h3 class="legalcard__title">' + escapeHtml(act.title) + "</h3>" +
          '<span class="tag ' + st.cls + '">' + st.label + "</span>" +
        "</div>" +
        '<p class="legalcard__date">' + formatDate(act.dateInForce) + "</p>" +
        '<div class="legalcard__chips">' +
          '<div class="chip"><span class="chip__label">Articles</span><span class="chip__value">' + actArticleCount(act) + "</span></div>" +
          '<div class="chip"><span class="chip__label">Chapters</span><span class="chip__value">' + act.chapters.length + "</span></div>" +
          '<div class="chip"><span class="chip__label">Category</span><span class="chip__value">' + categoryLabel(act.category) + "</span></div>" +
        "</div>" +
        '<span class="legalcard__open">Open legal act <span class="legalcard__arrow" aria-hidden="true"></span></span>' +
      "</a>";
    }

    function render(filterText) {
      var f = (filterText || "").trim().toLowerCase();
      var filtered = !f ? acts : acts.filter(function (act) {
        return (act.title + " " + act.shortTitle + " " + categoryLabel(act.category)).toLowerCase().indexOf(f) !== -1;
      });
      listEl.innerHTML = filtered.length ? filtered.map(cardHtml).join("") :
        '<p class="legalempty">No acts match that search.</p>';
    }

    render("");
    if (filterInput) filterInput.addEventListener("input", debounce(function () { render(filterInput.value); }, 120));
  }

  function initCaseList() {
    var listEl = document.getElementById("case-list");
    if (!listEl) return;
    var filterInput = document.getElementById("case-filter");
    var statEl = document.getElementById("case-stat-num");

    var cases = DATA.caseLaw.slice().sort(function (a, b) { return b.date.localeCompare(a.date); });
    if (statEl) statEl.textContent = cases.length;

    function cardHtml(c) {
      return '<a class="legalcard" href="view.html?case=' + c.slug + '">' +
        '<div class="legalcard__top">' +
          '<h3 class="legalcard__title">' + escapeHtml(c.title) + "</h3>" +
          '<span class="tag tag--type">' + escapeHtml(c.type) + "</span>" +
        "</div>" +
        '<p class="legalcard__date">' + formatDate(c.date) + "</p>" +
        '<div class="legalcard__chips">' +
          '<div class="chip"><span class="chip__label">Court</span><span class="chip__value">' + escapeHtml(c.court) + "</span></div>" +
          '<div class="chip"><span class="chip__label">Chamber</span><span class="chip__value">' + escapeHtml(c.chamber) + "</span></div>" +
          '<div class="chip"><span class="chip__label">Subject</span><span class="chip__value">' + escapeHtml(c.subject || "—") + "</span></div>" +
          '<div class="chip"><span class="chip__label">Reference</span><span class="chip__value">' + escapeHtml(c.refNumber) + "</span></div>" +
        "</div>" +
        '<span class="legalcard__open">Open document <span class="legalcard__arrow" aria-hidden="true"></span></span>' +
      "</a>";
    }

    function render(filterText) {
      var f = (filterText || "").trim().toLowerCase();
      var filtered = !f ? cases : cases.filter(function (c) {
        return (c.title + " " + c.subject + " " + c.court + " " + c.chamber + " " + c.refNumber).toLowerCase().indexOf(f) !== -1;
      });
      listEl.innerHTML = filtered.length ? filtered.map(cardHtml).join("") :
        '<p class="legalempty">No documents match that search.</p>';
    }

    render("");
    if (filterInput) filterInput.addEventListener("input", debounce(function () { render(filterInput.value); }, 120));
  }

  function buildVersionOptions(history, selectedVersion) {
    return history.map(function (v) {
      var sel = v.version === selectedVersion ? " selected" : "";
      return '<option value="' + v.version + '"' + sel + ">v" + v.version + " — " + formatDate(v.date) + "</option>";
    }).join("");
  }

  function historyPanelHtml(article) {
    if (article.history.length < 2) return "";
    var rows = article.history.slice().reverse().map(function (v, idx) {
      var isCurrent = idx === 0;
      return '<div class="historypanel__version" data-version="' + v.version + '">' +
        '<div class="historypanel__version-head">' +
          '<span class="historypanel__version-num">v' + v.version + (isCurrent ? " — current" : "") + "</span>" +
          '<span class="historypanel__version-date">' + formatDate(v.date) + "</span>" +
        "</div>" +
        '<p class="historypanel__note">' + escapeHtml(v.changeNote) + "</p>" +
      "</div>";
    }).join("");

    // Default comparison is still "previous version -> current version" (the
    // common 2-version case looks identical to the old fixed behaviour), but
    // an article with 3+ revisions can now compare ANY two via the selects
    // below, not just the latest pair. The article's full history travels
    // with the panel as a data attribute so the change handler (wired up
    // after the page is rendered, in initActView) can look it up without
    // needing a separate registry.
    var defaultTo = article.history[article.history.length - 1].version;
    var defaultFrom = article.history[article.history.length - 2].version;
    var historyJson = escapeHtml(JSON.stringify(article.history));

    return '<div class="historypanel" id="history-' + article.id + '" data-history="' + historyJson + '">' +
        '<div class="historypanel__versions">' + rows + "</div>" +
        '<div class="historypanel__comparebar">' +
          '<span class="historypanel__comparelabel">Compare</span>' +
          '<select class="historypanel__select" data-role="from">' + buildVersionOptions(article.history, defaultFrom) + "</select>" +
          '<span class="historypanel__comparearrow" aria-hidden="true">\u2192</span>' +
          '<select class="historypanel__select" data-role="to">' + buildVersionOptions(article.history, defaultTo) + "</select>" +
        "</div>" +
        '<div class="historypanel__diffhead" data-role="diffhead"></div>' +
        '<div class="diffview" data-role="diffview"></div>' +
      "</div>";
  }

  function refreshHistoryCompare(panel) {
    var history;
    try { history = JSON.parse(panel.getAttribute("data-history") || "[]"); } catch (e) { return; }
    var fromSel = panel.querySelector('[data-role="from"]');
    var toSel = panel.querySelector('[data-role="to"]');
    var diffHeadEl = panel.querySelector('[data-role="diffhead"]');
    var diffViewEl = panel.querySelector('[data-role="diffview"]');
    if (!fromSel || !toSel || !diffHeadEl || !diffViewEl) return;

    var fromV = parseInt(fromSel.value, 10);
    var toV = parseInt(toSel.value, 10);
    var fromEntry = null, toEntry = null;
    history.forEach(function (h) {
      if (h.version === fromV) fromEntry = h;
      if (h.version === toV) toEntry = h;
    });
    if (!fromEntry || !toEntry) return;

    diffHeadEl.textContent = "Comparing v" + fromV + " (" + formatDate(fromEntry.date) + ") \u2192 v" + toV + " (" + formatDate(toEntry.date) + ")";
    diffViewEl.innerHTML = renderDiff(historyEntryFlatText(fromEntry), historyEntryFlatText(toEntry));
  }

  function articleHtml(act, article) {
    var hasHistory = article.history.length > 1;
    var current = article.history[article.history.length - 1];
    var caseChips = (article.caseLawIds || []).map(function (slug) {
      var c = getCase(slug);
      if (!c) return "";
      return '<a class="article__case" href="../case-law/view.html?case=' + c.slug + '">' +
        escapeHtml(c.refNumber) + " — " + escapeHtml(c.title) + "</a>";
    }).join("");

    return '<article class="actview__article" id="' + article.id + '">' +
      '<div class="article__head">' +
        '<h3 class="article__title">Art. ' + article.number + ". " + escapeHtml(article.title) + "</h3>" +
        (hasHistory ? '<button class="article__history-toggle" data-target="history-' + article.id + '">History</button>' : "") +
      "</div>" +
      '<div class="article__body">' + renderContentNodes(historyEntryContent(current), act.slug) + "</div>" +
      (caseChips ? '<div class="article__cases"><span class="article__cases-label">Related case law</span>' + caseChips + "</div>" : "") +
      (hasHistory ? historyPanelHtml(article) : "") +
    "</article>";
  }

  function initActView() {
    var root = document.getElementById("actview-root");
    if (!root) return;
    var slug = getQueryParam("act");
    var act = getAct(slug);

    if (!act) {
      root.innerHTML = '<p class="legalempty">That legal act could not be found. ' +
        '<a href="../acts/">Return to the Legal Acts Database.</a></p>';
      return;
    }

    var st = statusMeta(act.status);
    document.title = act.shortTitle + " — Regnum Aeternum";

    var navHtml = act.chapters.map(function (chapter) {
      var links = chapter.articles.map(function (a) {
        return '<a class="actview__nav-link" href="#' + a.id + '">Art. ' + a.number + "</a>";
      }).join("");
      return '<div class="actview__nav-chapter"><span class="actview__nav-chapter-title">' +
        escapeHtml(chapter.title) + "</span>" + links + "</div>";
    }).join("");

    var articlesHtml = act.chapters.map(function (chapter) {
      return '<div class="actview__chapter">' +
        '<h2 class="actview__chapter-title">' + escapeHtml(chapter.title) + "</h2>" +
        chapter.articles.map(function (a) { return articleHtml(act, a); }).join("") +
      "</div>";
    }).join("");

    var preambleHtml = (act.preamble && act.preamble.length)
      ? '<div class="actview__preamble">' +
          '<p class="actview__preamble-label">Preamble</p>' +
          renderContentNodes(act.preamble, act.slug) +
        "</div>"
      : "";

    root.innerHTML =
      '<aside class="actview__sidebar"><nav class="actview__nav">' + navHtml + "</nav></aside>" +
      '<div class="actview__content">' +
        '<div class="actview__header">' +
          '<p class="actview__eyebrow">' + categoryLabel(act.category) + "</p>" +
          '<h1 class="actview__title">' + escapeHtml(act.title) + "</h1>" +
          '<div class="actview__meta">' +
            '<span class="tag ' + st.cls + '">' + st.label + "</span>" +
            '<span class="actview__meta-date">In force since ' + formatDate(act.dateInForce) + "</span>" +
          "</div>" +
        "</div>" +
        preambleHtml +
        articlesHtml +
      "</div>";

    // history toggle + active-link highlighting
    qsa(".article__history-toggle", root).forEach(function (btn) {
      btn.addEventListener("click", function () {
        var panel = document.getElementById(btn.getAttribute("data-target"));
        if (panel) panel.classList.toggle("is-open");
      });
    });

    // version-compare selects: render the default pair immediately, and
    // recompute whenever either dropdown changes.
    qsa(".historypanel", root).forEach(function (panel) {
      refreshHistoryCompare(panel);
      qsa('[data-role="from"], [data-role="to"]', panel).forEach(function (sel) {
        sel.addEventListener("change", function () { refreshHistoryCompare(panel); });
      });
    });

    var navLinks = qsa(".actview__nav-link", root);
    function setActive() {
      var hash = window.location.hash.replace("#", "");
      navLinks.forEach(function (l) {
        l.classList.toggle("is-active", l.getAttribute("href") === "#" + hash);
      });
    }

    // Centers the target in view (the topbar is sticky and would otherwise
    // cover it if the browser's native anchor-jump were left to run alone)
    // and gives it a brief highlight so it's unambiguous where you landed —
    // used for every hash navigation: initial page load with a hash already
    // in the URL (arriving from a cross-act reference), AND same-page clicks
    // on the sidebar nav or in-text cross-references within this act.
    function scrollToHash(hash) {
      if (!hash) return;
      var target;
      try { target = document.querySelector(hash); } catch (e) { return; }
      if (!target) return;
      var prefersReduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      target.scrollIntoView({ block: "center", behavior: prefersReduced ? "auto" : "smooth" });
      target.classList.add("is-target-flash");
      setTimeout(function () { target.classList.remove("is-target-flash"); }, 1600);
    }

    window.addEventListener("hashchange", function () {
      setActive();
      scrollToHash(window.location.hash);
    });
    setActive();

    if (window.location.hash) {
      setTimeout(function () { scrollToHash(window.location.hash); }, 30);
    }
  }

  function initCaseView() {
    var root = document.getElementById("caseview-root");
    if (!root) return;
    var slug = getQueryParam("case");
    var c = getCase(slug);

    if (!c) {
      root.innerHTML = '<p class="legalempty">That decision could not be found. ' +
        '<a href="../case-law/">Return to the Case Law Database.</a></p>';
      return;
    }

    document.title = c.refNumber + " — Regnum Aeternum";

    var related = (c.relatedArticles || []).map(function (r) {
      var found = getArticle(r.actSlug, r.number);
      if (!found) return "";
      return '<a class="article__case" href="../acts/view.html?act=' + r.actSlug + "#" + found.article.id + '">' +
        escapeHtml(found.act.shortTitle) + ", Art. " + r.number + " — " + escapeHtml(found.article.title) + "</a>";
    }).join("");

    root.innerHTML =
      '<div class="caseview__header">' +
        '<p class="caseview__eyebrow">' + escapeHtml(c.court) + "</p>" +
        '<h1 class="caseview__title">' + escapeHtml(c.title) + "</h1>" +
        '<div class="caseview__chips">' +
          '<span class="tag tag--type">' + escapeHtml(c.type) + "</span>" +
          '<div class="chip"><span class="chip__label">Chamber</span><span class="chip__value">' + escapeHtml(c.chamber) + "</span></div>" +
          '<div class="chip"><span class="chip__label">Reference</span><span class="chip__value">' + escapeHtml(c.refNumber) + "</span></div>" +
          '<div class="chip"><span class="chip__label">Date</span><span class="chip__value">' + formatDate(c.date) + "</span></div>" +
        "</div>" +
      "</div>" +
      '<p class="caseview__body">' + escapeHtml(c.fullText) + "</p>" +
      (related ? '<div class="caseview__related"><h2>Related Articles</h2>' + related + "</div>" : "");
  }

  function initHub() {
    var latestEl = document.getElementById("latest-acts-list");
    var dbEl = document.getElementById("legal-db-list");
    var countEl = document.getElementById("caselaw-count");

    if (latestEl) {
      var byDate = DATA.acts.slice().sort(function (a, b) { return b.dateInForce.localeCompare(a.dateInForce); }).slice(0, 5);
      latestEl.innerHTML = byDate.map(function (act) {
        return '<a class="legalpanel__item" href="acts/view.html?act=' + act.slug + '">' +
          '<span class="legalpanel__item-title">' + escapeHtml(act.title) + "</span>" +
          '<span class="legalpanel__item-meta">' + act.dateInForce + "</span>" +
        "</a>";
      }).join("");
    }

    if (dbEl) {
      var catRank = { constitution: 0, code: 1, act: 2, regulation: 3 };
      var all = DATA.acts.slice().sort(function (a, b) {
        var ra = catRank[a.category] != null ? catRank[a.category] : 9;
        var rb = catRank[b.category] != null ? catRank[b.category] : 9;
        if (ra !== rb) return ra - rb;
        return a.title.localeCompare(b.title);
      }).slice(0, 5);
      dbEl.innerHTML = all.map(function (act) {
        return '<a class="legalpanel__item" href="acts/view.html?act=' + act.slug + '">' +
          '<span class="legalpanel__item-title">' + escapeHtml(act.title) + "</span>" +
          '<span class="legalpanel__item-meta">' + categoryLabel(act.category) + "</span>" +
        "</a>";
      }).join("");
    }

    if (countEl) countEl.textContent = DATA.caseLaw.length;
  }

  function initAll() {
    initHubSearch("hub-search-input", "hub-search-suggestions");
    initHub();
    initActsList();
    initCaseList();
    initActView();
    initCaseView();
  }

  return {
    search: search, parseArticleQuery: parseArticleQuery, resolveArticleQuery: resolveArticleQuery,
    diffWords: diffWords, formatDate: formatDate, getAct: getAct, getArticle: getArticle, getCase: getCase,
    init: function () { return loadData().then(initAll); }
  };
})();

document.addEventListener("DOMContentLoaded", LegalApp.init);
