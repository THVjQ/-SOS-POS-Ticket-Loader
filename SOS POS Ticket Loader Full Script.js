// ==UserScript==
// @name         SOS POS Ticket Loader
// @namespace    http://tampermonkey.net/
// @version      2.8
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
  const SCRIPT_VERSION = '2.8';

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
      [/not\s*charging|won'?t\s*charge|wont\s*charge|no\s*charge|charging\s*(?:issue|problem|fault)/i, 'Charging Issues'],
      [/rear\s*housing/i,                                             'Rear Housing'],
      [/rear\s*glass|back\s*glass|b\/?g\b/i,                         'Rear Glass'],
      [/camera\s*glass|cam\s*glass|cam(?:era)?\s*lens|lens\s*protector/i, 'Camera Glass'],
      [/front\s*cam(?:era)?|selfie\s*cam(?:era)?/i,                  'Front Camera'],
      [/\bcamera\b|\bcam\b/i,                                         'Camera'],
      [/face\s*id|faceid/i,                                           'Face ID'],
      [/no\s*power|won'?t\s*(?:turn\s*on|power)|wont\s*(?:turn\s*on|power)|not\s*turning\s*on|no\s*boot/i, 'No Power'],
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
      [/diagnos\w*|\bdiag\b/i,                                        'Diagnose'],
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
  // STATUS MAP  (your sheet col-D value → route + SOS POS status)
  //  route: 'ticket' (repair) · 'sale' (product) · 'manual' (skip → Not completed)
  //  sos:   exact SOS POS status text (confirmed list, doc 7).
  //  Some sheet codes don't map perfectly to a SOS status — best-effort guesses
  //  are marked. Edit any in Settings → Status map.
  //  Existing ticket # in col C + a ticket route = Update (set status + note).
  // ═════════════════════════════════════════════════════════════
  const STATUS_MAP_DEFAULT = {
    // workflow / repair
    'REPAIRING':          { route: 'ticket', sos: 'Repairing' },
    'DIAGNOSTIC':         { route: 'ticket', sos: 'Diagnostic' },
    'DATA':               { route: 'ticket', sos: 'Repairing' },        // best-effort
    'WAITING ON CX':      { route: 'ticket', sos: 'Repairing' },        // not a live status → Repairing
    'WAITING ON PARTS':   { route: 'ticket', sos: 'Repairing' },        // → Repairing
    'WAITING ON CUSTOMER':{ route: 'ticket', sos: 'Repairing' },        // → Repairing
    'WARRANTY':           { route: 'ticket', sos: 'Warranty' },
    'PART ORDERED':       { route: 'ticket', sos: 'Part Ordered' },
    'PART NOT ORDERED':   { route: 'ticket', sos: 'Part Not Ordered' },
    'PART ARRIVED':       { route: 'ticket', sos: 'Part Arrived' },
    'ORDER':              { route: 'ticket', sos: 'Part Ordered' },     // alias
    'ORDERED':            { route: 'ticket', sos: 'Part Ordered' },     // alias
    'BAR':                { route: 'ticket', sos: 'Repairing' },        // best-effort
    'ENQUIRY':            { route: 'skip',   sos: '' },                 // skip with a toast
    'BOOKING':            { route: 'ticket', sos: 'Booking' },
    'DEPOSIT':            { route: 'ticket', sos: 'Deposit' },
    'QUOTE':              { route: 'ticket', sos: 'Quote' },
    'VIRUS':              { route: 'ticket', sos: 'Virus' },
    'MISSING':            { route: 'ticket', sos: 'Missing' },
    'CALL OUT':           { route: 'ticket', sos: 'CALL OUT' },
    'LAY-BY':             { route: 'ticket', sos: 'LayBy' },
    'LAYBY':              { route: 'ticket', sos: 'LayBy' },
    'POSTED':             { route: 'ticket', sos: 'Posted' },
    'DISPOSE':            { route: 'ticket', sos: 'Dispose' },
    'PICK UP READY':      { route: 'ticket', sos: 'Pick Up Ready' },
    // microsoldering / send-away
    'SENT TO ARMI':       { route: 'ticket', sos: 'Micro Sent' },
    'SYD/TO SEND':        { route: 'ticket', sos: 'Micro To Send' },
    'SYD/SENT':           { route: 'ticket', sos: 'Micro Sent' },
    'SYD/BACK':           { route: 'ticket', sos: 'Micro Back' },
    // no-fix
    'NO FIX - IN STORE':  { route: 'ticket', sos: 'No Fix - In Store' },
    'NO FIX - COLLECTED': { route: 'ticket', sos: 'No Fix - Collected' },
    // money / closed
    'PAID':               { route: 'ticket', sos: 'Paid' },
    'PART PAID':          { route: 'ticket', sos: 'Part Paid' },
    'PAID & COLLECTED':   { route: 'ticket', sos: 'Paid & Collected' },
    'COLLECTED':          { route: 'ticket', sos: 'Collected' },
    'BALANCED':           { route: 'ticket', sos: 'Paid' },             // best-effort
    'CANCELLED':          { route: 'ticket', sos: 'Cancelled' },
    'REFUND':             { route: 'ticket', sos: 'Refunded' },         // was skip — now applies Refunded
    'REFUNDED':           { route: 'ticket', sos: 'Refunded' },
    // sales
    'PURCHASED ITEM':     { route: 'sale',   sos: '' },
    // skipped (no SOS status equivalent)
    'NOTE':               { route: 'manual', sos: '' },
  };

  // ═════════════════════════════════════════════════════════════
  // ISSUE MAP  (parser job label → SOS POS "Issues" checklist name)
  //  Confirmed SOS list (20 options):
  //    Screen · Battery · Data Transfer · Back Glass · Charging Issues ·
  //    Charging Port · Data Recovery · Diagnose · Face ID · Frame ·
  //    Front Camera · Housing / Cosmetic · No Power · Other · Rear Camera ·
  //    Software / Update · Speaker · Virus Removal · Water Damage · Other - see notes.
  //  Matching is exact → contains → "Other - see notes" so the required field is
  //  never empty. Editable in Settings; values must match the SOS option text.
  // ═════════════════════════════════════════════════════════════
  const ISSUE_MAP_DEFAULT = {
    'Screen':              'Screen',
    'OLED':                'Screen',
    'LCD':                 'Screen',
    'Digitizer':           'Screen',
    'Battery':             'Battery',
    'Charging Port':       'Charging Port',
    'Charging Port Clean': 'Charging Port',
    'Charging Issues':     'Charging Issues',
    'Back Glass':          'Back Glass',
    'Rear Glass':          'Back Glass',
    'Rear Housing':        'Housing / Cosmetic',
    'Housing':             'Housing / Cosmetic',
    'Frame':               'Frame',
    'Camera':              'Rear Camera',
    'Rear Camera':         'Rear Camera',
    'Camera Glass':        'Rear Camera',
    'Front Camera':        'Front Camera',
    'Face ID':             'Face ID',
    'No Power':            'No Power',
    'Diagnose':            'Diagnose',
    'Data Transfer':       'Data Transfer',
    'Data Recovery':       'Data Recovery',
    'Virus Clean':         'Virus Removal',
    'Restore':             'Software / Update',
    'Software / Update':   'Software / Update',
    'Speaker':             'Speaker',
    'Water Damage':        'Water Damage',
    'Power Button':        'Other',
    'Sim Tray':            'Other',
    'Signal Flex':         'Other',
    'Microphone':          'Other',
  };

  // ═════════════════════════════════════════════════════════════
  // Settings
  // ═════════════════════════════════════════════════════════════
  const DEFAULTS = {
    stepDelay: 350,
    doaDefault: 'no',          // 'no' | 'yes'
    addNotes: true,            // drop the row note into the Notes dialog after create
    useNoteParser: true,
    salePay: 'auto',           // 'stage' | 'checkout' | 'auto'
    saleMethod: 'eftpos',      // full-amount method when no cash/eftpos split: 'eftpos'|'cash'|'transfer'
    writeback: 'off',          // 'off' | 'manual' | 'auto'
    webAppUrl: '',             // Apps Script web-app /exec URL
    sheetSecret: '',           // optional shared secret matching the Apps Script
    cols: { ...COL_DEFAULTS },
    statusMap: { ...STATUS_MAP_DEFAULT },
    issueMap: { ...ISSUE_MAP_DEFAULT },
  };
  function loadCfg() {
    try {
      const c = Object.assign({}, DEFAULTS, JSON.parse(GM_getValue('sostk_cfg','{}')));
      c.cols      = Object.assign({}, COL_DEFAULTS, c.cols || {});
      c.statusMap = Object.assign({}, STATUS_MAP_DEFAULT, c.statusMap || {});
      c.issueMap  = Object.assign({}, ISSUE_MAP_DEFAULT, c.issueMap || {});
      // one-time migration: apply latest routing for these even over an older saved map
      if ((c.mapRev || 0) < 2) {
        c.statusMap['WAITING ON CX']       = { route:'ticket', sos:'Repairing' };
        c.statusMap['WAITING ON PARTS']    = { route:'ticket', sos:'Repairing' };
        c.statusMap['WAITING ON CUSTOMER'] = { route:'ticket', sos:'Repairing' };
        c.statusMap['ENQUIRY']             = { route:'skip',   sos:'' };
        c.mapRev = 2;
        try { GM_setValue('sostk_cfg', JSON.stringify(c)); } catch {}
      }
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
    #sostk-err-badge {
      background: rgba(127,29,29,.55); border: none; color: #fecaca; font-size: 11px;
      font-weight: 700; border-radius: 20px; padding: 2px 9px; cursor: pointer;
      display: none; align-items: center; gap: 3px; white-space: nowrap;
    }
    #sostk-err-badge:hover { background: rgba(127,29,29,.85); }
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
    .sostk-job.skipped { opacity: .5; border-color: #475569; }
    .sostk-job.skipped .sostk-job-name { text-decoration: line-through; }
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
      <button id="sostk-err-badge" title="Build issues — click to view" style="display:none">⚠ <span id="sostk-err-count">0</span></button>
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
        <button class="sostk-btn sostk-btn-muted sostk-btn-sm" id="sostk-skip-btn" style="display:none">⏭ Skip</button>
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
      <p class="sostk-note" style="margin-top:8px">Rows stay in <b>paste order</b>. Ticket #s are <b>editable</b> — fix any before copying. <b>Copy</b> outputs ticket numbers only (one per line).</p>
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
      <div class="sostk-row2">
        <div class="sostk-field">
          <label class="sostk-label">Sale payment</label>
          <select class="sostk-select" id="sostk-sale-pay">
            <option value="stage">Stage line only — I take payment</option>
            <option value="checkout">Open Checkout — I hit Complete</option>
            <option value="auto">Auto — pay &amp; Complete Payment</option>
          </select>
        </div>
        <div class="sostk-field">
          <label class="sostk-label">Default sale method</label>
          <select class="sostk-select" id="sostk-sale-method">
            <option value="eftpos">EFTPOS</option>
            <option value="cash">Cash</option>
            <option value="transfer">Transfer</option>
          </select>
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
      <div class="sostk-field">
        <label class="sostk-label">Issue map — parser label → SOS issue name (JSON)</label>
        <textarea class="sostk-textarea" id="sostk-issuemap"></textarea>
      </div>

      <button class="sostk-btn sostk-btn-primary sostk-btn-sm" id="sostk-save-cfg">Save settings</button>
      <button class="sostk-btn sostk-btn-muted sostk-btn-sm" id="sostk-reset-cfg" style="margin-left:6px">Reset maps</button>
      <button class="sostk-btn sostk-btn-muted sostk-btn-sm" id="sostk-probe" style="margin-left:6px">🔍 Probe status</button>
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
  document.getElementById('sostk-err-badge').addEventListener('click', showErrorPopup);
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
  const $issuemap = document.getElementById('sostk-issuemap');
  const $writeback= document.getElementById('sostk-writeback');
  const $salePay  = document.getElementById('sostk-sale-pay');
  const $saleMethod = document.getElementById('sostk-sale-method');
  const $webapp   = document.getElementById('sostk-webapp');
  const $secret   = document.getElementById('sostk-secret');

  function fillSettings() {
    $addNotes.value = cfg.addNotes ? 'yes' : 'no';
    $doa.value      = cfg.doaDefault === 'yes' ? 'yes' : 'no';
    $noteP.value    = cfg.useNoteParser ? 'yes' : 'no';
    $delay.value    = cfg.stepDelay;
    $cols.value     = JSON.stringify(cfg.cols, null, 0);
    $statusmap.value= JSON.stringify(cfg.statusMap, null, 2);
    $issuemap.value = JSON.stringify(cfg.issueMap, null, 2);
    $writeback.value= cfg.writeback || 'off';
    $salePay.value  = cfg.salePay || 'auto';
    $saleMethod.value = cfg.saleMethod || 'eftpos';
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
    cfg.salePay       = $salePay.value;
    cfg.saleMethod    = $saleMethod.value;
    cfg.webAppUrl     = $webapp.value.trim();
    cfg.sheetSecret   = $secret.value.trim();
    try { cfg.cols      = Object.assign({}, COL_DEFAULTS, JSON.parse($cols.value)); }
    catch { setStatus('⚠️ Column map JSON invalid — not saved.'); return; }
    try { cfg.statusMap = JSON.parse($statusmap.value); }
    catch { setStatus('⚠️ Status map JSON invalid — not saved.'); return; }
    try { cfg.issueMap = JSON.parse($issuemap.value); }
    catch { setStatus('⚠️ Issue map JSON invalid — not saved.'); return; }
    saveCfg(cfg); setStatus('✓ Settings saved.');
    if (rawCache) doParse(rawCache);
  });
  document.getElementById('sostk-reset-cfg').addEventListener('click', () => {
    cfg.cols = { ...COL_DEFAULTS }; cfg.statusMap = { ...STATUS_MAP_DEFAULT }; cfg.issueMap = { ...ISSUE_MAP_DEFAULT };
    fillSettings(); setStatus('Maps reset to defaults — Save to keep.');
  });

  // Diagnostic: open the Status dropdown, read the real option names + the first
  // option's HTML, log them and copy to clipboard. Click this on the Ticket tab.
  document.getElementById('sostk-probe').addEventListener('click', async () => {
    const trig = findStatusTrigger();
    if (!trig) { setStatus('⚠️ Open the Ticket tab (so the Status box shows), then Probe.'); return; }
    openRadix(trig);
    const opts = await waitFor(() => {
      const o = Array.from(document.querySelectorAll('[role="option"],[role="menuitem"]')).filter(e => e.offsetParent !== null && e.textContent.trim());
      return o.length ? o : null;
    }, 2500);
    if (!opts) {
      const portal = document.querySelector('[data-radix-popper-content-wrapper]') ||
                     document.querySelector('[role="listbox"]');
      const html = portal ? portal.outerHTML.slice(0, 5000) : '(no dropdown portal found)';
      console.log('[Ticket Loader] Status dropdown HTML:\n' + html);
      try { await navigator.clipboard.writeText('STATUS DROPDOWN HTML:\n' + html); } catch {}
      setStatus('Options not role=option — DOM dumped to console + clipboard. Paste to Claude.');
      return;
    }
    const names = opts.map(o => o.textContent.trim());
    const report = 'STATUS OPTIONS (' + names.length + '): ' + names.join(' | ') +
                   '\n\nFIRST OPTION HTML:\n' + opts[0].outerHTML;
    console.log('[Ticket Loader] ' + report);
    try { await navigator.clipboard.writeText(report); setStatus('✓ ' + names.length + ' status options copied to clipboard — paste to Claude.'); }
    catch { setStatus('Options: ' + names.join(', ')); }
    document.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true }));
  });

  // ═════════════════════════════════════════════════════════════
  // State
  // ═════════════════════════════════════════════════════════════
  let jobs = [], builtIdx = -1, rawCache = '', results = [];
  let errors = [], currentLabel = '';   // error/warning log for the popup
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
      const cashAmt = num(cols[c.CASH]), eftAmt = num(cols[c.EFTPOS]);

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

      // Walk-in = no real customer name AND no existing ticket # → always a Sale,
      // never a repair ticket. The parser labels bare walk-in rows 'Walk-in', so we
      // must treat that literal (and its spelling variants) as "no name" here — the
      // old check only excluded "(no name)", which let walk-ins slip through as tickets.
      const hasName = !!(r.name && r.name.trim() && !/^\(?\s*(no name|walk[\s-]*in)\s*\)?$/i.test(r.name.trim()));
      if (!ticket && !hasName && route === 'ticket') route = 'sale';

      // Quote + needs-popup flag depend on route.
      let quote = 0, needsQuote = false;
      if (route === 'sale')        quote = payNum || qNum;
      else if (route === 'ticket') { quote = qNum; needsQuote = qIsWord; }

      // Existing ticket (col C) + ticket route = update, not create.
      let kind;
      if (route === 'sale')        kind = 'sale';
      else if (route === 'manual') kind = 'manual';
      else if (route === 'skip')   kind = 'skip';
      else                         kind = ticket ? 'update' : 'ticket';

      out.push({
        kind,                      // ticket | sale | update | note | manual
        route, ticket,
        statusCode: si.code, sosStatus: si.sos,
        customer: { name: r.name || (kind==='sale'?'Walk-in':'(no name)'), phone: r.phone || 'X', email: r.email || '' },
        device: r.device || '',
        jobs:   (r.jobs && r.jobs.length) ? r.jobs : [],
        item:   r.item || desc,
        quote, needsQuote, cashAmt, eftAmt,
        note:   desc,             // full original line goes into the Notes dialog
        status: 'pending',
      });
    }

    jobs = out; builtIdx = -1; captured.clear(); errors = []; updateErrorBadge();
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
      document.getElementById('sostk-skip-btn').style.display = 'block';
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
    skip:   { badge:'manual', label:'Skip on build (enquiries) — toast then next' },
    manual: { badge:'manual', label:'Not completed — skipped (refunds / notes / unparsed)' },
  };
  function renderPreview() {
    const order = ['ticket','update','sale','note','skip','manual'];
    const html = [];
    for (const kind of order) {
      const group = jobs.map((j,gi)=>({j,gi})).filter(x=>x.j.kind===kind);
      if (!group.length) continue;
      html.push(`<div class="sostk-section-h">${KIND_META[kind].label} (${group.length})</div>`);
      for (const { j, gi } of group) {
        const badgeText = kind === 'manual' ? 'NOT DONE' : kind === 'skip' ? 'SKIP' : kind.toUpperCase();
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
          ? `<input class="sostk-q-edit" data-gi="${gi}" type="number" step="0.01" min="0" placeholder="Cell says “quote” — enter $ here (or leave blank to skip)" value="${j.quote||''}">`
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
    jobs=[]; builtIdx=-1; rawCache=''; captured.clear(); errors=[]; updateErrorBadge();
    pasteArea.value='';
    document.getElementById('sostk-preview').innerHTML='';
    document.getElementById('sostk-build-btn').style.display='none';
    document.getElementById('sostk-clear-btn').style.display='none';
    document.getElementById('sostk-skip-btn').style.display='none';
    document.getElementById('sostk-prog-bar').style.width='0%';
    dropZone.classList.remove('has-data');
    document.getElementById('sostk-paste-summary').style.display='none';
    setStatus('');
  }

  function setStatus(m) { document.getElementById('sostk-status').textContent = m; }
  function setJobStatus(i,s) { jobs[i].status=s; const el=document.getElementById(`sostk-job-${i}`); if(el) el.classList.toggle('active', s==='active'); if(el && s==='done') el.classList.add('done'); if(el && s==='skipped') el.classList.add('skipped'); }
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
  document.getElementById('sostk-skip-btn').addEventListener('click', onSkipClick);

  // Skip the next job that Start/Next would build, mark it, advance.
  function onSkipClick() {
    let i = nextBuildable(builtIdx + 1);
    if (i >= jobs.length) { finishAll(); return; }
    setJobStatus(i, 'skipped');
    logIssue(`Skipped "${labelOf(jobs[i])}" manually.`, 'warn');
    builtIdx = i; setProgress();
    const n = nextBuildable(i + 1);
    if (n < jobs.length) {
      const total = jobs.filter(j => j.kind !== 'manual').length;
      const num = jobs.filter((j,k) => k <= i && j.kind !== 'manual').length + 1;
      buildBtn.disabled = false;
      buildBtn.textContent = `▶ Next (${num}/${total})`;
      setStatus(`⏭ Skipped "${labelOf(jobs[i])}".`);
    } else finishAll();
  }
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
      if (e && e.skip) {
        // soft skip — advance like the Skip button, no retry/freeze
        setJobStatus(i, 'skipped'); jobs[i].status = 'skipped';
        logIssue(e.message, 'warn');
        builtIdx = i; setProgress();
        const n = nextBuildable(i + 1);
        if (n < jobs.length) {
          const total = jobs.filter(j => j.kind !== 'manual').length;
          const num = jobs.filter((j,k) => k <= i && j.kind !== 'manual').length + 1;
          buildBtn.disabled = false;
          buildBtn.textContent = `▶ Next (${num}/${total})`;
          setStatus('⏭ ' + e.message);
        } else finishAll();
        return;
      }
      setJobStatus(i, 'pending'); jobs[i].status='pending';
      buildBtn.disabled = false;
      buildBtn.textContent = `▶ Retry ${labelOf(jobs[i])}`;
      logIssue(e.message, 'error');
      setStatus('✕ ' + e.message + '  ·  ⚠ click the badge for all errors'); console.error('[SOS Ticket Loader]', e);
    }
  }

  function finishAll() {
    const manual = jobs.filter(j=>j.kind==='manual').length;
    buildBtn.textContent = '✓ All done';
    buildBtn.disabled = true;
    document.getElementById('sostk-skip-btn').style.display = 'none';
    setStatus(`🎉 Finished — ${results.length} captured${manual?`, ${manual} manual row${manual>1?'s':''} left for you`:''}${errors.length?` · ⚠ ${errors.length} issue${errors.length>1?'s':''}`:''}.`);
    if (cfg.writeback === 'auto' && cfg.webAppUrl && results.length) pushToSheet(true);
    if (errors.length) showErrorPopup(); else switchTab('results');
  }

  // ═════════════════════════════════════════════════════════════
  // Build dispatch
  // ═════════════════════════════════════════════════════════════
  async function buildJob(job) {
    currentLabel = labelOf(job);
    if (job.kind === 'ticket')      await buildTicket(job);
    else if (job.kind === 'update') await updateTicket(job);
    else if (job.kind === 'sale')   await buildSale(job);
    else if (job.kind === 'note')   await noteOnlyJob(job);
    else if (job.kind === 'skip')   { showSkipBox(`${labelOf(job)} — enquiry, skipped.`); throw skipError(`${labelOf(job)} — enquiry, skipped.`); }
  }

  // ── Error / warning log (feeds the errors popup) ──────────────
  function logIssue(reason, type) {
    errors.push({ label: currentLabel || '(row)', reason: String(reason), type: type || 'error', when: new Date() });
    updateErrorBadge();
  }
  function updateErrorBadge() {
    const b = document.getElementById('sostk-err-badge');
    const c = document.getElementById('sostk-err-count');
    if (!b || !c) return;
    if (errors.length) { b.style.display = 'inline-flex'; c.textContent = errors.length; }
    else b.style.display = 'none';
  }
  function showErrorPopup() {
    const old = document.getElementById('sostk-err-overlay'); if (old) old.remove();
    const ov = document.createElement('div');
    ov.id = 'sostk-err-overlay';
    ov.style.cssText = 'position:fixed;inset:0;z-index:100002;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;';
    const btn = 'border:none;border-radius:7px;padding:5px 10px;font-weight:600;font-size:12px;cursor:pointer;';
    const rows = errors.length ? errors.map(e => `
      <div style="border:1px solid ${e.type==='warn'?'#78350f':'#7f1d1d'};background:${e.type==='warn'?'#1a1200':'#1f0d0d'};border-radius:8px;padding:8px 10px;margin-bottom:6px">
        <div style="font-size:12px;font-weight:700;color:#e2e8f0">${e.type==='warn'?'⚠':'✕'} ${esc(e.label)}</div>
        <div style="font-size:11.5px;color:#fca5a5;margin-top:2px">${esc(e.reason)}</div>
      </div>`).join('') : '<div style="color:#64748b;font-size:12px">No errors logged. 🎉</div>';
    ov.innerHTML = `
      <div style="background:#0f172a;border:1px solid #334155;border-radius:14px;padding:16px;width:min(460px,92vw);max-height:80vh;display:flex;flex-direction:column;font-family:'Segoe UI',system-ui,sans-serif;color:#e2e8f0;box-shadow:0 20px 60px rgba(0,0,0,.7)">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:10px">
          <span style="font-size:14px;font-weight:700;flex:1">Build issues (${errors.length})</span>
          <button id="sostk-err-copy"  style="${btn}background:#334155;color:#cbd5e1">Copy</button>
          <button id="sostk-err-clear" style="${btn}background:#334155;color:#94a3b8">Clear</button>
          <button id="sostk-err-close" style="${btn}background:#4f46e5;color:#fff">Close</button>
        </div>
        <div style="overflow-y:auto;padding-right:2px">${rows}</div>
      </div>`;
    document.body.appendChild(ov);
    ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
    ov.querySelector('#sostk-err-close').onclick = () => ov.remove();
    ov.querySelector('#sostk-err-clear').onclick = () => { errors = []; updateErrorBadge(); ov.remove(); };
    ov.querySelector('#sostk-err-copy').onclick = () => {
      const t = errors.map(e => `${e.type==='warn'?'WARN':'FAIL'} | ${e.label} | ${e.reason}`).join('\n');
      navigator.clipboard.writeText(t).then(() => { const b = ov.querySelector('#sostk-err-copy'); b.textContent = 'Copied!'; setTimeout(() => b.textContent = 'Copy', 1200); }, () => {});
    };
  }

  // ── Create a new repair ticket ────────────────────────────────
  async function buildTicket(job) {
    await clickTab('Ticket');
    await resetTicketForm();   // clean slate after any prior failed/skipped row

    await createCustomer(job.customer);

    // Device is required. If the parser found none, ask — showing the row note so
    // you can read it and type the device, then continue (or skip the row).
    let device = job.device;
    if (!device) {
      const entered = await askDevice(labelOf(job), job.note);
      if (entered == null || !entered.trim()) {
        showSkipBox(`No device for ${labelOf(job)} — row skipped.`);
        throw skipError('No device entered — row skipped.');
      }
      device = entered.trim();
      job.device = device;   // remember it (e.g. for retry)
    }
    await setDeviceField(device);
    await setIssues(job.jobs);   // always — falls back to "Other - see notes" if none matched

    if (cfg.doaDefault) { const r = document.getElementById('doa-'+cfg.doaDefault); if (r && r.getAttribute('aria-checked')!=='true') { r.click(); await sleep(120); } }

    if (job.sosStatus) await setTicketStatus(job.sosStatus);

    // Quote is optional. Use whatever's set (parsed number or the inline preview
    // field). If the cell said "quote" and it's still blank, just skip it and log a
    // warning — never block the build or fail the ticket over a missing quote.
    if (job.quote > 0) {
      const q = findQuoteInput();
      if (q) { setNativeValue(q, String(job.quote)); await sleep(120); }
    } else if (job.needsQuote) {
      logIssue('Quote left blank (cell said "quote") — ticket created without a quote.', 'warn');
    }

    const createBtn = Array.from(document.querySelectorAll('button')).find(b => /create ticket/i.test(b.textContent.trim()));
    if (!createBtn) throw new Error('Create Ticket button not found');
    let t=0; while (createBtn.disabled && t<14) { await sleep(150); t++; }
    if (createBtn.disabled) throw new Error('Create Ticket stayed disabled — a required field (device/issues) likely did not stick. Form left open.');
    createBtn.click();
    await sleep(cfg.stepDelay + 400);
    job.ticket = latestTicket() || job.ticket;

    // Repaired & collected/paid → take the payment for the respective amount on the
    // ticket's new board row, then re-assert the status so it sticks.
    if (isPaidStatus(job.sosStatus) && payAmount(job) > 0) {
      await sleep(cfg.stepDelay + 200);
      let row = job.ticket ? findTicketRow(job.ticket) : null;
      if (row) {
        await payOnRow(row, job);
        row = findTicketRow(job.ticket) || row;
        if (row) await setRowStatus(row, job.sosStatus);
      } else {
        logIssue(`Couldn't find the new row for ${job.ticket||'this ticket'} to take the $${payAmount(job).toFixed(2)} payment — take it manually.`, 'warn');
      }
    }

    if (cfg.addNotes && job.note) {
      const row = job.ticket ? findTicketRow(job.ticket) : null;
      try { if (row) await addNoteOnRow(row, job.note); else await addNote(job.ticket, job.note); }
      catch (e) { logIssue('Ticket created but note not added: ' + e.message, 'warn'); setStatus('⚠️ Ticket made, note skipped: ' + e.message); }
    }
  }

  // Make an error that means "skip this row" (auto-advance, no retry/freeze).
  function skipError(msg) { const e = new Error(msg); e.skip = true; return e; }

  // Statuses that mean the repair is collected/paid → take payment for the amount.
  const PAID_STATUSES = ['paid', 'collected', 'paid & collected', 'part paid'];
  function isPaidStatus(s) { return !!s && PAID_STATUSES.includes(String(s).trim().toLowerCase()); }
  function payAmount(job) { return round2((job.cashAmt||0)+(job.eftAmt||0)) || round2(job.quote||0); }

  // Brief non-blocking toast (auto-dismisses).
  function showSkipBox(msg) {
    const t = document.createElement('div');
    t.style.cssText = 'position:fixed;bottom:90px;left:50%;transform:translateX(-50%);z-index:100003;' +
      'background:#1a1200;border:1px solid #78350f;color:#fdba74;padding:10px 16px;border-radius:10px;' +
      'font-family:system-ui,sans-serif;font-size:13px;box-shadow:0 8px 30px rgba(0,0,0,.5);max-width:380px;text-align:center;';
    t.textContent = '⏭ ' + msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3500);
  }

  // Device-needed popup: shows the row's note so you can read what the device is,
  // takes a typed device, and resolves to it (or null to skip the row).
  function askDevice(label, note) {
    return new Promise(resolve => {
      const ov = document.createElement('div');
      ov.style.cssText = 'position:fixed;inset:0;z-index:100004;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;';
      ov.innerHTML = `
        <div style="background:#0f172a;border:1px solid #334155;border-radius:14px;padding:18px;width:min(420px,92vw);
          font-family:'Segoe UI',system-ui,sans-serif;color:#e2e8f0;box-shadow:0 20px 60px rgba(0,0,0,.7)">
          <div style="font-size:14px;font-weight:700;margin-bottom:3px">Device needed</div>
          <div style="font-size:11px;color:#64748b;margin-bottom:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(label)}</div>
          <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Row note</div>
          <div style="background:#1e293b;border:1px solid #334155;border-radius:8px;padding:8px 10px;font-size:12px;color:#cbd5e1;max-height:120px;overflow-y:auto;white-space:pre-wrap;margin-bottom:12px">${esc(note || '(no note)')}</div>
          <input id="sostk-dev-modal" placeholder="Type the device, e.g. iPhone 13"
            style="width:100%;box-sizing:border-box;background:#1e293b;border:1px solid #6366f1;color:#e2e8f0;
            border-radius:8px;padding:9px 10px;font-size:14px;outline:none">
          <div style="display:flex;gap:6px;margin-top:12px">
            <button id="sostk-dev-ok" style="flex:1;padding:9px;border:none;border-radius:8px;
              background:linear-gradient(135deg,#6366f1,#4f46e5);color:#fff;font-weight:600;cursor:pointer">Use &amp; continue</button>
            <button id="sostk-dev-skip" style="padding:9px 12px;border:none;border-radius:8px;
              background:#334155;color:#94a3b8;font-weight:600;cursor:pointer">Skip row</button>
          </div>
        </div>`;
      document.body.appendChild(ov);
      const input = ov.querySelector('#sostk-dev-modal');
      setTimeout(() => input.focus(), 30);
      const done = v => { ov.remove(); resolve(v); };
      const take = () => done(input.value.trim() || null);
      ov.querySelector('#sostk-dev-ok').addEventListener('click', take);
      ov.querySelector('#sostk-dev-skip').addEventListener('click', () => done(null));
      input.addEventListener('keydown', e => { if (e.key === 'Enter') take(); if (e.key === 'Escape') done(null); });
    });
  }

  // ── Update an existing ticket (status + note) ─────────────────
  //  Needs the board/search DOM to open a ticket. Until that's wired, if it can't
  //  find the ticket it auto-skips (toast + advance) instead of freezing.
  async function updateTicket(job) {
    let row = findTicketRow(job.ticket);
    if (!row) {
      showSkipBox(`Ticket ${job.ticket} isn't on the board — skipped (only board-visible tickets can be updated).`);
      throw skipError(`Ticket ${job.ticket} not on board — auto-skipped.`);
    }
    row.scrollIntoView({ block:'center' }); await sleep(150);

    // Collected/paid → take payment first (it may change status), then assert status.
    if (isPaidStatus(job.sosStatus) && payAmount(job) > 0) {
      await payOnRow(row, job);
      row = findTicketRow(job.ticket) || row;
    }
    if (job.sosStatus)            await setRowStatus(row, job.sosStatus);
    row = findTicketRow(job.ticket) || row;
    if (cfg.addNotes && job.note) await addNoteOnRow(row, job.note);
  }

  // ── Add a note to an existing ticket only ─────────────────────
  async function noteOnlyJob(job) {
    if (!job.ticket) { showSkipBox('Note row has no ticket # — skipped.'); throw skipError('Note row has no ticket # — auto-skipped.'); }
    if (!job.note) return;
    await addNote(job.ticket, job.note);
  }

  // ── Build a quick product sale (walk-in) — reuses Sale tab ────
  async function buildSale(job) {
    await clickTab('Sale');
    // The Sale panel only mounts its content once the tab is active, so wait for the
    // Walk-in button to appear rather than querying immediately. Its presence also
    // confirms the tab actually switched (it lives only on the Sale tab).
    const w = await waitFor(() => findWalkInButton(), 3000);
    if (!w) throw new Error('Walk-in button not found — Sale tab did not switch/mount');
    w.click(); await sleep(cfg.stepDelay + 150);

    const descs  = lineInputs('Item description'), prices = lineInputs('0.00');
    if (descs[0])  { setNativeValue(descs[0], job.item || '(item)'); await sleep(90); }
    if (prices[0]) { setNativeValue(prices[0], String(job.quote || 0)); await sleep(cfg.stepDelay); }

    if (cfg.salePay === 'stage') {
      setStatus(`🏷️ Sale staged for ${labelOf(job)} — take payment in SOS POS.`);
      return;
    }

    const checkoutBtn = findSaleCheckoutButton();
    if (!checkoutBtn) throw new Error('Checkout button not found');
    if (checkoutBtn.disabled) throw new Error('Checkout button is disabled (no item/price?)');
    checkoutBtn.click();

    const dialog = await waitFor(() => findSaleCheckoutDialog(), 5000);
    if (!dialog) throw new Error('Checkout dialog did not open');
    await sleep(cfg.stepDelay);

    if (cfg.salePay === 'checkout') {
      setStatus(`🧾 Checkout open for ${labelOf(job)} — complete payment manually.`);
      return;
    }
    await payForSale(job, dialog);
  }

  // ── Sale payment (Checkout dialog) ────────────────────────────
  function round2(x) { return Math.round(x*100)/100; }

  async function payForSale(job, dialog) {
    const total = round2(job.quote || ((job.cashAmt||0) + (job.eftAmt||0)));
    if (total <= 0) { // nothing to pay — try to complete as-is
      const c0 = findCompletePaymentBtn(dialog);
      if (c0 && !c0.disabled) { c0.click(); await waitFor(() => !findSaleCheckoutDialog(), 6000); }
      return;
    }

    // Work out the split: prefer the sheet's cash/eftpos columns, else full amount
    // on the default method. Reconcile any rounding onto the default method.
    let cash = round2(job.cashAmt || 0), eft = round2(job.eftAmt || 0), transfer = 0;
    const sum = round2(cash + eft);
    const m = cfg.saleMethod || 'eftpos';
    if (sum <= 0) {
      if (m === 'cash') cash = total; else if (m === 'transfer') transfer = total; else eft = total;
    } else if (Math.abs(sum - total) > 0.005) {
      const diff = round2(total - sum);
      if (m === 'cash') cash = round2(cash + diff); else if (m === 'transfer') transfer = round2(transfer + diff); else eft = round2(eft + diff);
    }

    const cashIn = splitInput(dialog, 'Cash');
    const eftIn  = splitInput(dialog, 'EFTPOS');
    const trIn   = splitInput(dialog, 'Transfer');
    // clear any pre-filled amounts first so the total matches exactly
    [cashIn, eftIn, trIn].forEach(i => { if (i) setNativeValue(i, ''); });
    await sleep(100);
    if (cash > 0     && cashIn) { setNativeValue(cashIn, cash.toFixed(2)); await sleep(120); }
    if (eft > 0      && eftIn)  { setNativeValue(eftIn,  eft.toFixed(2));  await sleep(120); }
    if (transfer > 0 && trIn)   { setNativeValue(trIn,   transfer.toFixed(2)); await sleep(120); }
    await sleep(cfg.stepDelay);

    const complete = findCompletePaymentBtn(dialog);
    if (!complete) throw new Error('Complete Payment button not found');
    let t = 0; while (complete.disabled && t < 14) { await sleep(140); t++; }
    if (complete.disabled) throw new Error('Complete Payment stayed disabled — amounts may not total. Left open.');
    complete.click();
    await waitFor(() => !findSaleCheckoutDialog(), 6000);
    await sleep(cfg.stepDelay + 300);
  }

  function findSaleCheckoutButton() {
    return Array.from(document.querySelectorAll('button')).find(b =>
      !b.closest('[role="dialog"]') && /checkout/i.test(b.textContent.trim()) && !/move to board/i.test(b.textContent));
  }
  function findSaleCheckoutDialog() {
    return Array.from(document.querySelectorAll('[role="dialog"]')).find(d => {
      const h = d.querySelector('h2'); return h && /checkout/i.test(h.textContent);
    });
  }
  // The split inputs sit in <div><label>Cash|EFTPOS|Transfer</label><input type=number></div>.
  function splitInput(dialog, labelText) {
    const lab = Array.from(dialog.querySelectorAll('label')).find(l => l.textContent.trim() === labelText);
    if (!lab) return null;
    return (lab.parentElement || dialog).querySelector('input[type="number"]');
  }
  function findCompletePaymentBtn(dialog) {
    return Array.from(dialog.querySelectorAll('button')).find(b => /complete payment/i.test(b.textContent));
  }

  // Take payment on a board row: click its Checkout button, then reuse the sale
  // checkout dialog logic with the row's amounts. Non-fatal — warns on failure.
  async function payOnRow(row, job) {
    const co = row.querySelector('button[title="Checkout"]');
    if (!co) { logIssue('Checkout button not found on row — take payment manually.', 'warn'); return false; }
    co.click();
    const dialog = await waitFor(() => findSaleCheckoutDialog(), 5000);
    if (!dialog) { logIssue('Checkout dialog did not open — take payment manually.', 'warn'); return false; }
    await sleep(cfg.stepDelay);
    try { await payForSale(job, dialog); return true; }
    catch (e) {
      logIssue('Payment not completed (' + e.message + ') — left for you.', 'warn');
      document.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true })); await sleep(150);
      return false;
    }
  }

  // ═════════════════════════════════════════════════════════════
  // Create customer  (reused verbatim from the Sales Loader)
  // ═════════════════════════════════════════════════════════════
  async function createCustomer(c) {
    await removeCustomerIfPresent();   // a leftover customer disables the + button
    const addBtn = findAddCustomerButton();
    if (!addBtn) throw new Error('Add-customer (+) button not found');
    if (addBtn.disabled) { await removeCustomerIfPresent(); await sleep(150); }
    await sleep(120);
    addBtn.click();

    let dialog = await waitFor(() => document.querySelector('[role="dialog"]'), 4000);
    if (!dialog) { addBtn.click(); dialog = await waitFor(() => document.querySelector('[role="dialog"]'), 4000); }
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

  // Close any stray popovers/menus/dialogs from a prior row, then REMOVE a leftover
  // customer (a selected customer disables the + button → "Add Customer dialog did not
  // open", and locks the form). Removing the customer resets the whole ticket form.
  async function resetTicketForm() {
    for (let k = 0; k < 2; k++) { document.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true })); await sleep(60); }
    await removeCustomerIfPresent();
    const dev = document.querySelector('input[placeholder*="device name" i]') ||
                document.querySelector('input[placeholder*="Search or type device" i]');
    if (dev && dev.value) setNativeValue(dev, '');
    await sleep(120);
  }

  // The green "customer selected" banner carries an X button; clicking it clears the
  // customer and re-enables the + button. Falls back to the × overlay on the input.
  function findCustomerRemoveBtn() {
    const banner = Array.from(document.querySelectorAll('div')).find(d => {
      const cn = typeof d.className === 'string' ? d.className : '';
      return (cn.includes('bg-green-50') || cn.includes('bg-green-900')) &&
             d.querySelector('svg.lucide-check') && d.querySelector('button svg.lucide-x');
    });
    if (banner) { const b = banner.querySelector('button'); if (b && !b.disabled) return b; }
    const clr = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '×' && !b.disabled);
    return clr || null;
  }
  async function removeCustomerIfPresent() {
    const rm = findCustomerRemoveBtn();
    if (rm) { rm.click(); await sleep(cfg.stepDelay); return true; }
    return false;
  }

  // Device — a cmdk command palette. Clear it, type, click an EXACT catalogue match
  // if there is one, else commit as a manual entry (Enter is the documented gesture;
  // the blue banner / empty-state button are fallbacks). Never hard-fails the ticket
  // over the device — logs a warning and lets the Create-disabled check decide.
  async function setDeviceField(text) {
    const inp = document.querySelector('input[placeholder*="device name" i]') ||
                document.querySelector('input[placeholder*="Search or type device" i]');
    if (!inp) throw new Error('Device field not found');

    if (inp.value) { setNativeValue(inp, ''); await sleep(80); }   // clear leftover text

    const trigger = inp.closest('[aria-haspopup="dialog"]') || inp;
    trigger.click();
    let cmdk = await waitFor(() => document.querySelector('input[cmdk-input]'), 1300);
    if (!cmdk) { inp.focus(); inp.click(); cmdk = await waitFor(() => document.querySelector('input[cmdk-input]'), 1300); }
    cmdk = cmdk || inp;

    cmdk.focus();
    setNativeValue(cmdk, text);
    await sleep(550);

    const want = text.replace(/\s+/g,' ').trim().toLowerCase();
    const exact = Array.from(document.querySelectorAll('[cmdk-item]'))
      .filter(el => el.offsetParent !== null)
      .find(el => el.textContent.replace(/\s+/g,' ').trim().toLowerCase() === want);
    if (exact) { exact.click(); await sleep(180); }
    else { await commitManualDevice(cmdk, text); }

    // Ensure the palette closed; one more attempt, then Escape + warn (don't throw —
    // a stuck palette shouldn't abort the whole row; Create-disabled will catch a
    // genuinely empty device).
    if (document.querySelector('input[cmdk-input]')) {
      await commitManualDevice(cmdk, text);
      if (document.querySelector('input[cmdk-input]')) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true }));
        await sleep(120);
        logIssue(`Device "${text}" may not have committed (palette stayed open).`, 'warn');
      }
    }
  }

  // Commit the typed device as a manual entry: Enter first (works for both an active
  // match and the "no match → save as manual" case), then the banner / empty button.
  async function commitManualDevice(cmdk, text) {
    cmdk.focus();
    ['keydown','keypress','keyup'].forEach(t =>
      cmdk.dispatchEvent(new KeyboardEvent(t, { key:'Enter', code:'Enter', keyCode:13, which:13, bubbles:true })));
    await sleep(220);
    if (!document.querySelector('input[cmdk-input]')) return;
    const banner = Array.from(document.querySelectorAll('[cmdk-list] div, [cmdk-list] button, [role="dialog"] div, [role="dialog"] button'))
      .find(el => /save as manual entry|add .*as manual entry|as manual entry/i.test(el.textContent) && el.offsetParent !== null);
    if (banner) { banner.click(); await sleep(220); }
  }

  // Issues — combobox opening a popover of role="checkbox" rows. Each row's
  // name is the leading text node of its .font-medium div (a "Common" badge may
  // follow). We map parser labels → SOS issue names, tick the matches, and fall
  // back to "Other - see notes" so the required field is never left empty.
  async function setIssues(labels) {
    const btn = Array.from(document.querySelectorAll('button[role="combobox"]'))
      .find(b => /select issues|issues?\b/i.test(b.textContent) && !/repairing|status/i.test(b.textContent));
    if (!btn) throw new Error('Issues selector not found');
    if (btn.getAttribute('aria-expanded') !== 'true') btn.click();

    const pop = await waitFor(() => findIssuesPopup(), 3000);
    if (!pop) throw new Error('Issues popup did not open');
    await sleep(160);

    const rows = issueRows(pop);
    if (!rows.length) throw new Error('No issue checkboxes found in popup');

    let any = false;
    for (const lbl of (labels || [])) {
      const target = matchIssue(lbl, rows);
      if (target) { await toggleIssueOn(target); any = true; }
    }
    if (!any) {
      const other = rows.find(r => /^other\s*-\s*see notes$/i.test(r.name)) || rows.find(r => /^other$/i.test(r.name));
      if (other) { await toggleIssueOn(other); }
    }

    // close the popover
    btn.click();
    await sleep(120);
    if (findIssuesPopup()) { document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true})); await sleep(120); }
  }

  // The issues popover is a radix popover (role="dialog") full of checkbox rows.
  function findIssuesPopup() {
    return Array.from(document.querySelectorAll('[role="dialog"],[data-radix-popper-content-wrapper] [role="dialog"],[data-side]'))
      .find(d => d.querySelector && d.querySelector('button[role="checkbox"]') &&
                 /screen|battery|water damage|charging/i.test(d.textContent)) || null;
  }

  // Build [{ name, rowEl, checkbox }] from the popover, names cleaned of badges.
  function issueRows(pop) {
    return Array.from(pop.querySelectorAll('button[role="checkbox"]')).map(cb => {
      const rowEl = cb.closest('div.flex.items-center') || cb.parentElement;
      const nameEl = rowEl && rowEl.querySelector('.font-medium');
      let name = '';
      if (nameEl) {
        const tn = Array.from(nameEl.childNodes).find(n => n.nodeType === 3 && n.textContent.trim());
        name = tn ? tn.textContent.trim() : nameEl.textContent.replace(/\bcommon\b/ig,'').trim();
      }
      return { name, rowEl, checkbox: cb };
    }).filter(r => r.name);
  }

  // parser label → SOS issue row, via the editable issue map then fuzzy fallback.
  function matchIssue(jobLabel, rows) {
    const want = (cfg.issueMap[jobLabel] || jobLabel).toLowerCase().trim();
    let r = rows.find(x => x.name.toLowerCase() === want);
    if (r) return r;
    r = rows.find(x => x.name.toLowerCase().includes(want) || want.includes(x.name.toLowerCase()));
    return r || null;
  }

  // Tick a checkbox row if it isn't already checked (tries row then checkbox).
  async function toggleIssueOn(target) {
    if (!target || !target.checkbox) return;
    if (target.checkbox.getAttribute('aria-checked') === 'true') return;
    (target.rowEl || target.checkbox).click();
    await sleep(140);
    if (target.checkbox.getAttribute('aria-checked') !== 'true') { target.checkbox.click(); await sleep(140); }
  }

  // Status — a radix dropdown MENU (role="menuitem" items, opens on pointerdown),
  // not a Select. Open it, read the real items, pick the match. On a miss it leaves
  // the default and reports the real option names (status bar + console).
  async function setTicketStatus(statusText) {
    if (!statusText) return false;
    const trig = findStatusTrigger();
    if (!trig) { logIssue('Status control not found — left at default.', 'warn'); setStatus('⚠️ Status control not found — left at default.'); return false; }
    openRadix(trig);
    const opts = await waitFor(() => {
      const o = Array.from(document.querySelectorAll('[role="option"],[role="menuitem"]'))
        .filter(e => e.offsetParent !== null && e.textContent.trim());
      return o.length ? o : null;
    }, 2500);
    if (!opts) { logIssue('Status list did not open — left at default.', 'warn'); setStatus('⚠️ Status list did not open — left at default.'); return false; }
    const want = statusText.replace(/\s+/g,' ').trim().toLowerCase();
    const norm = o => o.textContent.replace(/\s+/g,' ').trim().toLowerCase();
    const opt = opts.find(o => norm(o) === want)
             || opts.find(o => norm(o).includes(want))
             || opts.find(o => want.includes(norm(o)));
    if (!opt) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true }));
      const names = opts.map(o => o.textContent.trim()).join(', ');
      console.warn('[Ticket Loader] Status "'+statusText+'" not found. Real SOS options are: ['+names+']');
      logIssue(`Status "${statusText}" not applied — not in SOS list. Options: ${names}`, 'warn');
      setStatus(`⚠️ Status "${statusText}" not in list. Real options: ${names}`);
      return false;
    }
    opt.click(); await sleep(200); return true;
  }

  // The Status control sits under a <label>Status</label>. It may be a radix Select
  // (role=combobox) or a dropdown-menu trigger (aria-haspopup=menu) — accept either,
  // and skip a disabled one (e.g. a locked, already-paid sale).
  function findStatusTrigger() {
    const lab = Array.from(document.querySelectorAll('label')).find(l => l.textContent.trim() === 'Status');
    if (lab && lab.parentElement) {
      const btn = lab.parentElement.querySelector('button[role="combobox"],button[aria-haspopup="menu"],button');
      if (btn && !btn.disabled) return btn;
    }
    return Array.from(document.querySelectorAll('button[role="combobox"],button[aria-haspopup="menu"]'))
      .find(b => { const sp = b.querySelector('span'); return sp && !b.disabled &&
        /repairing|waiting|ready|paid|collected|part|quote|booking|diagnos|warranty|cancel|deposit|enquiry|posted|micro|refund/i.test(sp.textContent) &&
        !/issue|select issues/i.test(b.textContent); });
  }

  // Open a radix Select/Menu trigger reliably — they react to pointerdown, not a
  // bare click. (This was the silent status bug: .click() alone never opened it.)
  function openRadix(el) {
    try { el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); } catch {}
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.click();
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

  // ── Find a ticket's board row by its number (e.g. "A2993") ─────
  //  Board rows carry the number in .ticket-pin-helper inside a
  //  [data-rfd-draggable-id] row. Works for any ticket visible on the board.
  function findTicketRow(ticketNo) {
    const want = String(ticketNo || '').replace(/\s+/g,'').toUpperCase();
    if (!want) return null;
    const pin = Array.from(document.querySelectorAll('.ticket-pin-helper'))
      .find(el => el.textContent.replace(/\s+/g,'').toUpperCase() === want);
    if (!pin) return null;
    return pin.closest('[data-rfd-draggable-id]') || pin.closest('.group') || pin.parentElement;
  }

  // Set status on a board row. The row's status control is the button with
  // aria-haspopup="menu" that holds a span.truncate (the current status); the ⋮
  // menu button has no such span. Opens on pointerdown, items are role="menuitem".
  async function setRowStatus(row, statusText) {
    const btn = Array.from(row.querySelectorAll('button[aria-haspopup="menu"]'))
      .find(b => b.querySelector('span.truncate'));
    if (!btn) { logIssue(`Status control not found on row for "${statusText}".`, 'warn'); return false; }
    openRadix(btn);
    const opts = await waitFor(() => {
      const o = Array.from(document.querySelectorAll('[role="menuitem"]'))
        .filter(e => e.offsetParent !== null && e.textContent.trim());
      return o.length ? o : null;
    }, 2500);
    if (!opts) { logIssue(`Status menu didn't open for "${statusText}".`, 'warn'); return false; }
    const want = statusText.trim().toLowerCase();
    const hit = opts.find(o => o.textContent.trim().toLowerCase() === want) ||
                opts.find(o => o.textContent.trim().toLowerCase().includes(want));
    if (hit) { hit.click(); await sleep(cfg.stepDelay); return true; }
    document.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true }));
    const names = opts.map(o => o.textContent.trim()).join(', ');
    logIssue(`Status "${statusText}" not applied — not in SOS list. Options: ${names}`, 'warn');
    return false;
  }

  // Add a note via the row's Notes button → dialog → textarea → Add Note.
  async function addNoteOnRow(row, text) {
    if (!text) return;
    const nb = row.querySelector('button[title="Notes"]');
    if (!nb) { logIssue('Notes button not found on row.', 'warn'); return; }
    nb.click();
    const dlg = await waitFor(() => Array.from(document.querySelectorAll('[role="dialog"]'))
      .find(d => { const h = d.querySelector('h2'); return (h && /notes/i.test(h.textContent)) || d.querySelector('textarea'); }), 4000);
    if (!dlg) { logIssue('Notes dialog did not open.', 'warn'); return; }
    await sleep(200);
    const ta = dlg.querySelector('textarea[placeholder*="note" i]') || dlg.querySelector('textarea');
    if (!ta) { logIssue('Note textarea not found.', 'warn'); return; }
    setNativeValue(ta, text); await sleep(160);
    const add = Array.from(dlg.querySelectorAll('button')).find(b => /add note/i.test(b.textContent));
    if (add) { let t=0; while (add.disabled && t<14) { await sleep(140); t++; } if (!add.disabled) { add.click(); await sleep(cfg.stepDelay + 200); } }
    const close = dlg.querySelector('button .lucide-x')?.closest('button') ||
                  Array.from(dlg.querySelectorAll('button')).find(b => /close/i.test(b.textContent));
    if (close) { close.click(); await sleep(180); }
    else { document.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true })); await sleep(150); }
  }

  // ═════════════════════════════════════════════════════════════
  // Results
  // ═════════════════════════════════════════════════════════════
  function captureResult(i) {
    if (captured.has(i)) return;
    captured.add(i);
    const job = jobs[i];
    const name = job.customer ? job.customer.name : 'Walk-in';
    // pasteIndex = the job's original row index, so Results + Copy can always render
    // in the exact paste order regardless of build / skip / retry sequence.
    results.push({ pasteIndex: i, ticket: job.ticket || latestTicket() || '', name, kind: job.kind, note: job.note || '', status: job.sosStatus || '' });
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
  // Results sorted back into paste order (by pasteIndex), paired with their real
  // index in `results` so the editable inputs still write to the right entry.
  function orderedResults() {
    return results.map((r,i)=>({ r, i }))
      .sort((a,b)=> ((a.r.pasteIndex ?? a.i) - (b.r.pasteIndex ?? b.i)));
  }
  function renderResults() {
    const body=document.getElementById('sostk-results-body');
    const table=document.getElementById('sostk-results-table');
    const empty=document.getElementById('sostk-results-empty');
    const actions=document.getElementById('sostk-results-actions');
    if (!results.length) { table.style.display='none'; actions.style.display='none'; empty.style.display='block'; return; }
    empty.style.display='none'; table.style.display='table'; actions.style.display='flex';
    body.innerHTML = orderedResults().map(({ r, i }) => `
      <tr><td><input data-i="${i}" value="${esc(r.ticket)}" placeholder="A####"></td>
      <td class="sostk-res-name">${esc(r.name)}</td>
      <td style="font-size:10px;color:#64748b">${esc(r.kind)}</td></tr>`).join('');
    body.querySelectorAll('input').forEach(inp => inp.addEventListener('input', () => { results[Number(inp.dataset.i)].ticket = inp.value; }));
  }
  document.getElementById('sostk-copy-btn').addEventListener('click', () => {
    // Copy ticket numbers in paste order (one per line) so they drop straight back
    // into the sheet in the same row order you pasted from.
    const tsv = orderedResults().map(({ r }) => r.ticket).join('\n');
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
    const rows = orderedResults()
      .map(({ r }) => r)
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
  function findTab(label) {
    const want = label.toLowerCase();
    const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
    // Prefer the radix id pattern (…-trigger-ticket / …-trigger-sale), then text.
    return tabs.find(t => (t.id || '').toLowerCase().endsWith('trigger-' + want))
        || tabs.find(t => t.textContent.trim().toLowerCase().includes(want));
  }
  // Reliable radix Tab activation: retry pointer + mouse + focus + click until the
  // tab actually reports active. Radix Tabs use automatic activation (focus selects),
  // but a single click can land before the trigger is focusable — so verify + retry.
  async function clickTab(label) {
    const isActive = t => !!t && (t.getAttribute('data-state') === 'active' || t.getAttribute('aria-selected') === 'true');
    let tab = findTab(label);
    if (!tab) throw new Error(`"${label}" tab not found`);
    if (isActive(tab)) return true;
    for (let attempt = 0; attempt < 3; attempt++) {
      tab = findTab(label) || tab;
      try { tab.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); } catch {}
      tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      try { tab.focus(); } catch {}                 // radix automatic mode activates on focus
      tab.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      tab.click();
      if (await waitFor(() => isActive(findTab(label)), 1200)) { await sleep(cfg.stepDelay); return true; }
    }
    throw new Error(`Could not switch to the "${label}" tab`);
  }
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


// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  GOOGLE SHEETS WRITE-BACK — APPS SCRIPT (the bundled "second half")        ║
// ║                                                                            ║
// ║  This block does NOT run in Tampermonkey. It runs inside your Google Sheet ║
// ║  on Google's servers. Tampermonkey simply ignores it (it is all comments).  ║
// ║                                                                            ║
// ║  ONE-TIME SETUP:                                                           ║
// ║   1. Open your sheet -> Extensions -> Apps Script.                         ║
// ║   2. Copy the lines below (strip the leading "// "), paste into a new      ║
// ║      Apps Script file, edit the CONFIG block, Save.                        ║
// ║   3. Deploy -> New deployment -> Web app: Execute as Me, Access Anyone.    ║
// ║   4. Paste the /exec URL into this script: Settings -> Web App URL.        ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// ----8<---- BEGIN APPS SCRIPT (paste into Google Sheets, not Tampermonkey) ----8<----
//
// /**
//  * SOS POS Ticket Loader — write-back web app
//  * ------------------------------------------------------------------
//  * Receives finished ticket numbers from the Tampermonkey Ticket Loader
//  * and writes them into this sheet. Each incoming row is matched to a
//  * sheet row by its DESCRIPTION text, then the ticket number is written
//  * into the TICKET column (and, optionally, the status into the STATUS
//  * column).
//  *
//  * SETUP
//  *   1. Open your tracking sheet → Extensions → Apps Script.
//  *   2. Paste this whole file in (replace anything there).
//  *   3. Edit the CONFIG block below to match your sheet.
//  *   4. Deploy → New deployment → type "Web app".
//  *        • Execute as:  Me
//  *        • Who has access:  Anyone
//  *      Copy the /exec URL it gives you.
//  *   5. In the Ticket Loader → Settings, paste that URL into
//  *      "Apps Script Web App URL", set Write-back to Manual or Auto,
//  *      and (optionally) set a matching secret. Save.
//  *
//  * NOTE: column letters are 1:1 with what the userscript sends.
//  *       Matching is by exact description text (whitespace-normalised).
//  *       If two rows share an identical description, the first is used.
//  */
//
// // ─────────────── CONFIG — edit these ───────────────
// var CONFIG = {
//   SHEET_NAME: '',     // exact tab name, e.g. 'June 2026'. Leave '' for the active sheet.
//   DESC_COL:   'O',    // description column (the col after PIN in your paste) — ADJUST
//   TICKET_COL: 'C',    // where the ticket number is written
//   STATUS_COL: 'D',    // status column ('' to skip writing status)
//   HEADER_ROWS: 1,     // rows to skip at the top before data starts
//   SECRET:     '',     // leave '' for none, or set to match the Loader's "Shared secret"
// };
// // ───────────────────────────────────────────────────
//
// function doPost(e) {
//   try {
//     var body = JSON.parse(e.postData.contents || '{}');
//     if (CONFIG.SECRET && String(body.secret || '') !== CONFIG.SECRET) {
//       return _json({ error: 'bad secret' });
//     }
//     var rows = body.rows || [];
//     if (!rows.length) return _json({ updated: 0 });
//
//     var ss = SpreadsheetApp.getActiveSpreadsheet();
//     var sh = CONFIG.SHEET_NAME ? ss.getSheetByName(CONFIG.SHEET_NAME) : ss.getActiveSheet();
//     if (!sh) return _json({ error: 'sheet not found: ' + CONFIG.SHEET_NAME });
//
//     var lastRow = sh.getLastRow();
//     if (lastRow < 1) return _json({ updated: 0 });
//
//     // Read the whole description column once and normalise for matching.
//     var descCol = _colToNum(CONFIG.DESC_COL);
//     var descVals = sh.getRange(1, descCol, lastRow, 1).getValues()
//       .map(function (r) { return _norm(r[0]); });
//
//     var ticketCol = _colToNum(CONFIG.TICKET_COL);
//     var statusCol = CONFIG.STATUS_COL ? _colToNum(CONFIG.STATUS_COL) : 0;
//
//     var used = {};      // guard against writing two tickets to the same row
//     var updated = 0, unmatched = [];
//
//     rows.forEach(function (row) {
//       var key = _norm(row.key);
//       if (!key || !row.ticket) return;
//       // find first matching row at/after the header that isn't already used
//       var idx = -1;
//       for (var i = CONFIG.HEADER_ROWS; i < descVals.length; i++) {
//         if (descVals[i] === key && !used[i]) { idx = i; break; }
//       }
//       if (idx < 0) { unmatched.push(row.key); return; }
//       used[idx] = true;
//       var rn = idx + 1; // 1-based row number
//       sh.getRange(rn, ticketCol).setValue(row.ticket);
//       if (statusCol && row.status) sh.getRange(rn, statusCol).setValue(row.status);
//       updated++;
//     });
//
//     return _json({ updated: updated, unmatched: unmatched });
//   } catch (err) {
//     return _json({ error: String(err) });
//   }
// }
//
// // Quick browser check that the deployment is live (visit the /exec URL).
// function doGet() {
//   return _json({ ok: true, msg: 'SOS POS write-back web app is live. POST rows to update.' });
// }
//
// function _json(obj) {
//   return ContentService.createTextOutput(JSON.stringify(obj))
//     .setMimeType(ContentService.MimeType.JSON);
// }
//
// function _norm(v) {
//   return String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
// }
//
// // 'A' -> 1, 'C' -> 3, 'AA' -> 27
// function _colToNum(letters) {
//   var s = String(letters).toUpperCase(), n = 0;
//   for (var i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
//   return n;
// }
//
// ----8<---- END APPS SCRIPT ----8<----
