/**
 * The script injected into every panel iframe before the panel's own code.
 * It is plain ES2019 so it runs as an inline classic script, and it exposes
 * `window.dsh` — the panel's only way to the outside (see host/guide.ts).
 *
 * Initial data, histories, saved state and theme mode are embedded in the
 * document as JSON, so the panel renders on first paint; later updates come
 * from the parent as `postMessage` frames carrying the per-frame token.
 */
export const FRAME_RUNTIME = String.raw`
(function () {
  'use strict';
  var root = document.documentElement;
  var token = root.getAttribute('data-token');
  var parentWin = window.parent;
  var init = JSON.parse(document.getElementById('pad-init').textContent || '{}');
  var current = init.data || null;
  var histories = init.histories || {};
  var stateStore = init.state || {};
  var lang = init.lang || 'zh';
  var listeners = [];
  var pendingRuns = {};
  var runSeq = 0;

  function post(msg) { msg.token = token; parentWin.postMessage(msg, '*'); }
  function report(err) {
    var text = err && err.stack ? String(err.stack) : String(err && err.message || err);
    post({ kind: 'error', message: text.slice(0, 2000) });
  }
  function emit() {
    var list = listeners.slice();
    // With no listener there is nothing to render: stay quiet rather than
    // reporting success for a script that never got as far as subscribing.
    if (list.length === 0) return;
    var failed = null;
    list.forEach(function (fn) {
      try { fn(current); } catch (e) { if (failed === null) failed = e; }
    });
    // Report the outcome of this render, not just failures: an error raised for
    // an earlier data set must not outlive the render that replaced it.
    if (failed === null) post({ kind: 'ok' });
    else report(failed);
  }

  window.addEventListener('error', function (e) { report(e.error || e.message); });
  window.addEventListener('unhandledrejection', function (e) { report(e.reason); });
  window.addEventListener('message', function (e) {
    if (e.source !== parentWin) return;
    var m = e.data || {};
    if (m.token !== token) return;
    if (m.kind === 'data') {
      current = m.data;
      if (m.histories) histories = m.histories;
      if (m.historyDelta) Object.keys(m.historyDelta).forEach(function (id) {
        var points = Array.isArray(histories[id]) ? histories[id] : [];
        m.historyDelta[id].forEach(function (point) {
          var index = points.findIndex(function (old) { return old.at === point.at; });
          if (index >= 0) points[index] = point;
          else points.push(point);
        });
        points.sort(function (a, b) { return a.at < b.at ? -1 : a.at > b.at ? 1 : 0; });
        if (points.length > 120) points.splice(0, points.length - 120);
        histories[id] = points;
      });
      emit();
    }
    else if (m.kind === 'theme') {
      document.getElementById('pad-theme').textContent = m.css;
      root.setAttribute('data-mode', m.mode);
    }
    else if (m.kind === 'height') {
      // A panel the user sized must scroll its own overflow; auto panels fit it.
      root.setAttribute('data-height', m.auto ? 'auto' : 'fixed');
      watchSize();
    }
    else if (m.kind === 'run-result') {
      var runCb = pendingRuns[m.id];
      if (runCb) runCb({ ok: m.ok === true, text: m.text, error: m.error });
    }
  });

  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    e.preventDefault();
    post({ kind: 'open', url: a.href });
  });

  var lastHeight = -1;
  var ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
  var watchingSize = false;
  function measure() {
    if (root.getAttribute('data-height') !== 'auto') return;
    // Measure the content, not the viewport: this frame's own height is set by
    // the parent, and root.scrollHeight can never shrink below it again.
    var body = document.body;
    var h = Math.ceil(body ? body.scrollHeight : root.scrollHeight);
    if (h !== lastHeight) { lastHeight = h; post({ kind: 'resize', height: h }); }
  }
  function watchSize() {
    var auto = root.getAttribute('data-height') === 'auto';
    if (ro && auto !== watchingSize) {
      ro.disconnect();
      watchingSize = auto;
      if (auto) {
        ro.observe(root);
        if (document.body) ro.observe(document.body);
      }
    }
    if (auto) measure();
  }
  watchSize();
  document.addEventListener('DOMContentLoaded', function () {
    if (ro && watchingSize && document.body) ro.observe(document.body);
    measure();
  });
  window.addEventListener('load', measure);

  function pad2(n) { return n < 10 ? '0' + n : String(n); }
  var zh = lang.indexOf('zh') === 0;
  var fmt = {
    bytes: function (n, digits) {
      n = Number(n);
      if (!isFinite(n)) return '—';
      var units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
      var i = 0;
      while (Math.abs(n) >= 1024 && i < units.length - 1) { n /= 1024; i++; }
      return n.toFixed(i === 0 ? 0 : digits == null ? 1 : digits) + ' ' + units[i];
    },
    percent: function (x, digits) {
      x = Number(x);
      return isFinite(x) ? (x * 100).toFixed(digits == null ? 0 : digits) + '%' : '—';
    },
    number: function (n, digits) {
      n = Number(n);
      if (!isFinite(n)) return '—';
      return n.toLocaleString(lang, digits == null ? undefined : { minimumFractionDigits: digits, maximumFractionDigits: digits });
    },
    ago: function (iso) {
      var t = typeof iso === 'number' ? iso : Date.parse(iso);
      if (!isFinite(t)) return '—';
      var s = Math.max(0, Math.round((Date.now() - t) / 1000));
      if (s < 5) return zh ? '刚刚' : 'just now';
      if (s < 60) return s + (zh ? ' 秒前' : 's ago');
      if (s < 3600) return Math.floor(s / 60) + (zh ? ' 分钟前' : 'm ago');
      if (s < 86400) return Math.floor(s / 3600) + (zh ? ' 小时前' : 'h ago');
      return Math.floor(s / 86400) + (zh ? ' 天前' : 'd ago');
    },
    duration: function (sec) {
      sec = Math.max(0, Math.floor(Number(sec)));
      if (!isFinite(sec)) return '—';
      var d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
      if (d > 0) return d + (zh ? '天 ' : 'd ') + h + (zh ? '小时' : 'h');
      if (h > 0) return h + (zh ? '小时 ' : 'h ') + m + (zh ? '分' : 'm');
      if (m > 0) return m + (zh ? '分 ' : 'm ') + s + (zh ? '秒' : 's');
      return s + (zh ? '秒' : 's');
    },
    time: function (iso) {
      var d = new Date(iso);
      return isNaN(d) ? '—' : pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }
  };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function clamp01(x) { x = Number(x); return isFinite(x) ? Math.max(0, Math.min(1, x)) : 0; }
  var gradientSeq = 0;
  var chart = {
    sparkline: function (values, opt) {
      opt = opt || {};
      var w = opt.width || 120, h = opt.height || 28, color = opt.color || 'var(--pad-accent)';
      var nums = (values || []).map(Number).filter(function (v) { return isFinite(v); });
      if (nums.length < 2) return '<svg width="' + w + '" height="' + h + '"></svg>';
      var min = opt.min != null ? opt.min : Math.min.apply(null, nums);
      var max = opt.max != null ? opt.max : Math.max.apply(null, nums);
      if (max === min) { max = min + 1; }
      var step = w / (nums.length - 1);
      var pts = nums.map(function (v, i) {
        var y = h - 1 - (v - min) / (max - min) * (h - 2);
        return (i * step).toFixed(1) + ',' + y.toFixed(1);
      });
      var id = 'pg' + (++gradientSeq);
      var area = opt.fill === false ? '' :
        '<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0" style="stop-color:' + color + ';stop-opacity:.28"/><stop offset="1" style="stop-color:' + color + ';stop-opacity:0"/></linearGradient></defs>' +
        '<polygon fill="url(#' + id + ')" points="0,' + h + ' ' + pts.join(' ') + ' ' + w + ',' + h + '"/>';
      return '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" style="display:block;overflow:visible">' +
        area + '<polyline style="fill:none;stroke:' + color + '" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" points="' + pts.join(' ') + '"/></svg>';
    },
    bar: function (fraction, opt) {
      opt = opt || {};
      var f = clamp01(fraction), color = opt.color || dsh.tone(f), h = opt.height || 6;
      return '<div style="height:' + h + 'px;border-radius:' + h + 'px;background:var(--pad-bg-2);overflow:hidden">' +
        '<div style="height:100%;width:' + (f * 100).toFixed(1) + '%;border-radius:inherit;background:' + color + ';transition:width .3s ease"></div></div>';
    },
    ring: function (fraction, opt) {
      opt = opt || {};
      var f = clamp01(fraction), size = opt.size || 44, sw = opt.stroke || 5, color = opt.color || dsh.tone(f);
      var r = (size - sw) / 2, c = 2 * Math.PI * r;
      var label = opt.label != null ? opt.label : Math.round(f * 100) + '%';
      return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '" style="display:block">' +
        '<circle cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" style="fill:none;stroke:var(--pad-bg-2)" stroke-width="' + sw + '"/>' +
        '<circle cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" style="fill:none;stroke:' + color + '" stroke-width="' + sw + '" stroke-linecap="round"' +
        ' stroke-dasharray="' + (c * f).toFixed(2) + ' ' + c.toFixed(2) + '" transform="rotate(-90 ' + size / 2 + ' ' + size / 2 + ')"/>' +
        '<text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" style="fill:var(--pad-fg);font-family:var(--pad-font);font-size:' + Math.round(size / 4) + 'px">' + esc(label) + '</text></svg>';
    }
  };

  var dsh = {
    get data() { return current; },
    onData: function (fn) {
      listeners.push(fn);
      if (current) { try { fn(current); } catch (e) { report(e); } }
      return function () { listeners = listeners.filter(function (l) { return l !== fn; }); };
    },
    history: function (sourceId) { return Array.isArray(histories[sourceId]) ? histories[sourceId].slice() : []; },
    refresh: function () { post({ kind: 'refresh' }); },
    openUrl: function (url) { post({ kind: 'open', url: String(url) }); },
    ask: function (text) { post({ kind: 'ask', text: String(text) }); },
    run: function (prompt, options) {
      var text = String(prompt == null ? '' : prompt);
      if (!text.trim()) return Promise.resolve({ ok: false, error: zh ? '提示词是空的' : 'Empty prompt' });
      var id = 'run-' + (++runSeq) + '-' + Math.random().toString(36).slice(2);
      var system = options && options.system != null ? String(options.system) : undefined;
      return new Promise(function (resolve) {
        var done = false;
        var timer;
        function finish(result) {
          if (done) return;
          done = true;
          delete pendingRuns[id];
          clearTimeout(timer);
          resolve(result);
        }
        timer = setTimeout(function () {
          finish({ ok: false, error: zh ? '模型调用超时' : 'Model call timed out' });
        }, 310000);
        pendingRuns[id] = finish;
        post({ kind: 'run', id: id, prompt: text, system: system });
      });
    },
    state: {
      get: function (key) { return stateStore[key]; },
      set: function (key, value) { stateStore[key] = value; post({ kind: 'state', key: String(key), value: value }); }
    },
    tone: function (fraction, warnAt, dangerAt) {
      var f = Number(fraction);
      if (f >= (dangerAt == null ? 0.9 : dangerAt)) return 'var(--pad-danger)';
      if (f >= (warnAt == null ? 0.7 : warnAt)) return 'var(--pad-warn)';
      return 'var(--pad-ok)';
    },
    escape: esc,
    fmt: fmt,
    chart: chart
  };
  window.dsh = dsh;
  post({ kind: 'ready' });
})();
`
