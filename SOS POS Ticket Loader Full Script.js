// ==UserScript==
// @name         SOS POS Ticket Loader
// @namespace    http://tampermonkey.net/
// @version      1.3
// @description  Paste rows from your tracking sheet. Reads col D status to route each row: create a repair Ticket, update an existing one (ticket # in col C), or build a product Sale. Refunds & notes are skipped and flagged Not completed. Quote reads from col L. Optional write-back pushes finished ticket #s into your Google Sheet via an Apps Script web app (bundled as a paste-once block at the bottom of this file). Reuses the Sales Loader's parser. Namespaced sostk-*.
// @author       Claude
// @match        https://app.sospos.com.au/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      script.google.com
// @connect      script.googleusercontent.com
// ==/UserScript==

(function () {
  'use strict';

  // Guard against a double-load (manager + direct install) — duplicate panels
  // would break tab switching.
  if (window.__sostkTicketLoaded__) return;
  window.__sostkTicketLoaded__ = true;

  // Keep this in lock-step with @version above. The TM Script Manager strips the
  // UserScript header before eval, so @version isn't readable at runtime — this
  // body constant is what the header badge shows.
  const SCRIPT_VERSION = '1.3';

  // ═════════════════════════════════════════════════════════════
  // Parser — lifted verbatim from your Sales Loader v2.8 so device /
  // job / name / phone extraction behaves identically across both tools.
  // ═════════════════════════════════════════════════════════════
  const Parser = (() => {
    function findPhone(text) {
      const cands = text.match(/(?:\+?61[\s-]?|0)?\d(?:[\s-]?\d){6,11}/g) || [];
      const valid = [];
      for (const c of cands) {
        let d = c.replace(/[^\d]/g,'');
        if (d.startsWith('61') && d.length >= 11) d = '0' + d.slice(2);
        if (d.length === 9 && d[0] === '4') d = '0' + d;
        if (d.length === 8) d = '02' + d;
        const isMobile = /^04\d{8}$/.test(d);
        const isLand   = /^0[2-9]\d{8}$/.test(d);
        if (!isMobile && !isLand) continue;
        valid.push({ pretty: prettyPhone(d), isMobile });
      }
      const mob = valid.find(v => v.isMobile);
      return mob ? mob.pretty : (valid.length ? valid[0].pretty : 'X');
    }
    function prettyPhone(d) {
      if (/^04\d{8}$/.test(d))   return d.replace(/(\d{4})(\d{3})(\d{3})/, '$1 $2 $3');
      if (/^0[2-9]\d{8}$/.test(d)) return d.replace(/(\d{2})(\d{4})(\d{4})/, '($1) $2 $3');
      return d;
    }

    const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
    const firstEmail = t => { const m = t.match(EMAIL_RE); return m ? m[0].toLowerCase() : ''; };

    const TIER  = '(pro max|pro|plus|max|mini|ultra|fe|\\+)';
    const cap   = s => s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : '';
    const upper = s => s ? s.toUpperCase().replace(/\s+/g,' ').trim() : '';
    function tierSuffix(t) {
      if (!t) return '';
      const x = t.toLowerCase().trim();
      return x === '+' ? ' Plus' : ' ' + x.split(/\s+/).map(cap).join(' ');
    }

    const DEVICE_PATTERNS = [
      { re: /\bipad\s*(pro|air|mini)?\s*(\d{1,2}\.\d|\d{1,2}\s*(?:"|inch))?\s*(\d{1,2})?(?:st|nd|rd|th)?\s*(?:gen)?\s*(a\d{4})?/i,
        fmt: m => ('iPad '+(m[1]?cap(m[1])+' ':'')+
                   (m[2]?m[2].trim()+' ':'')+
                   (m[3]?m[3]+' ':'')+
                   (m[4]?m[4].toUpperCase():'')).replace(/\s+/g,' ').trim() },
      { re: /\bmacbook\s*(pro|air)?\s*(a\d{4})?/i,
        fmt: m => 'MacBook'+(m[1]?' '+cap(m[1]):'')+( m[2]?' '+m[2].toUpperCase():'') },
      { re: /\bipod\b/i, fmt: () => 'iPod' },
      { re: new RegExp('\\biphone\\s*(\\d{1,2}s?|xs max|xs|xr|x|se\\s*\\d?|se)\\s*'+TIER+'?','i'),
        fmt: m => 'iPhone '+upper(m[1])+tierSuffix(m[2]) },
      { re: /\b(?:samsung\s+)?(?:galaxy\s+)?(s|note|tab)\s*(\d{1,3}[a-z]?)\s*(ultra|plus|fe|\+|pro)?/i,
        fmt: m => 'Galaxy '+m[1].toUpperCase()+m[2].toUpperCase()+tierSuffix(m[3]) },
      { re: /\b(?:samsung\s+)?(?:galaxy\s+)?a\s*(\d{2,3}[a-z]?)(?!\d)\s*(5g)?/i,
        fmt: m => 'Galaxy A'+m[1].toUpperCase()+(m[2]?' 5G':'') },
      { re: /\b(?:samsung\s+)?(?:galaxy\s+)?z\s*(flip|fold)\s*(\d)?/i,
        fmt: m => 'Galaxy Z '+cap(m[1])+(m[2]?' '+m[2]:'') },
      { re: /\bsamsung\s+(sm-?\w+)/i,          fmt: m => 'Samsung '+m[1].toUpperCase() },
      { re: /\bpixel\s*(\d{1,2}\s*a?)\s*(pro xl|pro|xl|fold)?/i,
        fmt: m => 'Pixel '+upper(m[1])+(m[2]?' '+m[2].split(/\s+/).map(cap).join(' '):'') },
      { re: /\b(oppo)\s*([a-z]?\d{2,3}[a-z]*(?:\s*\d?g)?)/i,
        fmt: m => 'Oppo '+m[2].toUpperCase().replace(/\s+/g,'') },
      { re: /\b(?:moto|motorola)\s*(edge\s*\d+|g\d+\w*|\w+)/i,
        fmt: m => 'Moto '+m[1].split(/\s+/).map(cap).join(' ') },
      { re: /\bnothing\s*phone\s*(\w+)/i,      fmt: m => 'Nothing Phone '+m[1] },
      { re: /\bhmd\s*(\w+\+?)/i,               fmt: m => 'HMD '+cap(m[1]) },
    ];

    function detectDevice(text) {
      let best = null;
      DEVICE_PATTERNS.forEach(p => {
        const m = text.match(p.re);
        if (m && (best === null || m.index < best.index))
          best = { device: p.fmt(m).replace(/\s+/g,' ').trim(), index: m.index };
      });
      return best || { device: '', index: -1 };
    }

    const JOBS = [
      [/charging?\s*port\s*clean|c\/?p\s*clean|port\s*clean/i,       'Charging Port Clean'],
      [/charging?\s*port|charge\s*port|c\/?p\b/i,                    'Charging Port'],
      [/rear\s*housing/i,                                             'Rear Housing'],
      [/rear\s*glass|back\s*glass|b\/?g\b/i,                         'Rear Glass'],
      [/camera\s*glass|cam\s*glass|cam(?:era)?\s*lens|lens\s*protector/i, 'Camera Glass'],
      [/\bcamera\b|\bcam\b/i,                                         'Camera'],
      [/housing|frame/i,                                              'Housing'],
      [/\boled\b/i,                                                   'OLED'],
      [/\blcd\b/i,                                                    'LCD'],
      [/\bdigi(?:tizer)?\b/i,                                         'Digitizer'],
      [/\bscreen\b|\bscre+ne?\b|\bsceen\b|screne/i,                  'Screen'],
      [/amp\s*battery|battery\s*amp|\bbattery\b|\bbatt\b/i,          'Battery'],
      [/data\s*transfer/i,                                            'Data Transfer'],
      [/data\s*recover(?:y|ed)?/i,                                    'Data Recovery'],
      [/virus\s*clean|scam\s*clean|\bvirus\b|\bscam\b/i,             'Virus Clean'],
      [/factory\s*reset|\brestore\b/i,                                'Restore'],
      [/ear\s*piece|earpiece|\bspeaker\b/i,                           'Speaker'],
      [/power\s*button/i,                                             'Power Button'],
      [/sim\s*tray/i,                                                 'Sim Tray'],
      [/signal\s*flex/i,                                              'Signal Flex'],
      [/microphone|\bmic\b/i,                                         'Microphone'],
      [/\bwd\b|water\s*damaged?|liquid\s*damaged?/i,                  'Water Damage'],
    ];

    const NARRATIVE_CUTOFFS = /\b(call:|pin:|imei|cx\b|customer|opened? (?:the )?device|testing ok|tried|warned|quoted|happy to|will (?:be|drop|call|pick)|came (?:back|in)|did ?n.?t|was ?n.?t|does ?n.?t|is ?n.?t|no image|no touch|glitch|liquid damage indicators|no notes|paid|deposit|apple id|password|passcode|aware it)\b/i;

    function detectJobsIn(segment) {
      const raw = [];
      for (const [re, label] of JOBS) {
        const g = new RegExp(re.source,'gi'); let m;
        while ((m = g.exec(segment)) !== null) {
          raw.push({ label, index: m.index, len: m[0].length });
          if (m.index === g.lastIndex) g.lastIndex++;
        }
      }
      raw.sort((a,b) => a.index-b.index || b.len-a.len);
      const accepted = [];
      for (const j of raw) {
        if (accepted.some(a => j.index < a.index+a.len && a.index < j.index+j.len)) continue;
        accepted.push(j);
      }
      const seen = new Set();
      return accepted.filter(j => seen.has(j.label) ? false : seen.add(j.label)).map(j => j.label);
    }

    function detectJobs(body) {
      const cut  = body.search(NARRATIVE_CUTOFFS);
      let head   = (cut > 0 ? body.slice(0,cut) : body).replace(/\s+and\s+/gi,' + ');
      const primary = head.split(',')[0];
      let jobs = detectJobsIn(primary);
      if (!jobs.length) jobs = detectJobsIn(body);
      if (jobs.length > 1) jobs = jobs.filter(j => j !== 'Water Damage');
      if ((jobs.includes('OLED') || jobs.includes('LCD')) && jobs.includes('Screen'))
        jobs = jobs.filter(j => j !== 'Screen');
      return jobs;
    }

    const NAME_JUNK = /\b(call|text only|text|mob|ph|phone|cx|walkin|walk-in)\b[:.]?/gi;
    function detectName(line) {
      const dashIdx  = line.search(/\s*-\s*/);
      const phoneM   = line.match(/(?:\+?61[\s-]?|0)?\d(?:[\s-]?\d){6,11}/);
      const phoneIdx = phoneM ? line.indexOf(phoneM[0]) : -1;
      let cut = line.length;
      if (dashIdx  >= 0) cut = Math.min(cut, dashIdx);
      if (phoneIdx >= 0) cut = Math.min(cut, phoneIdx);
      let name = line.slice(0,cut)
        .replace(NAME_JUNK,'')
        .replace(/[-–—:\s]+$/,'')
        .replace(/\s+/g,' ').trim();
      return /^(walk\s*-?in)?$/i.test(name) ? 'Walk-in' : (name || 'Walk-in');
    }

    function parseNote(rawLine) {
      const line  = String(rawLine).replace(/\s+/g,' ').trim();
      const name  = detectName(line);
      const phone = findPhone(line);
      const email = firstEmail(line);

      let body = line.replace(/^\s*walk\s*-?in\b[\s:-]*/i,' ');
      if (name && name !== 'Walk-in') body = body.replace(name,' ');
      body = body
        .replace(/(?:\+?61[\s-]?|0)?\d(?:[\s-]?\d){6,11}/g,' ')
        .replace(EMAIL_RE,' ')
        .replace(/\$\s*\d+(?:\.\d+)?/g,' ')
        .replace(/\bpin:?\s*\d+/gi,' ')
        .replace(/\s+/g,' ').trim();

      const { device } = detectDevice(body);
      const jobs = detectJobs(body);

      let item;
      if (device && jobs.length)  item = device + ' ' + jobs.join(' + ');
      else if (device)            item = device;
      else if (jobs.length)       item = jobs.join(' + ');
      else                        item = body.replace(/^[-–—\s]+|[-–—\s]+$/g,'') || '(see note)';

      return { name, phone, email, item: item.replace(/\s+/g,' ').trim(), device, jobs, raw: rawLine.trim() };
    }

    return { parseNote };
  })();

  // ═════════════════════════════════════════════════════════════
  // COLUMN MAP  (0-based, tab-separated paste)
  //  A=0 date · B=1 ticket# · C=2 ticket# · D=3 STATUS · E=4 cash · F=5 eftpos
  //  QUOTE = col L (index 11). Adjust in Settings if your $ column differs.
  // ═════════════════════════════════════════════════════════════
  const COL_DEFAULTS = { TICKET_B: 1, TICKET_C: 2, STATUS: 3, CASH: 4, EFTPOS: 5, QUOTE: 11 };

  // ═════════════════════════════════════════════════════════════
  // STATUS MAP  (your col-D code → how to route + which SOS POS status)
  //  route: 'ticket' (repair) · 'sale' (product) · 'note' (add note only) · 'manual' (defer)
  //  sos:   text to match against the SOS POS Status dropdown options.
  //  Edit freely in Settings — the `sos` strings must match your real
  //  dropdown option text (the form defaults to "Repairing").
  // ═════════════════════════════════════════════════════════════
  const STATUS_MAP_DEFAULT = {
    'REFUND':           { route: 'manual', sos: '' },
    'SYD/TO SEND':      { route: 'ticket', sos: 'Repairing' },
    'SYD':              { route: 'ticket', sos: 'Repairing' },
    'TO SEND':          { route: 'ticket', sos: 'Repairing' },
    'WAITING ON CX':    { route: 'ticket', sos: 'Waiting on Customer' },
    'BAR':              { route: 'ticket', sos: 'Repairing' },
    'NOTE':             { route: 'manual', sos: '' },
    'ORDER':            { route: 'ticket', sos: 'Waiting on Parts' },
    'PART NOT ORDERED': { route: 'ticket', sos: 'Waiting on Parts' },
    'PART ORDERED':     { route: 'ticket', sos: 'Waiting on Parts' },
    'ORDERED':          { route: 'ticket', sos: 'Waiting on Parts' },
  };

  // ═════════════════════════════════════════════════════════════
  // Settings
  // ═════════════════════════════════════════════════════════════
  const DEFAULTS = {
    stepDelay: 350,
    doaDefault: 'no',          // 'no' | 'yes'
    addNotes: true,            // drop the row note into the Notes dialog after create
    useNoteParser: true,
    writeback: 'off',          // 'off' | 'manual' | 'auto'
    webAppUrl: '',             // Apps Script web-app /exec URL
    sheetSecret: '',           // optional shared secret matching the Apps Script
    cols: { ...COL_DEFAULTS },
    statusMap: { ...STATUS_MAP_DEFAULT },
  };
  function loadCfg() {
    try {
      const c = Object.assign({}, DEFAULTS, JSON.parse(GM_getValue('sostk_cfg','{}')));
      c.cols      = Object.assign({}, COL_DEFAULTS, c.cols || {});
      c.statusMap = Object.assign({}, STATUS_MAP_DEFAULT, c.statusMap || {});
      return c;
    } catch { return JSON.parse(JSON.stringify(DEFAULTS)); }
  }
  function saveCfg(c) { GM_setValue('sostk_cfg', JSON.stringify(c)); }
  let cfg = loadCfg();
  const COL = () => cfg.cols;

  // ═════════════════════════════════════════════════════════════
  // Styles  (indigo accent so the two FABs are easy to tell apart)
  // ═════════════════════════════════════════════════════════════
  const style = document.createElement('style');
  style.textContent = `
    #sostk-fab {
      position: fixed; bottom: 20px; left: 280px; width: 44px; height: 44px;
      border-radius: 50%; background: #4f46e5; box-shadow: 0 3px 14px rgba(79,70,229,.55);
      border: none; cursor: pointer; z-index: 99999; display: flex; align-items: center;
      justify-content: center; font-size: 20px; transition: background .15s; user-select: none;
    }
    #sostk-fab:hover { background: #4338ca; }
    #sostk-panel {
      position: fixed; bottom: 72px; left: 20px; width: 440px; background: #0f172a;
      color: #e2e8f0; border-radius: 16px; box-shadow: 0 20px 60px rgba(0,0,0,.7);
      font-family: 'Segoe UI',system-ui,sans-serif; font-size: 13px; z-index: 99998;
      border: 1px solid #1e293b; display: none; overflow: hidden;
      max-height: calc(100vh - 88px);
    }
    #sostk-panel.open { display: flex; flex-direction: column; }
    #sostk-header {
      background: linear-gradient(135deg,#6366f1 0%,#4f46e5 100%); padding: 14px 16px;
      font-weight: 700; font-size: 15px; display: flex; align-items: center; gap: 8px; flex: 0 0 auto;
    }
    #sostk-header .sostk-title { flex: 1; }
    #sostk-ver {
      font-size: 10px; font-weight: 700; color: #e0e7ff; background: rgba(0,0,0,.22);
      border-radius: 20px; padding: 2px 8px; letter-spacing: .3px; white-space: nowrap;
    }
    #sostk-close-btn {
      background: rgba(255,255,255,.2); border: none; color: #fff; width: 26px; height: 26px;
      border-radius: 50%; cursor: pointer; font-size: 16px; line-height: 1; display: flex;
      align-items: center; justify-content: center;
    }
    #sostk-close-btn:hover { background: rgba(255,255,255,.35); }
    #sostk-tabs { display: flex; background: #0a1120; border-bottom: 1px solid #1e293b; flex: 0 0 auto; }
    .sostk-tab { flex: 1; padding: 9px 0; text-align: center; font-size: 12px; font-weight: 600;
      cursor: pointer; color: #64748b; border-bottom: 2px solid transparent; user-select: none; }
    .sostk-tab.active { color: #818cf8; border-bottom-color: #818cf8; }
    .sostk-pane { display: none; padding: 14px; }
    .sostk-pane.active { display: block; flex: 1 1 auto; min-height: 60px; overflow-y: auto; }
    .sostk-pane::-webkit-scrollbar { width: 6px; }
    .sostk-pane::-webkit-scrollbar-thumb { background: #334155; border-radius: 3px; }
    .sostk-field { margin-bottom: 10px; }
    .sostk-label { display: block; font-size: 11px; font-weight: 600; color: #64748b;
      margin-bottom: 4px; text-transform: uppercase; letter-spacing: .5px; }
    .sostk-input, .sostk-select, .sostk-textarea { width: 100%; box-sizing: border-box; background: #1e293b;
      border: 1px solid #334155; color: #e2e8f0; border-radius: 8px; padding: 7px 10px;
      font-size: 13px; outline: none; font-family: inherit; }
    .sostk-textarea { font-family: ui-monospace,Menlo,Consolas,monospace; font-size: 11.5px; min-height: 120px; resize: vertical; }
    .sostk-input:focus, .sostk-select:focus, .sostk-textarea:focus { border-color: #6366f1; }
    .sostk-select option { background: #1e293b; }
    .sostk-btn { padding: 9px 14px; border-radius: 8px; border: none; cursor: pointer;
      font-weight: 600; font-size: 13px; white-space: nowrap; transition: opacity .15s, transform .1s; }
    .sostk-btn:hover { opacity: .88; } .sostk-btn:active { transform: scale(.97); }
    .sostk-btn:disabled { opacity: .4; cursor: not-allowed; }
    .sostk-btn-primary { background: linear-gradient(135deg,#6366f1,#4f46e5); color: #fff; }
    .sostk-btn-success { background: #16a34a; color: #fff; }
    .sostk-btn-muted { background: #334155; color: #94a3b8; }
    .sostk-btn-sm { padding: 5px 10px; font-size: 12px; }
    .sostk-btn-row { display: flex; gap: 6px; margin-top: 8px; }
    #sostk-drop-zone { border: 2px dashed #334155; border-radius: 10px; padding: 18px 14px;
      text-align: center; cursor: pointer; margin-bottom: 10px; position: relative;
      transition: border-color .2s, background .2s; }
    #sostk-drop-zone:hover { border-color: #6366f1; background: rgba(99,102,241,.06); }
    #sostk-drop-zone .dz-icon { font-size: 26px; margin-bottom: 4px; }
    #sostk-drop-zone .dz-main { font-size: 13px; font-weight: 600; color: #cbd5e1; margin-bottom: 2px; }
    #sostk-drop-zone .dz-sub { font-size: 11px; color: #475569; }
    #sostk-drop-zone.has-data { border-style: solid; border-color: #4f46e5; background: rgba(79,70,229,.06);
      padding: 10px 14px; text-align: left; cursor: default; }
    #sostk-drop-zone.has-data .dz-icon, #sostk-drop-zone.has-data .dz-main, #sostk-drop-zone.has-data .dz-sub { display: none; }
    #sostk-paste { position: absolute; opacity: 0; width: 1px; height: 1px; pointer-events: none; top: 0; left: 0; }
    #sostk-paste-summary { display: none; align-items: center; gap: 8px; font-size: 12px; color: #c7d2fe; }
    #sostk-paste-summary .ps-count { background: #3730a3; color: #c7d2fe; border-radius: 20px; padding: 2px 9px; font-weight: 700; }
    #sostk-paste-summary .ps-clear { margin-left: auto; cursor: pointer; color: #f87171; font-size: 16px; line-height: 1; padding: 2px 4px; }
    #sostk-preview { max-height: 320px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; margin-top: 2px; }
    #sostk-preview::-webkit-scrollbar { width: 4px; }
    #sostk-preview::-webkit-scrollbar-thumb { background: #334155; border-radius: 2px; }
    .sostk-section-h { font-size: 10px; font-weight: 800; letter-spacing: .8px; text-transform: uppercase;
      color: #64748b; margin: 4px 0 -2px; }
    .sostk-job { background: #131f2e; border: 1px solid #1e293b; border-radius: 10px; padding: 9px 11px; }
    .sostk-job.active { background: #1e1b4b; border-color: #6366f1; }
    .sostk-job.done { background: #0a150a; border-color: #166534; opacity: .65; }
    .sostk-job.update { background: #0c1a26; border-color: #0e7490; }
    .sostk-job.manual { background: #160d1f; border-color: #6d28d9; }
    .sostk-job-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
    .sostk-badge { border-radius: 6px; padding: 1px 7px; font-size: 10px; font-weight: 800; }
    .sostk-badge.ticket { background: #312e81; color: #c7d2fe; }
    .sostk-badge.sale   { background: #134e4a; color: #5eead4; }
    .sostk-badge.update { background: #155e75; color: #a5f3fc; }
    .sostk-badge.note   { background: #422006; color: #fdba74; }
    .sostk-badge.manual { background: #4c1d95; color: #c4b5fd; }
    .sostk-job-name { font-size: 12.5px; font-weight: 700; color: #e2e8f0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sostk-job-status { margin-left: auto; font-size: 10.5px; font-weight: 700; color: #a5b4fc; background:#1e1b4b; border-radius:6px; padding:1px 7px; }
    .sostk-job-sub { font-size: 10.5px; color: #64748b; margin-bottom: 4px; }
    .sostk-line { display: flex; gap: 6px; font-size: 11px; color: #94a3b8; padding: 2px 0; border-top: 1px solid #1e293b; }
    .sostk-line:first-of-type { border-top: none; }
    .sostk-line .ln-desc { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sostk-line .ln-quote { color: #818cf8; font-weight: 600; }
    .sostk-note-row { font-size: 10px; color: #64748b; font-style: italic; margin-top: 4px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sostk-q-edit { width:100%; box-sizing:border-box; background:#1e293b; border:1px solid #6366f1;
      color:#e2e8f0; border-radius:6px; padding:5px 8px; font-size:12px; outline:none; margin-top:5px; }
    .sostk-q-edit::placeholder { color:#475569; }
    #sostk-prog-wrap { margin-top: 10px; }
    #sostk-prog-bg { height: 5px; background: #1e293b; border-radius: 3px; overflow: hidden; }
    #sostk-prog-bar { height: 100%; width: 0%; background: linear-gradient(90deg,#6366f1,#4f46e5); border-radius: 3px; transition: width .4s; }
    #sostk-status { margin-top: 6px; font-size: 11.5px; color: #94a3b8; min-height: 16px; text-align: center; }
    .sostk-divider { border: none; border-top: 1px solid #1e293b; margin: 12px 0; }
    .sostk-note { color: #475569; font-size: 11px; line-height: 1.6; margin: 0; }
    .sostk-note b { color: #a5b4fc; }
    .sostk-row2 { display: flex; gap: 8px; } .sostk-row2 > * { flex: 1; }
    #sostk-results-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    #sostk-results-table th { text-align: left; color: #64748b; font-size: 10px; text-transform: uppercase; padding: 4px; }
    #sostk-results-table td { padding: 3px 4px; border-top: 1px solid #1e293b; }
    #sostk-results-table input { width: 78px; background: #1e293b; border: 1px solid #334155; color: #e2e8f0;
      border-radius: 6px; padding: 4px 6px; font-size: 12px; }
    .sostk-res-name { color: #cbd5e1; }
    #sostk-results-empty { color: #475569; font-size: 12px; text-align: center; padding: 16px 0; }
  `;
  document.head.appendChild(style);

  // ═════════════════════════════════════════════════════════════
  // FAB + panel
  // ═════════════════════════════════════════════════════════════
  const fab = document.createElement('button');
  fab.id = 'sostk-fab'; fab.title = 'SOS POS Ticket Loader'; fab.innerHTML = '🔧';
  document.body.appendChild(fab);
  [400, 1200, 2500, 4500].forEach(t => setTimeout(positionFab, t));
  window.addEventListener('resize', () => setTimeout(positionFab, 100));

  const panel = document.createElement('div');
  panel.id = 'sostk-panel';
  panel.innerHTML = `
    <div id="sostk-header">
      <span>🔧</span><span class="sostk-title">Ticket Loader</span>
      <span id="sostk-ver">v…</span>
      <button id="sostk-close-btn" title="Close">✕</button>
    </div>
    <div id="sostk-tabs">
      <div class="sostk-tab active" data-tab="build">🛠 Build</div>
      <div class="sostk-tab" data-tab="results">📋 Results</div>
      <div class="sostk-tab" data-tab="settings">⚙ Settings</div>
    </div>

    <!-- BUILD -->
    <div class="sostk-pane active" id="sostk-tab-build">
      <div id="sostk-drop-zone" tabindex="0" title="Click then Ctrl+V to paste">
        <textarea id="sostk-paste" tabindex="-1" aria-hidden="true"></textarea>
        <div class="dz-icon">📋</div>
        <div class="dz-main">Click here, then paste the day's rows</div>
        <div class="dz-sub">Col D status routes each row: ticket · update · sale · not-completed.</div>
        <div id="sostk-paste-summary">
          <span class="ps-count" id="sostk-count-badge">0</span>
          <span id="sostk-count-label">rows ready</span>
          <span class="ps-clear" id="sostk-dz-clear" title="Clear">✕</span>
        </div>
      </div>
      <div class="sostk-btn-row">
        <button class="sostk-btn sostk-btn-success" id="sostk-build-btn" style="display:none;flex:1">▶ Start</button>
        <button class="sostk-btn sostk-btn-muted sostk-btn-sm" id="sostk-clear-btn" style="display:none">Clear</button>
      </div>
      <div id="sostk-preview"></div>
      <div id="sostk-prog-wrap"><div id="sostk-prog-bg"><div id="sostk-prog-bar"></div></div><div id="sostk-status"></div></div>
    </div>

    <!-- RESULTS -->
    <div class="sostk-pane" id="sostk-tab-results">
      <div id="sostk-results-empty">No tickets captured yet.</div>
      <table id="sostk-results-table" style="display:none">
        <thead><tr><th>Ticket #</th><th>Name</th><th>Action</th></tr></thead>
        <tbody id="sostk-results-body"></tbody>
      </table>
      <div class="sostk-btn-row" id="sostk-results-actions" style="display:none">
        <button class="sostk-btn sostk-btn-primary sostk-btn-sm" id="sostk-copy-btn" style="flex:1">📋 Copy</button>
        <button class="sostk-btn sostk-btn-success sostk-btn-sm" id="sostk-push-btn" style="flex:1">⬆ Push to Sheet</button>
        <button class="sostk-btn sostk-btn-muted sostk-btn-sm" id="sostk-results-clear">Clear</button>
      </div>
      <p class="sostk-note" style="margin-top:8px">Ticket #s are <b>editable</b> — fix any before copying. <b>Copy</b> outputs ticket numbers only (one per line).</p>
    </div>

    <!-- SETTINGS -->
    <div class="sostk-pane" id="sostk-tab-settings">
      <div class="sostk-row2">
        <div class="sostk-field">
          <label class="sostk-label">Add row note to Notes dialog</label>
          <select class="sostk-select" id="sostk-add-notes">
            <option value="yes">Yes — open Notes & paste</option>
            <option value="no">No</option>
          </select>
        </div>
        <div class="sostk-field">
          <label class="sostk-label">Default DOA answer</label>
          <select class="sostk-select" id="sostk-doa">
            <option value="no">No</option><option value="yes">Yes</option>
          </select>
        </div>
      </div>
      <div class="sostk-row2">
        <div class="sostk-field">
          <label class="sostk-label">Smart note parser</label>
          <select class="sostk-select" id="sostk-note-parser">
            <option value="yes">On — device + issues</option>
            <option value="no">Off — raw description</option>
          </select>
        </div>
        <div class="sostk-field">
          <label class="sostk-label">Step delay (ms)</label>
          <input class="sostk-input" id="sostk-step-delay" type="number" min="100" step="50" />
        </div>
      </div>

      <hr class="sostk-divider">
      <div class="sostk-field">
        <label class="sostk-label">Sheet write-back</label>
        <select class="sostk-select" id="sostk-writeback">
          <option value="off">Off</option>
          <option value="manual">Manual — Copy / Push buttons only</option>
          <option value="auto">Auto — push to sheet when a batch finishes</option>
        </select>
      </div>
      <div class="sostk-field">
        <label class="sostk-label">Apps Script Web App URL</label>
        <input class="sostk-input" id="sostk-webapp" type="text" placeholder="https://script.google.com/macros/s/…/exec" />
      </div>
      <div class="sostk-field">
        <label class="sostk-label">Shared secret (optional)</label>
        <input class="sostk-input" id="sostk-secret" type="text" placeholder="must match the Apps Script SECRET" />
      </div>

      <div class="sostk-field">
        <label class="sostk-label">Column map (0-based, JSON)</label>
        <textarea class="sostk-textarea" id="sostk-cols" style="min-height:64px"></textarea>
      </div>
      <div class="sostk-field">
        <label class="sostk-label">Status map — col D code → route + SOS status (JSON)</label>
        <textarea class="sostk-textarea" id="sostk-statusmap"></textarea>
      </div>

      <button class="sostk-btn sostk-btn-primary sostk-btn-sm" id="sostk-save-cfg">Save settings</button>
      <button class="sostk-btn sostk-btn-muted sostk-btn-sm" id="sostk-reset-cfg" style="margin-left:6px">Reset maps</button>
      <hr class="sostk-divider">
      <p class="sostk-note">
        <b>route</b> values: <b>ticket</b> (create repair) · <b>sale</b> (product) · <b>manual</b> (skip → Not completed).<br>
        <b>sos</b> must match your real Status dropdown text (form default is "Repairing").<br>
        Rows with a ticket # already in col C become an <b>Update</b> (set status + add note, no new ticket).<br>
        <b>Refunds & notes</b> are skipped and listed under <b>Not completed</b> for you to handle.<br>
        <b>Columns:</b> C = existing ticket# · D = status · E = cash · F = eftpos · L = quote (a number is used; the word “quote” prompts you) · description = col after PIN.<br>
        <b>Write-back:</b> set the Web App URL above, then use <b>⬆ Push to Sheet</b> in Results (or pick Auto). It matches each row by its description and writes the ticket # into col C.
      </p>
    </div>
  `;
  document.body.appendChild(panel);

  (function () {
    const vEl = document.getElementById('sostk-ver');
    if (vEl) { vEl.textContent = 'v' + SCRIPT_VERSION; vEl.title = 'Ticket Loader version ' + SCRIPT_VERSION; }
  })();

  fab.addEventListener('click', () => panel.classList.toggle('open'));
  document.getElementById('sostk-close-btn').addEventListener('click', () => panel.classList.remove('open'));
  document.querySelectorAll('.sostk-tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  // settings wiring
  const $addNotes = document.getElementById('sostk-add-notes');
  const $doa      = document.getElementById('sostk-doa');
  const $noteP    = document.getElementById('sostk-note-parser');
  const $delay    = document.getElementById('sostk-step-delay');
  const $cols     = document.getElementById('sostk-cols');
  const $statusmap= document.getElementById('sostk-statusmap');
  const $writeback= document.getElementById('sostk-writeback');
  const $webapp   = document.getElementById('sostk-webapp');
  const $secret   = document.getElementById('sostk-secret');

  function fillSettings() {
    $addNotes.value = cfg.addNotes ? 'yes' : 'no';
    $doa.value      = cfg.doaDefault === 'yes' ? 'yes' : 'no';
    $noteP.value    = cfg.useNoteParser ? 'yes' : 'no';
    $delay.value    = cfg.stepDelay;
    $cols.value     = JSON.stringify(cfg.cols, null, 0);
    $statusmap.value= JSON.stringify(cfg.statusMap, null, 2);
    $writeback.value= cfg.writeback || 'off';
    $webapp.value   = cfg.webAppUrl || '';
    $secret.value   = cfg.sheetSecret || '';
  }
  fillSettings();

  document.getElementById('sostk-save-cfg').addEventListener('click', () => {
    cfg.addNotes      = $addNotes.value === 'yes';
    cfg.doaDefault    = $doa.value === 'yes' ? 'yes' : 'no';
    cfg.useNoteParser = $noteP.value === 'yes';
    cfg.stepDelay     = Math.max(100, parseInt($delay.value,10) || DEFAULTS.stepDelay);
    cfg.writeback     = $writeback.value;
    cfg.webAppUrl     = $webapp.value.trim();
    cfg.sheetSecret   = $secret.value.trim();
    try { cfg.cols      = Object.assign({}, COL_DEFAULTS, JSON.parse($cols.value)); }
    catch { setStatus('⚠️ Column map JSON invalid — not saved.'); return; }
    try { cfg.statusMap = JSON.parse($statusmap.value); }
    catch { setStatus('⚠️ Status map JSON invalid — not saved.'); return; }
    saveCfg(cfg); setStatus('✓ Settings saved.');
    if (rawCache) doParse(rawCache);
  });
  document.getElementById('sostk-reset-cfg').addEventListener('click', () => {
    cfg.cols = { ...COL_DEFAULTS }; cfg.statusMap = { ...STATUS_MAP_DEFAULT };
    fillSettings(); setStatus('Maps reset to defaults — Save to keep.');
  });

  // ═════════════════════════════════════════════════════════════
  // State
  // ═════════════════════════════════════════════════════════════
  let jobs = [], builtIdx = -1, rawCache = '', results = [];
  const captured = new Set();

  const dropZone = document.getElementById('sostk-drop-zone');
  const pasteArea = document.getElementById('sostk-paste');
  dropZone.addEventListener('click', e => { if (e.target.id === 'sostk-dz-clear') return; if (!dropZone.classList.contains('has-data')) pasteArea.focus(); });
  pasteArea.addEventListener('paste', e => {
    e.preventDefault();
    const raw = (e.clipboardData || window.clipboardData).getData('text');
    pasteArea.value = raw; setTimeout(() => doParse(raw), 40);
  });
  document.getElementById('sostk-dz-clear').addEventListener('click', clearAll);

  // ═════════════════════════════════════════════════════════════
  // Parse helpers
  // ═════════════════════════════════════════════════════════════
  function num(v) { const n = parseFloat(String(v||'').replace(/[^0-9.]/g,'')); return isNaN(n)?0:n; }
  function isExistingTicket(t) { return /^[A-Z]\d{3,}/.test((t||'').trim()); }

  function extractDescription(cols) {
    const pin = cols.findIndex(c => c.trim().toUpperCase() === 'PIN');
    if (pin >= 0 && cols[pin+1] && cols[pin+1].trim()) return cols[pin+1].trim();
    for (let i=cols.length-1; i>=0; i--) if (cols[i] && cols[i].trim()) return cols[i].trim();
    return '';
  }

  // Normalise a col-D value and look it up in the status map.
  function statusInfo(rawStatus) {
    const key = String(rawStatus||'').toUpperCase().replace(/\s+/g,' ').trim();
    if (cfg.statusMap[key]) return { code: key, ...cfg.statusMap[key] };
    // soft match: drop trailing punctuation / try a contains pass
    const hit = Object.keys(cfg.statusMap).find(k => key && (k.includes(key) || key.includes(k)));
    return hit ? { code: key, ...cfg.statusMap[hit] } : { code: key, route: '', sos: '' };
  }

  // ═════════════════════════════════════════════════════════════
  // doParse — classify each row into a job
  // ═════════════════════════════════════════════════════════════
  const SKIP = /^(date|ticket|status|description|no\.?|google|balanced|fri|sat|sun|mon|tue|wed|thu|customer|order|ordered)$/i;

  function doParse(raw) {
    rawCache = raw;
    if (!raw) { setStatus('⚠️ Nothing pasted yet.'); return; }
    const c = COL();
    const out = [];

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const cols = line.split('\t');
      const desc = extractDescription(cols);
      if (!desc || SKIP.test(desc.trim())) continue;

      const ticketC = (cols[c.TICKET_C] || '').trim();
      const ticket  = isExistingTicket(ticketC) ? ticketC : '';   // existing ticket lives in col C only
      const rawStatus = (cols[c.STATUS] || '').trim();
      const si = statusInfo(rawStatus);

      // Quote lives in col L. A number → use it. The word "quote" → flag for a
      // popup / inline entry. Sales fall back to the cash+eftpos columns.
      const qRaw = (cols[c.QUOTE] || '').trim();
      const qNum = num(qRaw);
      const qIsWord = /quote/i.test(qRaw) && qNum === 0;
      const payNum = num(cols[c.CASH]) + num(cols[c.EFTPOS]);

      const r = cfg.useNoteParser ? Parser.parseNote(desc)
                                  : { name:'', phone:'X', email:'', item:desc, device:'', jobs:[] };

      // Decide route. Status map wins; fall back to content.
      let route = si.route;
      if (route === 'note') route = 'manual';   // notes are skipped → Not completed
      if (!route) {
        if (r.device || (r.jobs && r.jobs.length)) route = 'ticket';
        else if (payNum > 0 || qNum > 0)            route = 'sale';
        else                                        route = 'manual';
      }

      // Quote + needs-popup flag depend on route.
      let quote = 0, needsQuote = false;
      if (route === 'sale')        quote = payNum || qNum;
      else if (route === 'ticket') { quote = qNum; needsQuote = qIsWord; }

      // Existing ticket (col C) + ticket route = update, not create.
      let kind;
      if (route === 'sale')        kind = 'sale';
      else if (route === 'manual') kind = 'manual';
      else                         kind = ticket ? 'update' : 'ticket';

      out.push({
        kind,                      // ticket | sale | update | note | manual
        route, ticket,
        statusCode: si.code, sosStatus: si.sos,
        customer: { name: r.name || (kind==='sale'?'Walk-in':'(no name)'), phone: r.phone || 'X', email: r.email || '' },
        device: r.device || '',
        jobs:   (r.jobs && r.jobs.length) ? r.jobs : [],
        item:   r.item || desc,
        quote, needsQuote,
        note:   desc,             // full original line goes into the Notes dialog
        status: 'pending',
      });
    }

    jobs = out; builtIdx = -1; captured.clear();
    renderPreview();

    const buildable = jobs.filter(j => j.kind !== 'manual').length;
    if (jobs.length) {
      dropZone.classList.add('has-data');
      document.getElementById('sostk-paste-summary').style.display = 'flex';
      document.getElementById('sostk-count-badge').textContent = jobs.length;
      const counts = ['ticket','update','sale','note','manual']
        .map(k => { const n = jobs.filter(j=>j.kind===k).length; return n && `${n} ${k}`; })
        .filter(Boolean).join(' · ');
      document.getElementById('sostk-count-label').textContent = counts;
      const b = document.getElementById('sostk-build-btn');
      if (buildable) {
        const first = jobs.find(j=>j.kind!=='manual');
        b.style.display = 'block'; b.disabled = false;
        b.textContent = `▶ Start — Build 1/${buildable} (${labelOf(first)})`;
      } else { b.style.display = 'none'; }
      document.getElementById('sostk-clear-btn').style.display = 'block';
      setStatus(buildable ? '' : 'ℹ️ Nothing auto-buildable — all rows need manual handling.');
    } else {
      dropZone.classList.remove('has-data');
      setStatus('⚠️ No valid rows found — check the column map in Settings.');
    }
  }

  function labelOf(job) {
    if (!job) return '';
    if (job.kind === 'sale')   return job.customer.name || 'Walk-in';
    if (job.kind === 'update') return job.ticket + ' · ' + (job.customer.name||'');
    return job.customer.name || job.item;
  }

  // ═════════════════════════════════════════════════════════════
  // renderPreview
  // ═════════════════════════════════════════════════════════════
  const KIND_META = {
    ticket: { badge:'ticket', label:'New tickets — repairs' },
    update: { badge:'update', label:'Update existing tickets' },
    sale:   { badge:'sale',   label:'Sales — products' },
    note:   { badge:'note',   label:'Add note only (no ticket #)' },
    manual: { badge:'manual', label:'Not completed — skipped (refunds / notes / unparsed)' },
  };
  function renderPreview() {
    const order = ['ticket','update','sale','note','manual'];
    const html = [];
    for (const kind of order) {
      const group = jobs.map((j,gi)=>({j,gi})).filter(x=>x.j.kind===kind);
      if (!group.length) continue;
      html.push(`<div class="sostk-section-h">${KIND_META[kind].label} (${group.length})</div>`);
      for (const { j, gi } of group) {
        const badgeText = kind === 'manual' ? 'NOT DONE' : kind.toUpperCase();
        const badge = `<span class="sostk-badge ${KIND_META[kind].badge}">${badgeText}</span>`;
        const title = esc(labelOf(j));
        const statusTag = (kind==='ticket'||kind==='update') && j.sosStatus
          ? `<span class="sostk-job-status">→ ${esc(j.sosStatus)}</span>` : '';
        const sub = (j.customer.phone && j.customer.phone!=='X')
          ? `<div class="sostk-job-sub">☎ ${esc(j.customer.phone)}${j.customer.email?' · ✉ '+esc(j.customer.email):''}</div>` : '';
        const dev = (j.device || j.jobs.length)
          ? `<div class="sostk-line"><span class="ln-desc">${esc([j.device, j.jobs.join(' + ')].filter(Boolean).join(' · '))}</span>${j.quote?`<span class="ln-quote">$${j.quote.toFixed(2)}</span>`:''}</div>`
          : (j.item ? `<div class="sostk-line"><span class="ln-desc">${esc(j.item)}</span>${j.quote?`<span class="ln-quote">$${j.quote.toFixed(2)}</span>`:''}</div>` : '');
        const quoteEdit = (j.needsQuote && (kind==='ticket'||kind==='update'))
          ? `<input class="sostk-q-edit" data-gi="${gi}" type="number" step="0.01" min="0" placeholder="Cell says “quote” — enter $ here, or leave blank to be asked" value="${j.quote||''}">`
          : '';
        const noteRow = cfg.addNotes && j.note ? `<div class="sostk-note-row" title="${esc(j.note)}">📝 ${esc(j.note.slice(0,90))}${j.note.length>90?'…':''}</div>` : '';
        html.push(`
          <div class="sostk-job ${j.status==='done'?'done':(kind==='update'?'update':kind==='manual'?'manual':'')}" id="sostk-job-${gi}">
            <div class="sostk-job-head">${badge}<span class="sostk-job-name">${title}</span>${statusTag}</div>
            ${sub}${dev}${quoteEdit}${noteRow}
          </div>`);
      }
    }
    document.getElementById('sostk-preview').innerHTML = html.join('');
    document.querySelectorAll('.sostk-q-edit').forEach(inp => {
      inp.addEventListener('input', () => { const gi = Number(inp.dataset.gi); if (jobs[gi]) jobs[gi].quote = parseFloat(inp.value) || 0; });
    });
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

  function clearAll() {
    jobs=[]; builtIdx=-1; rawCache=''; captured.clear();
    pasteArea.value='';
    document.getElementById('sostk-preview').innerHTML='';
    document.getElementById('sostk-build-btn').style.display='none';
    document.getElementById('sostk-clear-btn').style.display='none';
    document.getElementById('sostk-prog-bar').style.width='0%';
    dropZone.classList.remove('has-data');
    document.getElementById('sostk-paste-summary').style.display='none';
    setStatus('');
  }

  function setStatus(m) { document.getElementById('sostk-status').textContent = m; }
  function setJobStatus(i,s) { jobs[i].status=s; const el=document.getElementById(`sostk-job-${i}`); if(el) el.classList.toggle('active', s==='active'); if(el && s==='done') el.classList.add('done'); }
  function setProgress() {
    const buildable = jobs.filter(j=>j.kind!=='manual');
    const done = buildable.filter(j=>j.status==='done').length;
    document.getElementById('sostk-prog-bar').style.width = buildable.length?`${Math.round(done/buildable.length*100)}%`:'0%';
  }

  // ═════════════════════════════════════════════════════════════
  // Build stepping — one job per click
  // ═════════════════════════════════════════════════════════════
  const buildBtn = document.getElementById('sostk-build-btn');
  buildBtn.addEventListener('click', onBuildClick);
  document.getElementById('sostk-clear-btn').addEventListener('click', clearAll);

  function nextBuildable(from) {
    let i = from;
    while (i < jobs.length && jobs[i].kind === 'manual') i++;
    return i;
  }

  async function onBuildClick() {
    buildBtn.disabled = true;
    let i = nextBuildable(builtIdx + 1);
    if (i >= jobs.length) { finishAll(); return; }

    setJobStatus(i, 'active');
    setStatus(`Building ${labelOf(jobs[i])}…`);
    try {
      await buildJob(jobs[i]);
      captureResult(i);
      setJobStatus(i, 'done'); builtIdx = i; setProgress();
      const n = nextBuildable(i + 1);
      if (n < jobs.length) {
        buildBtn.disabled = false;
        buildBtn.textContent = `▶ Next (${jobs.filter((j,k)=>k<=i&&j.kind!=='manual').length + 1}/${jobs.filter(j=>j.kind!=='manual').length})`;
        setStatus(`✓ Done "${labelOf(jobs[i])}". Click for next.`);
      } else finishAll();
    } catch (e) {
      setJobStatus(i, 'pending'); jobs[i].status='pending';
      buildBtn.disabled = false;
      buildBtn.textContent = `▶ Retry ${labelOf(jobs[i])}`;
      setStatus('✕ ' + e.message); console.error('[SOS Ticket Loader]', e);
    }
  }

  function finishAll() {
    const manual = jobs.filter(j=>j.kind==='manual').length;
    buildBtn.textContent = '✓ All done';
    buildBtn.disabled = true;
    setStatus(`🎉 Finished — ${results.length} captured${manual?`, ${manual} manual row${manual>1?'s':''} left for you`:''}. See Results.`);
    if (cfg.writeback === 'auto' && cfg.webAppUrl && results.length) pushToSheet(true);
    switchTab('results');
  }

  // ═════════════════════════════════════════════════════════════
  // Build dispatch
  // ═════════════════════════════════════════════════════════════
  async function buildJob(job) {
    if (job.kind === 'ticket')      await buildTicket(job);
    else if (job.kind === 'update') await updateTicket(job);
    else if (job.kind === 'sale')   await buildSale(job);
    else if (job.kind === 'note')   await noteOnlyJob(job);
  }

  // ── Create a new repair ticket ────────────────────────────────
  async function buildTicket(job) {
    const tab = findTab('Ticket');
    if (tab) { tab.click(); await sleep(cfg.stepDelay); }

    await createCustomer(job.customer);

    if (job.device) await setDeviceField(job.device);
    if (job.jobs.length) await setIssues(job.jobs);

    if (cfg.doaDefault) { const r = document.getElementById('doa-'+cfg.doaDefault); if (r && r.getAttribute('aria-checked')!=='true') { r.click(); await sleep(120); } }

    if (job.sosStatus) await setTicketStatus(job.sosStatus);

    let quoteVal = job.quote;
    if (job.needsQuote && !(quoteVal > 0)) {
      const entered = await askQuote(labelOf(job));   // popup: type a number, or Skip
      if (entered != null && entered > 0) quoteVal = entered;
    }
    if (quoteVal > 0) {
      const q = findQuoteInput();
      if (q) { setNativeValue(q, String(quoteVal)); await sleep(120); }
    }

    const createBtn = Array.from(document.querySelectorAll('button')).find(b => /create ticket/i.test(b.textContent.trim()));
    if (!createBtn) throw new Error('Create Ticket button not found');
    let t=0; while (createBtn.disabled && t<14) { await sleep(150); t++; }
    if (createBtn.disabled) throw new Error('Create Ticket stayed disabled — a required field (device/issues) likely did not stick. Form left open.');
    createBtn.click();
    await sleep(cfg.stepDelay + 400);

    if (cfg.addNotes && job.note) {
      const tk = latestTicket();
      job.ticket = tk || job.ticket;
      try { await addNote(tk, job.note); }
      catch (e) { setStatus('⚠️ Ticket made, note skipped: ' + e.message); }
    }
  }

  // ── Update an existing ticket (status + note) ─────────────────
  //  NEEDS your board/search DOM to open the ticket. The status-set
  //  and add-note steps below are wired; openTicketByNumber is the
  //  one helper that needs the snippet for searching/opening a ticket.
  async function updateTicket(job) {
    const opened = await openTicketByNumber(job.ticket);
    if (!opened) throw new Error(`Could not open ticket ${job.ticket} — need the board/search DOM to wire this. Skipped.`);
    if (job.sosStatus) await setTicketStatus(job.sosStatus);
    if (cfg.addNotes && job.note) await addNote(job.ticket, job.note);
  }

  // ── Add a note to an existing ticket only ─────────────────────
  async function noteOnlyJob(job) {
    if (!job.ticket) throw new Error('Note row has no ticket # — handle manually.');
    if (!job.note) return;
    await addNote(job.ticket, job.note);
  }

  // ── Build a quick product sale (walk-in) — reuses Sale tab ────
  async function buildSale(job) {
    const tab = findTab('Sale');
    if (tab) { tab.click(); await sleep(cfg.stepDelay); }
    const w = findWalkInButton();
    if (!w) throw new Error('Walk-in button not found on Sale tab');
    w.click(); await sleep(cfg.stepDelay + 150);

    const descs  = lineInputs('Item description'), prices = lineInputs('0.00');
    if (descs[0]) { setNativeValue(descs[0], job.item || '(item)'); await sleep(90); }
    if (prices[0]) { setNativeValue(prices[0], String(job.quote || 0)); await sleep(cfg.stepDelay); }
    // Left at the built sale for you to take payment — sales payment flow
    // lives in the Sales Loader; this just stages the line.
    setStatus(`🏷️ Sale staged for ${labelOf(job)} — take payment in SOS POS.`);
  }

  // ═════════════════════════════════════════════════════════════
  // Create customer  (reused verbatim from the Sales Loader)
  // ═════════════════════════════════════════════════════════════
  async function createCustomer(c) {
    const addBtn = findAddCustomerButton();
    if (!addBtn) throw new Error('Add-customer (+) button not found');
    addBtn.click();

    const dialog = await waitFor(() => document.querySelector('[role="dialog"]'), 4000);
    if (!dialog) throw new Error('Add Customer dialog did not open');
    await sleep(cfg.stepDelay);

    if (isDupDialog(dialog)) { await handleDupDialog(dialog, c.phone); return; }

    const nameEl  = dialog.querySelector('input[placeholder="Customer name"]') || dialog.querySelector('input');
    const phoneEl = dialog.querySelector('input[placeholder="0400 000 000"]') || dialog.querySelectorAll('input')[1];
    const emailEl = dialog.querySelector('input[type="email"], input[placeholder="customer@example.com"]');

    if (nameEl)             { setNativeValue(nameEl,  c.name);         await sleep(90); }
    if (phoneEl)            { setNativeValue(phoneEl, c.phone || 'X'); await sleep(90); }
    if (emailEl && c.email) { setNativeValue(emailEl, c.email);        await sleep(90); }
    await sleep(cfg.stepDelay);

    const createBtn = Array.from(dialog.querySelectorAll('button')).find(b=>/create customer/i.test(b.textContent));
    if (!createBtn) throw new Error('Create Customer button not found');
    if (createBtn.disabled) await sleep(300);
    createBtn.click();

    const which = await waitForEither(
      () => !document.querySelector('[role="dialog"]'),
      () => isDupDialog(document.querySelector('[role="dialog"]')),
      6000
    );
    if (which === 2) await handleDupDialog(document.querySelector('[role="dialog"]'), c.phone);
    await waitFor(() => !document.querySelector('[role="dialog"]'), 6000);
    await sleep(cfg.stepDelay);
  }

  function isDupDialog(d) {
    if (!d) return false;
    return d.textContent.includes('Possible duplicate') ||
      !!Array.from(d.querySelectorAll('button')).find(b => /create new anyway/i.test(b.textContent));
  }
  async function handleDupDialog(dialog, phone) {
    await sleep(200);
    const useButtons   = Array.from(dialog.querySelectorAll('button')).filter(b => /use this customer/i.test(b.textContent));
    const createAnyway = Array.from(dialog.querySelectorAll('button')).find(b  => /create new anyway/i.test(b.textContent));
    if (!phone || phone === 'X') {
      if (createAnyway && !createAnyway.disabled) createAnyway.click();
    } else if (useButtons.length === 1) {
      useButtons[0].click();
    } else if (useButtons.length > 1) {
      setStatus('⚠️ Multiple customers found — pick one in the dialog.');
      buildBtn.disabled = false;
      await waitFor(() => !document.querySelector('[role="dialog"]'), 120000, 500);
    } else if (createAnyway && !createAnyway.disabled) createAnyway.click();
    await sleep(cfg.stepDelay);
  }

  // ═════════════════════════════════════════════════════════════
  // Radix field helpers  (best-effort — see note in chat; these target
  // the standard shadcn/radix combobox + select patterns. If a popup's
  // markup differs, paste it and these three helpers get hardened.)
  // ═════════════════════════════════════════════════════════════

  // Device — input that allows "Search or type device name".
  async function setDeviceField(text) {
    const inp = document.querySelector('input[placeholder*="device name" i]') ||
                document.querySelector('input[placeholder*="Search or type device" i]');
    if (!inp) throw new Error('Device field not found');
    inp.focus();
    setNativeValue(inp, text);
    await sleep(450);
    const opt = pickOptionByText(text.split(/\s+/)[0]); // match on first token e.g. "iPhone"
    if (opt) { opt.click(); await sleep(160); return; }
    // "or type" — accept the typed value with Enter
    inp.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', code:'Enter', bubbles:true }));
    await sleep(160);
  }

  // Issues — combobox that opens a checklist. Click each parsed job that matches.
  async function setIssues(labels) {
    const btn = Array.from(document.querySelectorAll('button[role="combobox"]'))
      .find(b => /issue/i.test(b.textContent) || /select issues/i.test(b.textContent));
    if (!btn) throw new Error('Issues selector not found');
    btn.click();
    await waitFor(() => document.querySelector('[role="listbox"],[role="dialog"] [role="option"],[role="menu"]'), 2500);
    for (const lbl of labels) {
      const opt = pickOptionByText(lbl);
      if (opt) { opt.click(); await sleep(140); }
    }
    // close the popup
    document.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', code:'Escape', bubbles:true }));
    await sleep(180);
  }

  // Status — radix Select. Click trigger, click the matching option.
  async function setTicketStatus(statusText) {
    const trig = Array.from(document.querySelectorAll('button[role="combobox"]'))
      .find(b => { const sp = b.querySelector('span'); return sp && /repairing|status|complete|waiting|ready|new/i.test(sp.textContent) && !/issue/i.test(b.textContent); });
    if (!trig) { setStatus('⚠️ Status dropdown not found — left at default.'); return false; }
    trig.click();
    const list = await waitFor(() => document.querySelector('[role="listbox"]'), 2500);
    if (!list) { setStatus('⚠️ Status list did not open — left at default.'); return false; }
    const opt = Array.from(list.querySelectorAll('[role="option"]'))
      .find(o => o.textContent.trim().toLowerCase().includes(statusText.toLowerCase()));
    if (!opt) { document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); setStatus(`⚠️ Status "${statusText}" not in list — left at default.`); return false; }
    opt.click(); await sleep(160); return true;
  }

  // Find a visible popup option whose text contains `text`.
  function pickOptionByText(text) {
    const t = text.toLowerCase();
    const pools = document.querySelectorAll('[role="option"],[role="menuitemcheckbox"],[cmdk-item],[data-radix-collection-item] label,[role="dialog"] label');
    return Array.from(pools).find(o => o.offsetParent !== null && o.textContent.trim().toLowerCase().includes(t)) || null;
  }

  function findQuoteInput() {
    const lab = Array.from(document.querySelectorAll('label')).find(l => /quote amount/i.test(l.textContent));
    if (lab) { const inp = (lab.parentElement||document).querySelector('input[type="number"]'); if (inp) return inp; }
    return document.querySelector('input[type="number"][step="0.01"]');
  }

  // Build-time popup for rows whose col-L quote cell held the word "quote".
  // Resolves to a number, or null if the user skips.
  function askQuote(label) {
    return new Promise(resolve => {
      const ov = document.createElement('div');
      ov.style.cssText = 'position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;';
      ov.innerHTML = `
        <div style="background:#0f172a;border:1px solid #334155;border-radius:14px;padding:18px;width:300px;
          font-family:'Segoe UI',system-ui,sans-serif;color:#e2e8f0;box-shadow:0 20px 60px rgba(0,0,0,.7)">
          <div style="font-size:13px;font-weight:700;margin-bottom:3px">Quote amount</div>
          <div style="font-size:11px;color:#64748b;margin-bottom:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(label)}</div>
          <input type="number" step="0.01" min="0" id="sostk-q-modal" placeholder="0.00"
            style="width:100%;box-sizing:border-box;background:#1e293b;border:1px solid #6366f1;color:#e2e8f0;
            border-radius:8px;padding:8px 10px;font-size:14px;outline:none">
          <div style="display:flex;gap:6px;margin-top:12px">
            <button id="sostk-q-ok" style="flex:1;padding:8px;border:none;border-radius:8px;
              background:linear-gradient(135deg,#6366f1,#4f46e5);color:#fff;font-weight:600;cursor:pointer">Use this</button>
            <button id="sostk-q-skip" style="padding:8px 12px;border:none;border-radius:8px;
              background:#334155;color:#94a3b8;font-weight:600;cursor:pointer">Skip</button>
          </div>
        </div>`;
      document.body.appendChild(ov);
      const input = ov.querySelector('#sostk-q-modal');
      setTimeout(() => input.focus(), 30);
      const done = v => { ov.remove(); resolve(v); };
      const take = () => { const n = parseFloat(input.value); done(isNaN(n) ? null : n); };
      ov.querySelector('#sostk-q-ok').addEventListener('click', take);
      ov.querySelector('#sostk-q-skip').addEventListener('click', () => done(null));
      input.addEventListener('keydown', e => { if (e.key === 'Enter') take(); if (e.key === 'Escape') done(null); });
    });
  }

  // ═════════════════════════════════════════════════════════════
  // Notes dialog  (button title="Notes" → dialog → textarea → Add Note)
  // ═════════════════════════════════════════════════════════════
  async function addNote(ticketNo, text) {
    if (!text) return;
    const btn = findNotesButtonFor(ticketNo);
    if (!btn) throw new Error('Notes button not found' + (ticketNo?` for ${ticketNo}`:''));
    btn.click();
    const dlg = await waitFor(() => Array.from(document.querySelectorAll('[role="dialog"]'))
      .find(d => { const h = d.querySelector('h2'); return h && /notes/i.test(h.textContent); }), 4000);
    if (!dlg) throw new Error('Notes dialog did not open');
    await sleep(200);

    const ta = dlg.querySelector('textarea[placeholder*="note" i]') || dlg.querySelector('textarea');
    if (!ta) throw new Error('Note textarea not found');
    setNativeValue(ta, text);
    await sleep(160);

    const add = Array.from(dlg.querySelectorAll('button')).find(b => /add note/i.test(b.textContent));
    if (!add) throw new Error('Add Note button not found');
    let t=0; while (add.disabled && t<14) { await sleep(140); t++; }
    if (add.disabled) throw new Error('Add Note stayed disabled');
    add.click();
    await sleep(cfg.stepDelay + 200);

    // close the notes drawer
    const close = dlg.querySelector('button .lucide-x')?.closest('button') ||
                  Array.from(dlg.querySelectorAll('button')).find(b => /close/i.test(b.textContent));
    if (close) { close.click(); await sleep(180); }
  }

  // Find the Notes button belonging to a ticket. Best-effort: locate the
  // ticket number on the page, walk up to its row, grab the Notes button.
  // Falls back to any open Notes button (e.g. a just-opened ticket detail).
  function findNotesButtonFor(ticketNo) {
    if (ticketNo) {
      const cell = Array.from(document.querySelectorAll('td,span,div,a'))
        .find(el => !el.children.length && el.textContent.trim() === ticketNo);
      if (cell) {
        let row = cell.closest('tr') || cell.parentElement;
        for (let i=0; i<6 && row; i++) {
          const nb = row.querySelector && row.querySelector('button[title="Notes"]');
          if (nb) return nb;
          row = row.parentElement;
        }
      }
    }
    return document.querySelector('button[title="Notes"]');
  }

  // ── Open an existing ticket by number — NEEDS YOUR DOM ─────────
  //  I don't have the board's search box / row-open markup, so this is a
  //  stub. Paste the DOM for: (a) the ticket search input and (b) a board
  //  row / its open button, and this gets wired the same way as the rest.
  async function openTicketByNumber(ticketNo) {
    // Best-effort attempt: try a generic search input + click the result.
    const search = document.querySelector('input[placeholder*="search" i]');
    if (search) {
      setNativeValue(search, ticketNo);
      await sleep(cfg.stepDelay + 300);
      const hit = Array.from(document.querySelectorAll('td,span,a,div'))
        .find(el => !el.children.length && el.textContent.trim() === ticketNo);
      if (hit) {
        const clickable = hit.closest('a,button,[role="button"],tr') || hit;
        clickable.click();
        await sleep(cfg.stepDelay + 300);
        // crude confirmation: a Notes button is now reachable for this ticket
        if (findNotesButtonFor(ticketNo)) return true;
      }
    }
    return false; // caller surfaces a clear "need DOM" message
  }

  // ═════════════════════════════════════════════════════════════
  // Results
  // ═════════════════════════════════════════════════════════════
  function captureResult(i) {
    if (captured.has(i)) return;
    captured.add(i);
    const job = jobs[i];
    const name = job.customer ? job.customer.name : 'Walk-in';
    results.push({ ticket: job.ticket || latestTicket() || '', name, kind: job.kind, note: job.note || '', status: job.sosStatus || '' });
    renderResults();
  }
  function latestTicket() {
    const set = new Set();
    document.querySelectorAll('td,span,div,a,button').forEach(el => {
      if (el.children.length) return;
      const t = el.textContent.trim();
      if (/^[A-Z]\d{3,6}$/.test(t)) set.add(t);
    });
    const arr = Array.from(set).map(t => ({ t, n: parseInt(t.replace(/\D/g,''),10) }));
    if (!arr.length) return '';
    arr.sort((a,b) => b.n-a.n);
    return arr[0].t;
  }
  function renderResults() {
    const body=document.getElementById('sostk-results-body');
    const table=document.getElementById('sostk-results-table');
    const empty=document.getElementById('sostk-results-empty');
    const actions=document.getElementById('sostk-results-actions');
    if (!results.length) { table.style.display='none'; actions.style.display='none'; empty.style.display='block'; return; }
    empty.style.display='none'; table.style.display='table'; actions.style.display='flex';
    body.innerHTML = results.map((r,i) => `
      <tr><td><input data-i="${i}" value="${esc(r.ticket)}" placeholder="A####"></td>
      <td class="sostk-res-name">${esc(r.name)}</td>
      <td style="font-size:10px;color:#64748b">${esc(r.kind)}</td></tr>`).join('');
    body.querySelectorAll('input').forEach(inp => inp.addEventListener('input', () => { results[Number(inp.dataset.i)].ticket = inp.value; }));
  }
  document.getElementById('sostk-copy-btn').addEventListener('click', () => {
    const tsv = results.map(r=>r.ticket).join('\n');
    navigator.clipboard.writeText(tsv).then(
      () => { const b=document.getElementById('sostk-copy-btn'); const o=b.textContent; b.textContent='✓ Copied!'; setTimeout(()=>b.textContent=o,1500); },
      () => alert('Copy failed:\n\n'+tsv)
    );
  });
  document.getElementById('sostk-results-clear').addEventListener('click', () => { results=[]; captured.clear(); renderResults(); });
  document.getElementById('sostk-push-btn').addEventListener('click', () => pushToSheet(false));

  // Push captured ticket #s to the sheet. The Apps Script web app matches each
  // row by its description text (`key`) and writes the ticket into col C (+ status
  // into col D). text/plain content-type avoids a CORS preflight; GM_xmlhttpRequest
  // isn't bound by same-origin so the cross-site POST goes through.
  function pushToSheet(isAuto) {
    if (!cfg.webAppUrl) { setStatus('⚠️ Set the Apps Script Web App URL in Settings first.'); return; }
    const rows = results
      .filter(r => r.ticket && r.note)
      .map(r => ({ key: r.note, ticket: r.ticket, name: r.name, status: r.status }));
    if (!rows.length) { setStatus('Nothing to push — need a ticket # and the matching note.'); return; }
    const btn = document.getElementById('sostk-push-btn');
    if (btn) { btn.disabled = true; btn.textContent = '⬆ Pushing…'; }
    GM_xmlhttpRequest({
      method: 'POST',
      url: cfg.webAppUrl,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      data: JSON.stringify({ secret: cfg.sheetSecret || '', rows }),
      onload: res => {
        let msg = (isAuto ? '✓ Auto-pushed to sheet.' : '✓ Pushed to sheet.');
        try {
          const j = JSON.parse(res.responseText);
          if (typeof j.updated === 'number') msg = `✓ Sheet updated — ${j.updated}/${rows.length} row(s) matched.`;
          if (j.error) msg = '✕ Sheet error: ' + j.error;
        } catch {}
        setStatus(msg);
        if (btn) { btn.disabled = false; btn.textContent = '⬆ Push to Sheet'; }
      },
      onerror: () => {
        setStatus('✕ Push failed — check the Web App URL and that it is deployed for "Anyone".');
        if (btn) { btn.disabled = false; btn.textContent = '⬆ Push to Sheet'; }
      },
    });
  }

  function switchTab(name) {
    document.querySelectorAll('.sostk-tab').forEach(t=>t.classList.toggle('active',t.dataset.tab===name));
    document.querySelectorAll('.sostk-pane').forEach(p=>p.classList.toggle('active',p.id==='sostk-tab-'+name));
  }

  // ═════════════════════════════════════════════════════════════
  // DOM helpers  (shared with the Sales Loader where identical)
  // ═════════════════════════════════════════════════════════════
  function findTab(label) { return Array.from(document.querySelectorAll('[role="tab"]')).find(t=>t.textContent.trim().toLowerCase().includes(label.toLowerCase())); }
  function findWalkInButton() { return document.querySelector('button[title*="Walk-in" i]') || Array.from(document.querySelectorAll('button')).find(b=>/walk[\s-]?in/i.test(b.getAttribute('title')||b.textContent||'')); }
  function findAddCustomerButton() { return Array.from(document.querySelectorAll('button')).find(b=>b.querySelector('svg.lucide-user-plus')); }
  function lineInputs(ph) { return Array.from(document.querySelectorAll(`input[placeholder="${ph}"]`)); }

  function setNativeValue(el, value) {
    const proto  = el.tagName==='TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto,'value')?.set;
    if (setter) setter.call(el,value); else el.value=value;
    el.dispatchEvent(new Event('input',{bubbles:true}));
    el.dispatchEvent(new Event('change',{bubbles:true}));
  }
  function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }
  async function waitFor(fn, timeout=4000, step=100) { const t0=Date.now(); while(Date.now()-t0<timeout){ const r=fn(); if(r) return r; await sleep(step); } return null; }
  async function waitForEither(fn1, fn2, timeout=6000, step=100) {
    const t0=Date.now();
    while(Date.now()-t0<timeout){ if(fn1()) return 1; if(fn2()) return 2; await sleep(step); }
    return 0;
  }

  // ═════════════════════════════════════════════════════════════
  // Position FAB next to the app's bottom-left buttons (offset from
  // the Sales Loader FAB so both are reachable)
  // ═════════════════════════════════════════════════════════════
  function positionFab() {
    let best=null, bestRight=-1;
    document.querySelectorAll('button,a,div,[role="button"]').forEach(el=>{
      if (el.id&&(el.id.startsWith('sost')||el.id.startsWith('sosw'))) return;
      if (el===fab||el===panel) return;
      const r=el.getBoundingClientRect();
      if (r.width<32||r.width>60) return;
      if (Math.abs(r.width-r.height)>12) return;
      if (r.bottom<window.innerHeight-110||r.bottom>window.innerHeight-3) return;
      if (r.left<2||r.left>400) return;
      if (r.right>bestRight) { bestRight=r.right; best=r; }
    });
    // Sit one slot to the right of the Sales Loader FAB.
    if (best&&bestRight<=460) { fab.style.left=Math.round(bestRight+68)+'px'; fab.style.bottom=Math.round(window.innerHeight-best.bottom)+'px'; }
    else { fab.style.left='280px'; fab.style.bottom='20px'; }
  }

})();
