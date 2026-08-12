/* ============================================================
   REGNUM AETERNUM — Admin: Newspaper Editor
   Drag-to-resize section-based vintage newspaper layout editor.
   ============================================================ */
(function () {
  'use strict';

  var state = null;       // { id, slug, title, status, layout: { masthead, sections, pageWidth, pageHeight } }
  var selectedId = null;
  var dragInfo = null;
  var $canvas = null;
  var $sidebar = null;
  var $zoomLabel = null;
  var zoomLevel = 1.0;    // 0.25 .. 2.0

  var TYPE_LABELS = { banner:'Banner', heading:'Heading', text:'Text', image:'Image', quote:'Quote' };

  function $(sel) { return document.querySelector(sel); }
  function $$(sel, root) { return Array.from((root||document).querySelectorAll(sel)); }

  function escapeHtml(s) { return String(s==null?'':s).replace(/[&<>\"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c];}); }

  function getDefaultLayout(title) {
    return {
      pageWidth: 800, pageHeight: 1100,
      masthead: { title: title||'THE SOCIETY', volume:'VOL. 1, NO. 1', date: new Date().toISOString().split('T')[0].replace(/-/g,' ').toUpperCase(), website:'REGNUM-AETERNUM.COM' },
      sections: [
        { id:'s1', type:'banner', text:'BREAKING NEWS', x:10, y:120, w:780, h:36, z:10 },
        { id:'s2', type:'heading', text:'Headline Goes Here', x:10, y:170, w:380, h:50, z:20 },
        { id:'s3', type:'text', text:'Body text goes here. Select this section and edit the content in the panel on the right.', x:10, y:230, w:380, h:280, z:30 },
        { id:'s4', type:'image', src:'', x:410, y:170, w:380, h:220, z:40 },
        { id:'s5', type:'text', text:'Second column text. Drag sections to reposition them, or use the corner handles to resize.', x:410, y:410, w:380, h:200, z:50 },
        { id:'s6', type:'quote', text:'\"A great quote appears here.\"', x:10, y:530, w:380, h:60, z:60 },
      ]
    };
  }

  function nextId() {
    var max = 0;
    state.layout.sections.forEach(function(s){ var n=parseInt(s.id.replace('s',''),10); if(n>max) max=n; });
    return 's'+(max+1);
  }

  // ---------- Rendering ----------

  function applyZoom() {
    if (!$canvas || !$zoomLabel) return;
    // Size the wrapper so the scroll container knows the real visual size.
    var wrap = document.getElementById('np-canvas-zoom-wrap');
    if (wrap && state && state.layout) {
      wrap.style.width  = (state.layout.pageWidth  * zoomLevel) + 'px';
      wrap.style.height = (state.layout.pageHeight * zoomLevel) + 'px';
    }
    $canvas.style.transform = 'scale(' + zoomLevel + ')';
    $zoomLabel.textContent = Math.round(zoomLevel * 100) + '%';
  }

  function setZoom(newZoom) {
    zoomLevel = Math.max(0.25, Math.min(2.0, newZoom));
    zoomLevel = Math.round(zoomLevel * 100) / 100; // snap to 2 decimals
    applyZoom();
  }

  function fitZoom() {
    if (!state || !$canvas) return;
    var scroll = $canvas.closest('.np-canvas-scroll');
    if (!scroll) return;
    // Available space (with 40px padding on each side)
    var availW = scroll.clientWidth  - 80;
    var availH = scroll.clientHeight - 80;
    if (availW <= 0 || availH <= 0) return;
    var scaleW = availW / state.layout.pageWidth;
    var scaleH = availH / state.layout.pageHeight;
    var fit = Math.min(scaleW, scaleH);
    setZoom(Math.min(fit, 1.0)); // never exceed 100%
  }

  function renderCanvas() {
    if (!$canvas || !state) return;
    var L = state.layout;
    $canvas.style.width = L.pageWidth + 'px';
    $canvas.style.height = L.pageHeight + 'px';
    $canvas.innerHTML = '';

    // Re-apply zoom after clearing innerHTML
    applyZoom();

    // Masthead
    var mh = L.masthead;
    var mhEl = document.createElement('div');
    mhEl.className = 'np-masthead';
    mhEl.style.cssText = 'top:'+(mh.y||8)+'px;width:'+((mh.w||L.pageWidth-20))+'px;';
    mhEl.innerHTML =
      '<div class="np-masthead__title">'+escapeHtml(mh.title)+'</div>'+
      '<div class="np-masthead__rules"></div><div class="np-masthead__rules"></div>'+
      '<div class="np-masthead__row"><span>'+escapeHtml(mh.volume)+'</span><span>'+escapeHtml(mh.website)+'</span><span>'+escapeHtml(mh.date)+'</span></div>';
    $canvas.appendChild(mhEl);

    // Sections sorted by z-index
    var sorted = L.sections.slice().sort(function(a,b){ return a.z - b.z; });
    sorted.forEach(function(s) { $canvas.appendChild(renderSection(s)); });

    updateLayersList();
  }

  function renderSection(s) {
    var el = document.createElement('div');
    el.className = 'np-section np-section--' + s.type;
    if (s.id === selectedId) el.classList.add('np-section--selected');
    el.setAttribute('data-sid', s.id);
    el.style.cssText = 'left:'+s.x+'px;top:'+s.y+'px;width:'+s.w+'px;height:'+s.h+'px;z-index:'+s.z+';';

    if (s.type === 'banner') {
      el.innerHTML = '<span class="np-banner-text">'+escapeHtml(s.text||'BREAKING NEWS')+'</span>';
    } else if (s.type === 'heading') {
      el.innerHTML = '<textarea class="np-heading-text" data-prop="text">'+escapeHtml(s.text||'')+'</textarea>';
    } else if (s.type === 'quote') {
      el.innerHTML = '<textarea class="np-quote-text" data-prop="text">'+escapeHtml(s.text||'')+'</textarea>';
    } else if (s.type === 'text') {
      el.innerHTML = '<textarea class="np-text-area" data-prop="text">'+escapeHtml(s.text||'')+'</textarea>';
    } else if (s.type === 'image') {
      if (s.src) {
        el.innerHTML = '<img src="'+s.src+'" alt="" />';
      } else {
        el.innerHTML = '<span class="np-image-placeholder">Click to upload image</span>';
      }
    }

    // Resize handles
    ['n','s','e','w','nw','ne','sw','se'].forEach(function(dir){
      var h = document.createElement('div');
      h.className = 'np-handle np-handle--'+dir;
      h.setAttribute('data-handle', dir);
      el.appendChild(h);
    });

    // Click to select
    el.addEventListener('mousedown', function(e) {
      if (e.target.hasAttribute('data-handle')) return; // handle does its own thing
      selectSection(s.id);
    });

    return el;
  }

  function selectSection(id) {
    selectedId = id;
    // Update canvas selection styling
    $$('.np-section', $canvas).forEach(function(el){
      el.classList.toggle('np-section--selected', el.getAttribute('data-sid') === id);
    });
    updateLayersList();
    updatePropsPanel();
  }

  function updateLayersList() {
    var list = $('.np-layers-list');
    if (!list || !state) return;
    var sorted = state.layout.sections.slice().sort(function(a,b){ return b.z - a.z; });
    list.innerHTML = sorted.map(function(s){
      var cls = 'np-layer-item' + (s.id===selectedId ? ' np-layer-item--selected' : '');
      return '<div class="'+cls+'" data-sid="'+s.id+'">'+
        '<span class="np-layer-item__type">'+TYPE_LABELS[s.type]+'</span>'+
        '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">'+escapeHtml((s.text||s.type).slice(0,24))+'</span>'+
        '<span class="np-layer-item__btns">'+
          '<button class="np-layer-item__btn" data-action="layer-up" data-sid="'+s.id+'" title="Bring forward">▲</button>'+
          '<button class="np-layer-item__btn" data-action="layer-down" data-sid="'+s.id+'" title="Send backward">▼</button>'+
          '<button class="np-layer-item__btn" data-action="delete-section" data-sid="'+s.id+'" title="Delete" style="color:#e3a3a3;">✕</button>'+
        '</span></div>';
    }).join('');

    list.querySelectorAll('.np-layer-item').forEach(function(item){
      item.addEventListener('click', function(e){
        if (e.target.closest('[data-action]')) return;
        selectSection(item.dataset.sid);
      });
    });
  }

  function updatePropsPanel() {
    var panel = $('.np-props');
    if (!panel || !state) return;
    var s = state.layout.sections.filter(function(x){return x.id===selectedId;})[0];
    if (!s) { panel.innerHTML = '<p style="color:var(--slate-soft);font-size:12px;">Select a section to edit.</p>'; return; }

    var typeSelect = '<select data-prop="type">'+
      Object.keys(TYPE_LABELS).map(function(t){return '<option value="'+t+'"'+(s.type===t?' selected':'')+'>'+TYPE_LABELS[t]+'</option>';}).join('')+
      '</select>';

    var contentField = '';
    if (s.type === 'image') {
      contentField =
        '<label>Image</label>'+
        '<input type="file" accept="image/*" data-action="upload-image" data-sid="'+s.id+'" style="font-size:10px;"/>'+
        (s.src ? '<img src="'+s.src+'" style="width:100%;max-height:80px;object-fit:cover;margin-top:4px;border-radius:4px;" />' : '');
    } else {
      contentField = '<label>Content</label><textarea data-prop="text" rows="4">'+escapeHtml(s.text||'')+'</textarea>';
    }

    // Check if there are merge candidates
    var candidates = findMergeCandidates(s);
    var mergeBtn = candidates.length
      ? '<button class="a-btn primary" data-action="merge-section" data-sid="'+s.id+'" style="width:100%;margin-top:4px;">Merge with Adjacent ('+candidates.length+' found)</button>'
      : '<button class="a-btn" disabled style="width:100%;margin-top:4px;opacity:0.4;">No Adjacent to Merge</button>';

    panel.innerHTML =
      '<label>Type</label>'+typeSelect+
      contentField+
      '<div style="display:flex;gap:6px;">'+
        '<div style="flex:1;"><label>X</label><input type="number" data-prop="x" value="'+s.x+'" style="width:100%;"/></div>'+
        '<div style="flex:1;"><label>Y</label><input type="number" data-prop="y" value="'+s.y+'" style="width:100%;"/></div>'+
      '</div>'+
      '<div style="display:flex;gap:6px;">'+
        '<div style="flex:1;"><label>W</label><input type="number" data-prop="w" value="'+s.w+'" style="width:100%;"/></div>'+
        '<div style="flex:1;"><label>H</label><input type="number" data-prop="h" value="'+s.h+'" style="width:100%;"/></div>'+
      '</div>'+
      '<label>Z-Index</label><input type="number" data-prop="z" value="'+s.z+'" style="width:100%;"/>'+
      mergeBtn;
  }

  // ---------- Mutations ----------

  function updateSection(id, changes) {
    var s = state.layout.sections.filter(function(x){return x.id===id;})[0];
    if (!s) return;
    Object.keys(changes).forEach(function(k){ s[k] = changes[k]; });
    renderCanvas();
  }

  function deleteSection(id) {
    state.layout.sections = state.layout.sections.filter(function(x){return x.id!==id;});
    if (selectedId === id) selectedId = null;
    renderCanvas();
  }

  function addSection(type) {
    var s = { id: nextId(), type: type, text: '', src: '', x: 50, y: 50+state.layout.sections.length*10, w: 300, h: type==='banner'?36:type==='heading'?50:type==='quote'?60:150, z: (state.layout.sections.reduce(function(m,x){return Math.max(m,x.z);},0)+10) };
    state.layout.sections.push(s);
    selectSection(s.id);
    renderCanvas();
  }

  function moveLayer(id, delta) {
    var s = state.layout.sections.filter(function(x){return x.id===id;})[0];
    if (!s) return;
    var maxZ = state.layout.sections.reduce(function(m,x){return Math.max(m,x.z);},0);
    var minZ = state.layout.sections.reduce(function(m,x){return Math.min(m,x.z);},0);
    var newZ = s.z + delta;
    if (newZ < minZ || newZ > maxZ + 1) return;
    s.z = newZ;
    renderCanvas();
  }

  // ---------- Merge sections ----------

  // Returns true if two rectangles are adjacent (within threshold px or overlapping).
  function rectsAdjacent(a, b, threshold) {
    threshold = threshold || 10;
    // Horizontal/vertical gap — negative values mean overlap.
    var hGap = Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w);
    var vGap = Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h);
    // Adjacent if both gaps are within threshold (covers overlap, touching, and near-miss).
    return hGap <= threshold && vGap <= threshold;
  }

  function findMergeCandidates(section) {
    return state.layout.sections.filter(function(other) {
      if (other.id === section.id) return false;
      if (other.type !== section.type) return false;
      return rectsAdjacent(section, other, 15);
    }).sort(function(a, b) {
      // Sort by closest center distance
      var cx = section.x + section.w/2, cy = section.y + section.h/2;
      var da = Math.abs((a.x + a.w/2) - cx) + Math.abs((a.y + a.h/2) - cy);
      var db = Math.abs((b.x + b.w/2) - cx) + Math.abs((b.y + b.h/2) - cy);
      return da - db;
    });
  }

  function mergeSection(id) {
    var s = state.layout.sections.filter(function(x){return x.id===id;})[0];
    if (!s) return;

    var candidates = findMergeCandidates(s);
    if (!candidates.length) {
      alert('No adjacent section of the same type found. Sections must be close to each other (within ~15px) and of the same type to merge.');
      return;
    }

    // If only one candidate, merge immediately. Otherwise, let the user pick.
    var other;
    if (candidates.length === 1) {
      other = candidates[0];
    } else {
      var labels = candidates.map(function(c, i) {
        return (i+1) + '. ' + TYPE_LABELS[c.type] + ' at (' + c.x + ', ' + c.y + ') [' + (c.text||'').slice(0,30) + ']';
      }).join('\n');
      var choice = parseInt(prompt('Multiple adjacent sections found. Pick one:\n' + labels, '1'), 10);
      if (isNaN(choice) || choice < 1 || choice > candidates.length) return;
      other = candidates[choice - 1];
    }

    // Compute the union bounding box
    var nx = Math.min(s.x, other.x);
    var ny = Math.min(s.y, other.y);
    var nw = Math.max(s.x + s.w, other.x + other.w) - nx;
    var nh = Math.max(s.y + s.h, other.y + other.h) - ny;

    // Combine content: for text-based types, append the other's text
    var txt = s.text || '';
    var otxt = other.text || '';
    if (otxt) {
      txt = txt ? (txt + '\n\n' + otxt) : otxt;
    }

    // Combine image src: keep the survivor's image if it has one
    var src = s.src || other.src || '';

    // Update the survivor, remove the other
    s.x = nx; s.y = ny; s.w = nw; s.h = nh;
    s.text = txt;
    s.src = src;

    state.layout.sections = state.layout.sections.filter(function(x){return x.id !== other.id;});
    selectSection(s.id);
    renderCanvas();
  }

  // ---------- Drag & Resize ----------

  function startDrag(e, sid, mode) {
    e.preventDefault();
    var s = state.layout.sections.filter(function(x){return x.id===sid;})[0];
    if (!s) return;
    dragInfo = { sid: sid, mode: mode, startX: e.clientX, startY: e.clientY, origX: s.x, origY: s.y, origW: s.w, origH: s.h, zoom: zoomLevel };
    selectSection(sid);
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd);
  }

  function onDragMove(e) {
    if (!dragInfo) return;
    var z = dragInfo.zoom || 1;
    var dx = (e.clientX - dragInfo.startX) / z;
    var dy = (e.clientY - dragInfo.startY) / z;
    var s = state.layout.sections.filter(function(x){return x.id===dragInfo.sid;})[0];
    if (!s) return;

    var m = dragInfo.mode;
    if (m === 'move') {
      s.x = Math.max(0, dragInfo.origX + dx);
      s.y = Math.max(0, dragInfo.origY + dy);
    } else {
      if (m.indexOf('e')!==-1) s.w = Math.max(40, dragInfo.origW + dx);
      if (m.indexOf('w')!==-1) { s.x = Math.max(0, dragInfo.origX + dx); s.w = Math.max(40, dragInfo.origW - dx); }
      if (m.indexOf('s')!==-1) s.h = Math.max(20, dragInfo.origH + dy);
      if (m.indexOf('n')!==-1) { s.y = Math.max(0, dragInfo.origY + dy); s.h = Math.max(20, dragInfo.origH - dy); }
    }
    renderCanvas();
  }

  function onDragEnd() {
    dragInfo = null;
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragEnd);
  }

  // ---------- Image upload ----------

  function handleImageUpload(file, sid) {
    if (!file || !file.type.startsWith('image/')) return;
    var reader = new FileReader();
    reader.onload = function() {
      updateSection(sid, { src: reader.result });
    };
    reader.readAsDataURL(file);
  }

  // ---------- Masthead editing ----------

  function updateMasthead(changes) {
    if (!state || !state.layout.masthead) return;
    Object.keys(changes).forEach(function(k){ state.layout.masthead[k] = changes[k]; });
    renderCanvas();
  }

  // ---------- Save / Load ----------

  function collectData() {
    if (!state) return null;
    var L = state.layout;
    // Collect text from live textareas back into section objects
    L.sections.forEach(function(s){
      if (s.type !== 'image' && s.type !== 'banner') {
        var el = $canvas.querySelector('[data-sid="'+s.id+'"] [data-prop="text"]');
        if (el) s.text = el.value;
      }
      if (s.type === 'banner') {
        var bel = $canvas.querySelector('[data-sid="'+s.id+'"] .np-banner-text');
        if (bel) s.text = bel.textContent;
      }
    });
    return { title: $('#np-title').value, layout: L };
  }

  function loadNewspaper(data) {
    state = data;
    $('#np-title').value = data.title || '';
    $('#np-slug').value = data.slug || '';
    selectedId = null;
    renderCanvas();
  }

  function newNewspaper() {
    state = { id: null, slug: '', title: 'New Newspaper', status: 'draft', layout: getDefaultLayout('THE SOCIETY') };
    $('#np-title').value = 'THE SOCIETY';
    $('#np-slug').value = '';
    selectedId = null;
    renderCanvas();
  }

  // ---------- Init ----------

  function init(container, user) {
    $canvas = container.querySelector('#np-canvas');
    $sidebar = container.querySelector('#np-sidebar');
    $zoomLabel = container.querySelector('#np-zoom-label');
    if (!$canvas || !$sidebar) return;

    // Zoom controls
    var zoomOutBtn = container.querySelector('[data-action="zoom-out"]');
    var zoomInBtn  = container.querySelector('[data-action="zoom-in"]');
    var zoomResetBtn = container.querySelector('[data-action="zoom-reset"]');
    var zoomFitBtn   = container.querySelector('[data-action="zoom-fit"]');
    if (zoomOutBtn) zoomOutBtn.addEventListener('click', function(){ setZoom(zoomLevel - 0.25); });
    if (zoomInBtn)  zoomInBtn.addEventListener('click',  function(){ setZoom(zoomLevel + 0.25); });
    if (zoomResetBtn) zoomResetBtn.addEventListener('click', function(){ setZoom(1.0); });
    if (zoomFitBtn)   zoomFitBtn.addEventListener('click', fitZoom);
    // Mouse wheel zoom (Ctrl+Scroll)
    container.addEventListener('wheel', function(e) {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        setZoom(zoomLevel + (e.deltaY < 0 ? 0.1 : -0.1));
      }
    }, { passive: false });
    applyZoom();

    // Delegate: canvas click for section select
    $canvas.addEventListener('mousedown', function(e) {
      var sectionEl = e.target.closest('.np-section');
      var handleEl = e.target.closest('[data-handle]');

      if (handleEl && sectionEl) {
        var sid = sectionEl.getAttribute('data-sid');
        var dir = handleEl.getAttribute('data-handle');
        startDrag(e, sid, dir);
        return;
      }

      if (sectionEl && !handleEl) {
        var sid2 = sectionEl.getAttribute('data-sid');
        startDrag(e, sid2, 'move');
        return;
      }
    });

    // Delegate: sidebar actions
    $sidebar.addEventListener('click', function(e) {
      var btn = e.target.closest('[data-action]');
      if (!btn) return;
      var action = btn.getAttribute('data-action');
      var sid = btn.getAttribute('data-sid');
      if (action === 'layer-up') moveLayer(sid, 1);
      if (action === 'layer-down') moveLayer(sid, -1);
      if (action === 'delete-section') { if(confirm('Delete this section?')) deleteSection(sid); }
      if (action === 'merge-section') mergeSection(sid);
    });

    // Delegate: props changes
    $sidebar.addEventListener('input', function(e) {
      var fld = e.target.closest('[data-prop]');
      if (!fld || !selectedId) return;
      var prop = fld.getAttribute('data-prop');
      var val = prop === 'x'||prop==='y'||prop==='w'||prop==='h'||prop==='z' ? parseInt(fld.value,10)||0 : fld.value;
      updateSection(selectedId, { [prop]: val });
    });

    // Delegate: image upload
    $sidebar.addEventListener('change', function(e) {
      if (e.target.getAttribute('data-action') === 'upload-image') {
        var sid2 = e.target.getAttribute('data-sid');
        if (e.target.files && e.target.files[0]) handleImageUpload(e.target.files[0], sid2);
      }
    });

    // Add section buttons
    $$('[data-action="add-section"]', $sidebar).forEach(function(btn){
      btn.addEventListener('click', function(){ addSection(btn.dataset.type); });
    });

    // Masthead inputs
    $$('[data-masthead-prop]', $sidebar).forEach(function(inp){
      inp.addEventListener('input', function(){
        var p = inp.getAttribute('data-masthead-prop');
        updateMasthead({ [p]: inp.value });
      });
    });
  }

  // ---------- Public API ----------

  function getData() { return collectData(); }
  function setData(data) { loadNewspaper(data); }
  function resetNew() { newNewspaper(); }

  window.NewspaperEditor = { init: init, getData: getData, setData: setData, resetNew: resetNew };
})();
