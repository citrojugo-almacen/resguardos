(function(){
  "use strict";
  // =====================================================================
  //  Citrojugo · Portal del colaborador
  //  Consulta personal (solo lectura) de los resguardos de cada colaborador.
  //  No usa cuentas de Supabase: habla con las funciones colab_* de la base,
  //  que validan el token de sesión y devuelven SOLO los datos de su dueño.
  // =====================================================================
  if(window.top !== window.self){
    try{ window.top.location = window.self.location.href; }catch(e){}
    document.documentElement.innerHTML = "";
    return;
  }

  var LOGO = "logo.png";
  var STORE_KEY = "citrojugo_portal_v1";
  var CFG = window.CITROJUGO_CONFIG || {};
  var API_URL = String(CFG.supabaseUrl || "").replace(/\/+$/, "");
  var API_KEY = String(CFG.supabaseAnonKey || "");
  var IDLE_MIN = 15;     // igual que portal_inactividad_minutos en la base

  var app = document.getElementById("app");
  var st = {
    view: "login",             // login | activar | nip | portal
    nip: null,                 // flujo de NIP: {modo, pasos, paso, digitos, valores, error, pending, obligatorio, recienActivado, listo}
    recienActivado: false,
    pending: false, error: "", info: "",
    numero: "",
    token: null,               // sesión activa
    actToken: null, actNumero: "", actUntil: 0, actTotal: 600,
    data: null, loading: false, tab: "activos",
    pwModal: null, toast: null,
    entered: false,            // el gafete ya hizo su entrada
    equipoData: null,
    equipoLoading: false,
    equipoQuery: "",
    equipoFiltro: "todos",     // todos | con_herramienta | pendientes
    expandedSubId: null,
    auditModal: null           // { resguardoId, herramienta, colaborador, resultado: "bueno", nota: "", pending: false, error: "" }
  };

  // ---------- Utilidades ----------
  function esc(s){
    return (s == null ? "" : String(s)).replace(/[&<>"']/g, function(c){
      return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];
    });
  }
  function reduceMotion(){ try{ return window.matchMedia("(prefers-reduced-motion: reduce)").matches; }catch(e){ return false; } }
  var MESES = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
  var MESES_L = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
  function isoDate(v){ return (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) ? v.slice(0,10) : ""; }
  function fmt(iso){
    iso = isoDate(iso); if(!iso) return "—";
    var p = iso.split("-"); return Number(p[2]) + " " + MESES[Number(p[1]) - 1] + " " + p[0];
  }
  function fmtMoney(n){
    if(n == null || isNaN(n)) return "—";
    return "$" + Number(n).toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " MXN";
  }
  function dayNum(iso){ var p = isoDate(iso).split("-"); return p.length === 3 ? Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000 : NaN; }
  function daysBetween(a, b){ var d = dayNum(b) - dayNum(a); return isNaN(d) ? 0 : Math.max(0, Math.round(d)); }
  function daysLabel(n){ return n === 0 ? "Hoy" : n === 1 ? "1 día" : n + " días"; }
  var MINUS = { de:1, del:1, la:1, las:1, los:1, y:1, e:1 };
  function titleCase(s){
    return String(s || "").toLowerCase().split(/\s+/).filter(Boolean).map(function(w, i){
      if(i > 0 && MINUS[w]) return w;
      return w.charAt(0).toUpperCase() + w.slice(1);
    }).join(" ");
  }
  function sentenceCase(s){ s = String(s || "").trim().toLowerCase(); return s ? s.charAt(0).toUpperCase() + s.slice(1) : ""; }
  function normNum(s){
    var n = String(s || "").replace(/\s+/g, "").toUpperCase();
    return /^\d{1,3}$/.test(n) ? ("0000" + n).slice(-4) : n;
  }
  function hash(s){ var h = 2166136261; s = String(s || ""); for(var i=0;i<s.length;i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

  function icon(n){
    var I = {
      alert:'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
      info:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="11" x2="12" y2="16"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
      check:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
      key:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3 21 2"/><path d="m16 7 3 3"/><path d="m19 4 2 2"/></svg>',
      logout:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
      eye:'<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>',
      eyeOff:'<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>',
      wrench:'<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
      shield:'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3z"/><polyline points="9 12 11 14 15 10"/></svg>',
      lock:'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
      x:'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
      out:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>',
      back:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>',
      move:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h14"/><path d="m14 4 4 4-4 4"/><path d="M20 16H6"/><path d="m10 12-4 4 4 4"/></svg>',
      pad:'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="3"/><circle cx="9" cy="8" r=".6" fill="currentColor"/><circle cx="15" cy="8" r=".6" fill="currentColor"/><circle cx="9" cy="12.5" r=".6" fill="currentColor"/><circle cx="15" cy="12.5" r=".6" fill="currentColor"/><circle cx="9" cy="17" r=".6" fill="currentColor"/><circle cx="15" cy="17" r=".6" fill="currentColor"/></svg>',
      del:'<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"/><line x1="18" y1="9" x2="12" y2="15"/><line x1="12" y1="9" x2="18" y2="15"/></svg>',
      box:'<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><line x1="12" y1="13" x2="12" y2="21"/></svg>',
      chevron:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
      users:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
      clipboard:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>',
      star:'<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>'
    };
    return I[n] || "";
  }

  // Monito de perfil: se genera a partir del nombre (siempre igual, no editable).
  function monitoSvg(nombre){
    var h = hash(nombre);
    var skins = ["#F2CBA4", "#E0AE80", "#C68B5E", "#9C6643"];
    var skinShade = ["#E3B88E", "#CC9a6c", "#B07A4F", "#875636"];
    var shirts = ["#2F6A3C", "#1D5A85", "#5B3A82", "#2F5A55", "#7A4F00", "#26402B"];
    var hairs = ["#2B1D14", "#4A3222", "#1C1C1E", "#6B4A2E"];
    var si = h % skins.length, sh = shirts[(h >>> 3) % shirts.length], hair = hairs[(h >>> 7) % hairs.length];
    var skin = skins[si], shade = skinShade[si];
    var smile = (h >>> 11) % 3;    // tres sonrisas distintas
    var mouth = smile === 0 ? '<path d="M43 52.5 Q48 56.5 53 52.5" stroke="#3A2A20" stroke-width="2" fill="none" stroke-linecap="round"/>'
             : smile === 1 ? '<path d="M44 52 Q48 55 52 52" stroke="#3A2A20" stroke-width="2" fill="none" stroke-linecap="round"/>'
             : '<path d="M43.5 51.5 Q48 57 52.5 51.5 Z" fill="#3A2A20"/>';
    return '<svg viewBox="0 0 96 96" role="img" aria-label="Avatar de ' + esc(titleCase(nombre)) + '">' +
      '<rect width="96" height="96" fill="#F1F7EA"/>' +
      '<circle cx="80" cy="16" r="22" fill="#E2F0D2"/>' +
      '<path d="M12 98 C12 76 28 66 48 66 C68 66 84 76 84 98 Z" fill="' + sh + '"/>' +
      '<rect x="12" y="84" width="72" height="4" fill="#C9E7A3" opacity=".85"/>' +
      '<path d="M40 66 L48 77 L56 66 Z" fill="#fff" opacity=".92"/>' +
      '<rect x="42" y="55" width="12" height="13" rx="4" fill="' + shade + '"/>' +
      '<circle cx="31.5" cy="45" r="4.2" fill="' + shade + '"/><circle cx="64.5" cy="45" r="4.2" fill="' + shade + '"/>' +
      '<circle cx="48" cy="44" r="17" fill="' + skin + '"/>' +
      '<path d="M31.5 40 C31.5 44 33 47 34 48 L34 38 Z M64.5 40 C64.5 44 63 47 62 48 L62 38 Z" fill="' + hair + '"/>' +
      '<circle cx="42" cy="46" r="2" fill="#1C1C1E"/><circle cx="54" cy="46" r="2" fill="#1C1C1E"/>' +
      '<circle cx="38.5" cy="50.5" r="2.6" fill="#E88F7A" opacity=".35"/><circle cx="57.5" cy="50.5" r="2.6" fill="#E88F7A" opacity=".35"/>' +
      mouth +
      '<path d="M29 38 C29 23 37 16 48 16 C59 16 67 23 67 38 Z" fill="#8BC53F"/>' +
      '<rect x="45.5" y="16.5" width="5" height="21" rx="2" fill="#fff" opacity=".32"/>' +
      '<rect x="25" y="35" width="46" height="6.5" rx="3.2" fill="#6EA82E"/>' +
      '<circle cx="48" cy="29" r="3.2" fill="#26402B" opacity=".55"/>' +
    '</svg>';
  }

  // ---------- API ----------
  function configOk(){ return /^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(API_URL) && API_KEY.length > 30; }
  function call(fn, args){
    if(!configOk()) return Promise.reject(new Error("La página no está configurada (config.js)."));
    var headers = { "apikey": API_KEY, "Content-Type": "application/json" };
    if(/^eyJ/.test(API_KEY)) headers["Authorization"] = "Bearer " + API_KEY;   // clave anon clásica (JWT)
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function(){ if(ctrl) ctrl.abort(); }, 20000);
    return fetch(API_URL + "/rest/v1/rpc/" + fn, {
      method: "POST", headers: headers, body: JSON.stringify(args || {}), signal: ctrl ? ctrl.signal : undefined,
      credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", mode: "cors"
    }).then(function(res){
      clearTimeout(timer);
      return res.text().then(function(t){
        var d = null; try{ d = t ? JSON.parse(t) : null; }catch(e){}
        if(!res.ok){
          var e = new Error(res.status === 429 ? "Demasiados intentos. Espera unos minutos." :
                            res.status >= 500 ? "El servidor no respondió. Intenta de nuevo en un momento." :
                            "No se pudo completar. Intenta de nuevo.");
          e.status = res.status; throw e;
        }
        return d || {};
      });
    }, function(err){
      clearTimeout(timer);
      var e = new Error(err && err.name === "AbortError" ? "El servidor tardó demasiado. Revisa tu señal e intenta de nuevo." : "Sin conexión. Revisa tu internet e intenta de nuevo.");
      e.network = true; throw e;
    });
  }

  function saveToken(t){ st.token = t; try{ if(t) sessionStorage.setItem(STORE_KEY, t); else sessionStorage.removeItem(STORE_KEY); }catch(e){} }
  function storedToken(){ try{ var t = sessionStorage.getItem(STORE_KEY); return /^[0-9a-f]{64}$/.test(t || "") ? t : null; }catch(e){ return null; } }

  // ---------- Derivados ----------
  function activos(){ return (st.data && st.data.resguardos || []).filter(function(r){ return r.estado === "activo"; })
    .sort(function(a, b){ return (a.fecha_prestamo || "") < (b.fecha_prestamo || "") ? -1 : 1; }); }
  function devueltos(){ return (st.data && st.data.resguardos || []).filter(function(r){ return r.estado !== "activo"; }); }
  var VIEJO = 90;   // días: a partir de aquí se marca en ámbar

  function eventos(){
    var out = [];
    (st.data && st.data.resguardos || []).forEach(function(r){
      var notas = String(r.notas || "");
      var mDe = /^Transferido de ([^.]+?)(?: \(#[^)]*\))?(?:\.|$)/.exec(notas);
      out.push({
        fecha: isoDate(r.fecha_prestamo) || isoDate(r.creado_en), ord: String(r.creado_en || ""), tipo: mDe ? "move" : "out",
        titulo: mDe ? 'Te transfirieron <b>' + esc(r.herramienta) + '</b>' + qty(r) : 'Recibiste <b>' + esc(r.herramienta) + '</b>' + qty(r),
        sub: (mDe ? 'De ' + esc(titleCase(mDe[1])) + (r.entrego ? '. Registró ' + esc(r.entrego) : '') : (r.entrego ? 'Te lo entregó ' + esc(r.entrego) : 'Entrega en almacén')) +
             (COND[r.condicion] ? ' · ' + COND[r.condicion] : '')
      });
      if(r.estado !== "activo"){
        var quien = String(r.recibio || "");
        var mA = /^(.*?) \(transferido a (.+)\)$/.exec(quien);
        var ev = { fecha: isoDate(r.fecha_devolucion) || isoDate(r.fecha_prestamo), ord: String(r.creado_en || "") + "z" };
        if(mA){ ev.tipo = "move"; ev.titulo = 'Transferiste <b>' + esc(r.herramienta) + '</b>' + qty(r); ev.sub = 'A ' + esc(titleCase(mA[2])) + (mA[1] ? '. Registró ' + esc(mA[1]) : ''); }
        else if(/\(baja de colaborador\)$/.test(quien)){ ev.tipo = "back"; ev.titulo = 'Se cerró <b>' + esc(r.herramienta) + '</b>' + qty(r); ev.sub = 'Cierre por baja, registrado por ' + esc(quien.replace(/ \(baja de colaborador\)$/, "")); }
        else if(/\(ajuste admin\)$/.test(quien)){ ev.tipo = "back"; ev.titulo = 'Se retiró de tu resguardo <b>' + esc(r.herramienta) + '</b>' + qty(r); ev.sub = 'Ajuste autorizado por ' + esc(quien.replace(/ \(ajuste admin\)$/, "")); }
        else { ev.tipo = "back"; ev.titulo = 'Devolviste <b>' + esc(r.herramienta) + '</b>' + qty(r); ev.sub = quien ? 'La recibió ' + esc(quien) : 'Devuelta en almacén'; }
        out.push(ev);
      }
    });
    out.sort(function(a, b){ return a.fecha === b.fecha ? (a.ord < b.ord ? 1 : -1) : (a.fecha < b.fecha ? 1 : -1); });
    return out;
  }
  var COND = { nuevo: "Nuevo", usado_bueno: "Usado en buen estado", usado_malo: "Usado en mal estado" };
  function qty(r){ return r.cantidad > 1 ? ' <span class="qty">×' + Number(r.cantidad) + '</span>' : ''; }

  // ---------- Plantillas ----------
  function errorTpl(){ return st.error ? '<p class="errorText" role="alert">' + icon("alert") + '<span>' + esc(st.error) + '</span></p>' : ''; }
  function pwField(id, labelTxt, ac, extra){
    return '<div class="field"><label for="' + id + '">' + labelTxt + '</label><div class="pwWrap">' +
      '<input type="password" id="' + id + '" autocomplete="' + ac + '" maxlength="72" spellcheck="false" autocapitalize="off"' + (extra || '') + '/>' +
      '<button type="button" class="eyeBtn" data-action="eye" data-for="' + id + '" aria-label="Mostrar contraseña">' + icon("eye") + '</button></div></div>';
  }

  function loginTpl(){
    return '<div class="loginShell"><div class="loginCard' + cardCls("login") + '">' +
      '<div class="loginBrand"><img src="' + LOGO + '" alt="Citrojugo"/><div class="loginName">Citrojugo</div><div class="loginSub">Portal del colaborador</div></div>' +
      '<form id="f-login" novalidate>' +
        '<div class="field"><label for="in-num">Número de empleado</label>' +
          '<input type="text" id="in-num" class="num" inputmode="numeric" autocomplete="username" maxlength="30" spellcheck="false" autocapitalize="characters" placeholder="Ej. 0123" value="' + esc(st.numero) + '"/></div>' +
        pwField("in-pass", "Contraseña", "current-password") +
        (st.info ? '<p class="hint" style="margin:-4px 0 14px;color:var(--okInk);font-weight:600;">' + esc(st.info) + '</p>' : '') +
        (!configOk() ? '<p class="errorText">' + icon("alert") + '<span>Falta configurar la conexión (config.js).</span></p>' : '') +
        errorTpl() +
        '<button type="submit" class="btnPrimary"' + (st.pending || !configOk() ? ' disabled' : '') + '>' + (st.pending ? 'Verificando…' : 'Entrar') + '</button>' +
      '</form>' +
      '<div class="firstTime">' + icon("info") + '<span><b>¿Es tu primera vez?</b> Escribe tu número de empleado también como contraseña. Enseguida te pediremos crear la tuya.</span></div>' +
      '<div class="loginFoot"><a class="link" href="index.html">Soy personal de almacén</a></div>' +
    '</div></div>';
  }

  function activarTpl(){
    var left = Math.max(0, Math.round((st.actUntil - Date.now()) / 1000));
    return '<div class="loginShell"><div class="loginCard' + cardCls("activar", " swap") + '">' +
      '<div class="stepHead"><span class="stepIco">' + icon("shield") + '</span>' +
        '<h1 class="stepTitle">Crea tu contraseña</h1>' +
        '<p class="stepSub">Colaborador <span class="numTag">#' + esc(st.actNumero) + '</span>. Para confirmar que eres tú, escribe tu nombre completo como aparece en tu registro de la empresa.</p></div>' +
      '<div class="timer' + (left < 120 ? ' low' : '') + '" id="act-timer"><span id="act-left">' + mmss(left) + '</span><div class="timerTrack"><div class="timerFill" id="act-fill" style="transform:scaleX(' + (left / st.actTotal).toFixed(3) + ')"></div></div></div>' +
      '<div class="explain">' + icon("key") + '<span><b>¿Para qué sirve tu contraseña?</b> Para entrar a este portal y consultar la herramienta que tienes a tu nombre. Solo sirve para consultar: con ella no se puede recibir ni mover herramienta.</span></div>' +
      '<form id="f-activar" novalidate>' +
        '<div class="field"><label for="in-nombre">Nombre completo</label>' +
          '<input type="text" id="in-nombre" autocomplete="off" maxlength="160" spellcheck="false" placeholder="Apellido paterno, materno y nombre(s)"/>' +
          '<p class="hint">Ejemplo: Pérez López Juan Carlos. No importan mayúsculas ni acentos.</p></div>' +
        pwField("in-new", "Contraseña nueva", "new-password") +
        '<ul class="rules" id="rules" style="margin:-6px 0 16px;">' +
          '<li data-rule="len"><i>' + icon("check") + '</i>Al menos 8 caracteres</li>' +
          '<li data-rule="mix"><i>' + icon("check") + '</i>Una letra y un número</li>' +
          '<li data-rule="num"><i>' + icon("check") + '</i>Distinta de tu número de empleado</li></ul>' +
        pwField("in-new2", "Confirma la contraseña", "new-password") +
        errorTpl() +
        '<button type="submit" class="btnPrimary"' + (st.pending ? ' disabled' : '') + '>' + (st.pending ? 'Guardando…' : 'Crear contraseña y entrar') + '</button>' +
      '</form>' +
      '<div class="loginFoot"><button type="button" class="link" data-action="cancel-act">Cancelar</button></div>' +
    '</div></div>';
  }
  // ---------- NIP ----------
  var PASO_TXT = { actual: "Escribe tu NIP actual", nuevo: "Escribe tu NIP nuevo", confirmar: "Escríbelo otra vez para confirmar" };
  var PASO_CORTO = { actual: "Actual", nuevo: "Nuevo", confirmar: "Confirmar" };
  function nipTpl(){
    var f = st.nip, paso = f.pasos[f.paso];
    var titulo = f.modo === "crear" ? "Crea tu NIP" : f.recienActivado ? "Tu NIP de almacén" : "Cambia tu NIP";
    var sub = f.modo === "crear" ? "Último paso. Elige 4 números que solo tú conozcas."
            : f.recienActivado ? "El almacén ya te asignó un NIP. Puedes conservarlo o cambiarlo por uno que elijas tú."
            : "Para cambiarlo, primero confirma el que tienes ahora.";
    if(f.listo){
      return '<div class="loginShell"><div class="loginCard calm nipCardDone">' +
        '<div class="nipDone"><span class="welcomeCheck">' + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>' +
        '<b>' + (f.modo === "crear" ? "NIP creado" : "NIP actualizado") + '</b>' +
        '<span>Úsalo en el almacén cuando recibas herramienta. Podrás cambiarlo de nuevo dentro de 24 horas.</span></div></div></div>';
    }
    var steps = f.pasos.map(function(k, i){
      return (i ? '<span class="nipLine' + (i <= f.paso ? ' on' : '') + '"></span>' : '') +
        '<span class="nipStep' + (i < f.paso ? ' done' : i === f.paso ? ' on' : '') + '"><i>' + (i < f.paso ? icon("check") : (i + 1)) + '</i><span>' + PASO_CORTO[k] + '</span></span>';
    }).join("");
    var dots = ""; for(var i=0;i<4;i++) dots += '<span class="dot' + (i < f.digitos.length ? ' filled' : '') + (f.err ? ' err' : '') + '"></span>';
    var keys = ""; ["1","2","3","4","5","6","7","8","9"].forEach(function(k){ keys += '<button type="button" class="pinKey" data-action="pin" data-k="' + k + '">' + k + '</button>'; });
    keys += '<span></span><button type="button" class="pinKey" data-action="pin" data-k="0">0</button>' +
            '<button type="button" class="pinKey keyDel" data-action="pin-del" aria-label="Borrar">' + icon("del") + '</button>';
    return '<div class="loginShell"><div class="loginCard' + cardCls("nip", " swap") + '">' +
      '<div class="stepHead"><span class="stepIco">' + icon("pad") + '</span><h1 class="stepTitle">' + titulo + '</h1><p class="stepSub">' + sub + '</p></div>' +
      (f.paso === 0 && !f.error ? '<div class="explain">' + icon("shield") + '<span><b>¿Para qué sirve tu NIP?</b> Es tu firma en el almacén: lo tecleas tú cuando recibes herramienta o cuando un compañero te la transfiere. Así nadie puede poner herramienta a tu nombre sin tu autorización. No lo compartas con nadie, ni con el personal del almacén. Es distinto de tu contraseña.</span></div>' : '') +
      '<div class="nipSteps" aria-hidden="true">' + steps + '</div>' +
      '<p class="nipPrompt" id="nip-prompt">' + PASO_TXT[paso] + '</p>' +
      '<div class="pinDots" id="nip-dots" role="status" aria-label="' + f.digitos.length + ' de 4 números">' + dots + '</div>' +
      (f.error ? '<p class="errorText nipErr" role="alert">' + icon("alert") + '<span>' + esc(f.error) + '</span></p>' : '') +
      '<div class="pinGrid' + (f.pending ? ' busy' : '') + '">' + keys + '</div>' +
      (f.pending ? '<p class="hint center">Guardando…</p>' : '') +
      '<div class="loginFoot">' + (f.obligatorio ? '<button type="button" class="link" data-action="logout">Cerrar sesión</button>'
        : '<button type="button" class="link" data-action="nip-cancel">' + (f.recienActivado ? 'Conservar mi NIP actual' : 'Cancelar') + '</button>') + '</div>' +
    '</div></div>';
  }
  function horaCorta(iso){ try{ return new Date(iso).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" }); }catch(e){ return ""; } }
  function fechaHora(iso){ var d = new Date(iso); if(isNaN(d)) return ""; return d.getDate() + " " + MESES[d.getMonth()] + ", " + horaCorta(iso); }
  function nipCardTpl(){
    var n = (st.data && st.data.nip) || {};
    var estado = n.bloqueado_hasta ? '<span class="nipState warn">Bloqueado por intentos hasta las ' + esc(horaCorta(n.bloqueado_hasta)) + '</span>'
      : n.tiene ? '<span class="nipState ok">Activo · ' + (n.origen === "portal" ? 'lo elegiste tú' : 'asignado por el almacén') + '</span>'
      : '<span class="nipState warn">Pendiente</span>';
    var espera = n.puede_cambiar_desde && new Date(n.puede_cambiar_desde) > new Date();
    var btn = !n.tiene ? '<button type="button" class="btnGhost nipBtn" data-action="open-nip">Crear NIP</button>'
      : espera ? '<button type="button" class="btnGhost nipBtn" disabled title="Solo un cambio cada 24 horas">Disponible el ' + esc(fechaHora(n.puede_cambiar_desde)) + '</button>'
      : '<button type="button" class="btnGhost nipBtn" data-action="open-nip">Cambiar NIP</button>';
    return '<section class="nipCard" aria-label="Tu NIP"><span class="nipIco">' + icon("pad") + '</span>' +
      '<div class="nipInfo"><b>Tu NIP de almacén</b>' + estado + '</div>' + btn + '</section>';
  }

  // La entrada animada de cada pantalla corre una sola vez (no al mostrar un error).
  var animated = {};
  function cardCls(view, first){ if(animated[view]) return " calm"; animated[view] = true; return first || ""; }
  function mmss(s){ return Math.floor(s / 60) + ":" + ("0" + (s % 60)).slice(-2) + " para terminar"; }

  function portalTpl(){
    var d = st.data;
    var top = '<header class="topBar"><div class="topInner"><img src="' + LOGO + '" alt=""/>' +
      '<div class="topTitle"><b>Mis resguardos</b><span>Citrojugo · Portal del colaborador</span></div>' +
      '<button type="button" class="iconBtn" data-action="open-pw" aria-label="Cambiar contraseña" title="Cambiar contraseña">' + icon("key") + '<span>Contraseña</span></button>' +
      '<button type="button" class="iconBtn" data-action="logout" aria-label="Cerrar sesión" title="Cerrar sesión">' + icon("logout") + '<span>Salir</span></button>' +
      '</div></header>';
    if(!d){
      return '<div class="portal">' + top + '<main class="wrap"><div class="badgeHang"><div class="badge" style="height:210px;"><div class="badgeBand"></div></div></div>' +
        '<div style="display:grid;gap:12px;margin-top:16px;"><div class="skel"></div><div class="skel"></div></div>' +
        (st.error ? '<p class="errorText" style="margin-top:16px;">' + icon("alert") + '<span>' + esc(st.error) + '</span></p><button class="btnGhost" data-action="reload">Intentar de nuevo</button>' : '') +
        '</main></div>';
    }
    var p = d.perfil || {}, hoy = isoDate(d.hoy) || new Date().toISOString().slice(0, 10);
    var act = activos(), dev = devueltos(), evs = eventos();
    var piezas = act.reduce(function(s, r){ return s + (Number(r.cantidad) || 1); }, 0);
    var maxDias = act.reduce(function(m, r){ return Math.max(m, daysBetween(r.fecha_prestamo, hoy)); }, 0);

    var badge = '<div class="badgeHang"><div class="lanyard" aria-hidden="true"></div>' +
      '<section class="badge' + (st.entered ? '' : ' enter') + '" aria-label="Gafete del colaborador"><div class="badgeBand"><span class="badgeSlot"></span></div>' +
        '<div class="badgeBody"><div class="monito">' + monitoSvg(p.nombre) + '</div>' +
          '<div class="who"><div class="whoName">' + esc(titleCase(p.nombre)) + '</div><div class="whoRole">' + esc(sentenceCase(p.puesto) || "Colaborador") + '</div></div></div>' +
        '<div class="badgeFacts">' +
          '<div class="fact num"><small>No. empleado</small><b>' + esc(p.numero_empleado) + '</b></div>' +
          '<div class="fact"><small>Departamento</small><b title="' + esc(sentenceCase(p.area)) + '">' + esc(sentenceCase(p.area) || "—") + '</b></div>' +
          '<div class="fact"><small>Localidad</small><b>' + esc(titleCase(p.localidad) || "—") + '</b></div>' +
        '</div>' +
        '<div class="badgeLock">' + icon("lock") + '<span>Datos oficiales de la empresa. Si algo no es correcto, avisa en el departamento de Almacén.' +
          (p.activado_en ? ' Creaste tu contraseña el ' + fmt(p.activado_en) + '.' : '') + '</span></div>' +
      '</section></div>';

    var summary = '<section class="summary" aria-label="Resumen">' +
      '<div class="sumItem s-on"><div class="sumLabel">En resguardo</div><div class="sumValue" data-count="' + act.length + '">' + act.length + '</div><div class="sumSub">' + piezas + (piezas === 1 ? ' pieza' : ' piezas') + '</div></div>' +
      '<div class="sumItem"><div class="sumLabel">Devueltas</div><div class="sumValue" data-count="' + dev.length + '">' + dev.length + '</div><div class="sumSub">en tu historial</div></div>' +
      '<div class="sumItem' + (maxDias >= VIEJO ? ' s-old' : '') + '"><div class="sumLabel">Más antigua</div><div class="sumValue" data-count="' + (act.length ? maxDias : 0) + '">' + (act.length ? maxDias : '—') + '</div><div class="sumSub">' + (act.length ? (maxDias === 1 ? 'día contigo' : 'días contigo') : 'sin pendientes') + '</div></div>' +
    '</section>';

    var hasEquipo = !!(st.equipoData && st.equipoData.ok && st.equipoData.equipo && st.equipoData.equipo.length > 0);
    var seg = '';
    if(hasEquipo){
      var posClass = st.tab === "activos" ? "pos-0" : (st.tab === "equipo" ? "pos-1" : "pos-2");
      seg = '<div class="seg cols3 ' + posClass + '" role="tablist"><span class="segGlider" aria-hidden="true"></span>' +
        '<button type="button" role="tab" class="segBtn' + (st.tab === "activos" ? ' on' : '') + '" aria-selected="' + (st.tab === "activos") + '" data-action="tab" data-tab="activos">Mis resguardos <span class="segCount">' + act.length + '</span></button>' +
        '<button type="button" role="tab" class="segBtn' + (st.tab === "equipo" ? ' on' : '') + '" aria-selected="' + (st.tab === "equipo") + '" data-action="tab" data-tab="equipo">Mi personal <span class="segCount">' + st.equipoData.equipo.length + '</span></button>' +
        '<button type="button" role="tab" class="segBtn' + (st.tab === "historial" ? ' on' : '') + '" aria-selected="' + (st.tab === "historial") + '" data-action="tab" data-tab="historial">Historial <span class="segCount">' + evs.length + '</span></button></div>';
    } else {
      seg = '<div class="seg' + (st.tab === "historial" ? ' right' : '') + '" role="tablist"><span class="segGlider" aria-hidden="true"></span>' +
        '<button type="button" role="tab" class="segBtn' + (st.tab === "activos" ? ' on' : '') + '" aria-selected="' + (st.tab === "activos") + '" data-action="tab" data-tab="activos">En resguardo <span class="segCount">' + act.length + '</span></button>' +
        '<button type="button" role="tab" class="segBtn' + (st.tab === "historial" ? ' on' : '') + '" aria-selected="' + (st.tab === "historial") + '" data-action="tab" data-tab="historial">Historial <span class="segCount">' + evs.length + '</span></button></div>';
    }

    var body;
    if(st.tab === "equipo" && hasEquipo){
      body = equipoTpl();
    } else if(st.tab === "activos"){
      body = act.length === 0
        ? '<div class="empty"><span class="emptyIco">' + icon("check") + '</span><b>No tienes herramienta en resguardo</b>Cuando el almacén te entregue algo, aparecerá aquí con su fecha.</div>'
        : '<div class="list" id="list">' + act.map(function(r, i){
            var dias = daysBetween(r.fecha_prestamo, hoy), viejo = dias >= VIEJO;
            return '<article class="item' + (viejo ? ' old' : '') + '" style="--i:' + i + '"><div class="itemTop"><span class="itemIco">' + icon("wrench") + '</span>' +
              '<div class="itemMain"><div class="itemName">' + esc(r.herramienta) + qty(r) + '</div><div class="itemWhen">Desde el ' + fmt(r.fecha_prestamo) + '</div></div>' +
              '<span class="days" title="Tiempo en tu resguardo">' + daysLabel(dias) + '</span></div>' +
              (r.id_articulo || r.occ || COND[r.condicion] ? '<div class="tags">' + (COND[r.condicion] ? '<span class="cond c-' + r.condicion + '">Entregada: ' + COND[r.condicion] + '</span>' : '') + (r.id_articulo ? '<span class="tag id">ID ' + esc(r.id_articulo) + '</span>' : '') + (r.occ ? '<span class="tag occ">OCC ' + esc(r.occ) + '</span>' : '') + '</div>' : '') +
              (r.notas ? '<p class="note">' + esc(r.notas) + '</p>' : '') +
              '<div class="itemMeta"><div>Te lo entregó<b>' + esc(r.entrego || "Almacén") + '</b></div><div>Cantidad<b>' + Number(r.cantidad || 1) + (Number(r.cantidad) > 1 ? ' piezas' : ' pieza') + '</b></div></div>' +
            '</article>';
          }).join("") + '</div>';
    } else {
      if(evs.length === 0){
        body = '<div class="empty"><span class="emptyIco">' + icon("box") + '</span><b>Tu historial está vacío</b>Aquí verás cada entrega, devolución y transferencia a tu nombre.</div>';
      } else {
        var groups = [], cur = null;
        evs.forEach(function(e){
          var k = e.fecha.slice(0, 7);
          if(!cur || cur.k !== k){ cur = { k: k, items: [] }; groups.push(cur); }
          cur.items.push(e);
        });
        body = '<div class="list" id="list">' + groups.map(function(g, gi){
          var pp = g.k.split("-");
          return '<div style="--i:' + gi + '"><div class="month">' + (pp.length === 2 ? MESES_L[Number(pp[1]) - 1] + ' ' + pp[0] : 'Sin fecha') + '</div><div class="tl">' +
            g.items.map(function(e){
              return '<div class="ev ' + e.tipo + '"><div class="evRail"><span class="evDot">' + icon(e.tipo) + '</span></div>' +
                '<div class="evMain"><div class="evTitle">' + e.titulo + '</div><div class="evSub">' + e.sub + '</div></div>' +
                '<div class="evDate">' + (e.fecha ? Number(e.fecha.slice(8, 10)) + ' ' + MESES[Number(e.fecha.slice(5, 7)) - 1] : '—') + '</div></div>';
            }).join("") + '</div></div>';
        }).join("") + '</div>';
      }
    }
    var foot = '<p class="pFoot">Esta es una consulta personal: nadie más ve esta información desde aquí. Si algo no coincide con lo que tienes, avisa en el almacén.' +
      (p.ultimo_acceso ? '<br/>Último ingreso anterior: ' + fmt(p.ultimo_acceso) + '.' : '') + '</p>';
    return '<div class="portal">' + top + '<main class="wrap">' + badge + nipCardTpl() + summary + seg + body + foot + '</main></div>';
  }

  function equipoTpl(){
    if(!st.equipoData || !st.equipoData.ok) return '';
    var eq = st.equipoData;
    var lider = eq.lider || {};
    var res = eq.resumen || {};
    var list = eq.equipo || [];

    var lvlMap = {
      director_general: { label: "Director General", cls: "lvl-dg", ico: "star" },
      director: { label: "Director de Área", cls: "lvl-dir", ico: "shield" },
      gerente: { label: "Gerente", cls: "lvl-ger", ico: "users" },
      supervisor: { label: "Supervisor / Coordinador", cls: "lvl-sup", ico: "users" }
    };
    var lInfo = lvlMap[lider.nivel] || { label: "Líder de Área", cls: "lvl-sup", ico: "users" };

    var q = String(st.equipoQuery || "").trim().toLowerCase();
    var filtro = st.equipoFiltro || "todos";

    var filtered = list.filter(function(sub){
      if(filtro === "con_herramienta" && (sub.herramientas_activas || 0) <= 0) return false;
      if(filtro === "pendientes" && (sub.pendientes_revision || 0) <= 0) return false;
      if(!q) return true;
      var matchNombre = String(sub.nombre || "").toLowerCase().indexOf(q) >= 0;
      var matchNum = String(sub.numero_empleado || "").toLowerCase().indexOf(q) >= 0;
      var matchPuesto = String(sub.puesto || "").toLowerCase().indexOf(q) >= 0;
      var matchArea = String(sub.area || "").toLowerCase().indexOf(q) >= 0;
      return matchNombre || matchNum || matchPuesto || matchArea;
    });

    var conHerrCount = list.filter(function(s){ return (s.herramientas_activas || 0) > 0; }).length;
    var pendCount = list.filter(function(s){ return (s.pendientes_revision || 0) > 0; }).length;

    var html = '<div class="leaderBanner">' +
      '<div class="leaderHead">' +
        '<div class="leaderTitle">' + icon("users") + ' Personal a tu cargo</div>' +
        '<span class="badgeLevel ' + lInfo.cls + '">' + icon(lInfo.ico) + ' ' + esc(lInfo.label) + '</span>' +
      '</div>' +
      '<p class="hint" style="margin:0 0 14px;">Supervisa el inventario de herramientas de tu equipo y realiza auditorías de campo para verificar su existencia y estado físico.</p>' +
      '<div class="summary" style="margin:0;">' +
        '<div class="sumItem s-on"><div class="sumLabel">Colaboradores</div><div class="sumValue">' + res.total_colaboradores + '</div><div class="sumSub">' + res.con_herramienta + ' con resguardo</div></div>' +
        '<div class="sumItem"><div class="sumLabel">Herramientas</div><div class="sumValue">' + res.total_herramientas + '</div><div class="sumSub">piezas activas</div></div>' +
        '<div class="sumItem' + (res.pendientes_revision > 0 ? ' s-old' : '') + '"><div class="sumLabel">Auditorías</div><div class="sumValue">' + (res.pendientes_revision || 0) + '</div><div class="sumSub">pendientes (>180 d)</div></div>' +
      '</div>';

    if(lider.puede_ver_costos && res.capital_total != null){
      html += '<div class="capitalCard">' +
        '<div><div class="capitalLabel">Capital total en resguardo</div><div class="capitalVal">' + fmtMoney(res.capital_total) + '</div><div class="capitalSub">Valuación monetaria oficial del inventario bajo tu dirección</div></div>' +
        icon("shield") +
      '</div>';
    }

    html += '</div>';

    html += '<div class="equipoFilterWrap">' +
      '<input type="text" id="in-search-equipo" placeholder="Buscar por colaborador, puesto o área..." value="' + esc(st.equipoQuery) + '"/>' +
      '<div class="filterChips">' +
        '<button type="button" class="filterChip' + (filtro === "todos" ? ' on' : '') + '" data-action="filtro-equipo" data-f="todos">Todos <span class="cnt">' + list.length + '</span></button>' +
        '<button type="button" class="filterChip' + (filtro === "con_herramienta" ? ' on' : '') + '" data-action="filtro-equipo" data-f="con_herramienta">Con resguardo <span class="cnt">' + conHerrCount + '</span></button>' +
        '<button type="button" class="filterChip' + (filtro === "pendientes" ? ' on' : '') + '" data-action="filtro-equipo" data-f="pendientes">Pendientes auditoría <span class="cnt">' + pendCount + '</span></button>' +
      '</div>' +
    '</div>';

    if(filtered.length === 0){
      html += '<div class="empty"><span class="emptyIco">' + icon("users") + '</span><b>No se encontraron colaboradores</b>Prueba con otros términos de búsqueda o filtro.</div>';
      return html;
    }

    html += '<div class="list" id="list">';
    filtered.forEach(function(sub, idx){
      var isExpanded = st.expandedSubId === sub.id;
      var activeCount = sub.herramientas_activas || 0;
      var needsRev = sub.pendientes_revision || 0;
      var items = sub.items || [];

      html += '<article class="subCard' + (isExpanded ? ' expanded' : '') + '" style="--i:' + idx + '">' +
        '<div class="subCardHead" data-action="toggle-sub" data-id="' + sub.id + '">' +
          '<div class="subCardInfo">' +
            '<div class="subName">' + esc(titleCase(sub.nombre)) + '</div>' +
            '<div class="subMeta">' + (sub.numero_empleado ? '#' + esc(sub.numero_empleado) + ' · ' : '') + esc(sentenceCase(sub.puesto) || "Operativo") + (sub.area ? ' · ' + esc(titleCase(sub.area)) : '') + '</div>' +
            '<div class="subPills">' +
              '<span class="subPill' + (activeCount > 0 ? ' hasTools' : '') + '">' + icon("wrench") + ' ' + activeCount + (activeCount === 1 ? ' herramienta' : ' herramientas') + '</span>' +
              (needsRev > 0 ? '<span class="subPill needsReview">' + icon("alert") + ' ' + needsRev + ' por auditar</span>' : '') +
              (lider.puede_ver_costos && sub.valor_resguardos != null && sub.valor_resguardos > 0 ? '<span class="subPill cost">' + fmtMoney(sub.valor_resguardos) + '</span>' : '') +
            '</div>' +
          '</div>' +
          '<button type="button" class="subExpandBtn" aria-label="' + (isExpanded ? 'Contraer' : 'Expandir') + '">' + icon("chevron") + '</button>' +
        '</div>';

      if(isExpanded){
        html += '<div class="subDetail">' +
          '<div class="subDetailTitle">Herramientas asignadas</div>';
        if(items.length === 0){
          html += '<p class="hint" style="margin:4px 0 0;">Este colaborador no tiene herramientas activas actualmente.</p>';
        } else {
          html += '<div class="subToolsList">';
          items.forEach(function(item){
            var condLabel = COND[item.condicion] || item.condicion;
            var audStateClass = !item.revision_en ? 'pendiente' : (item.revision_resultado || 'pendiente');
            var audStateLabel = !item.revision_en ? 'Sin auditar' :
              (item.revision_resultado === 'bueno' ? 'Bueno' :
               item.revision_resultado === 'danado' ? 'Dañado' :
               item.revision_resultado === 'no_localizado' ? 'No localizado' : 'Auditado');

            html += '<div class="toolRow">' +
              '<div class="toolRowTop">' +
                '<div class="toolNameText">' + esc(item.herramienta) + qty(item) + '</div>' +
                (lider.puede_ver_costos && item.costo_unitario != null ? '<div class="toolCostText">' + fmtMoney(item.costo_unitario) + ' c/u</div>' : '') +
              '</div>' +
              '<div class="toolMetaText">' +
                'Asignada el ' + fmt(item.fecha_prestamo) +
                (item.id_articulo ? ' · ID ' + esc(item.id_articulo) : '') +
                (item.occ ? ' · OCC ' + esc(item.occ) : '') +
                (condLabel ? ' · ' + esc(condLabel) : '') +
              '</div>' +
              '<div class="toolAuditInfo">' +
                '<div>' +
                  '<span class="auditState ' + audStateClass + '">' + audStateLabel + '</span>' +
                  (item.revision_en ? ' <span class="dim" style="font-size:12px;color:var(--label3);margin-left:4px;">(' + fmt(item.revision_en) + (item.revision_nota ? ' · "' + esc(item.revision_nota) + '"' : '') + ')</span>' : '') +
                '</div>' +
                '<button type="button" class="btnAudit" data-action="open-audit" data-id="' + item.id + '" data-tool="' + esc(item.herramienta) + '" data-who="' + esc(sub.nombre) + '">' +
                  icon("clipboard") + ' ' + (item.revision_en ? 'Actualizar auditoría' : 'Auditar') +
                '</button>' +
              '</div>' +
            '</div>';
          });
          html += '</div>';
        }
        html += '</div>';
      }

      html += '</article>';
    });
    html += '</div>';
    return html;
  }

  function pwModalTpl(){
    if(!st.pwModal) return "";
    var m = st.pwModal;
    return '<div class="overlay" data-action="pw-backdrop"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="pw-title">' +
      '<div class="modalHead"><div><div class="modalTitle" id="pw-title">Cambiar contraseña</div><p class="modalSub">Por seguridad, confirma tu nombre completo y tu contraseña actual.</p></div>' +
      '<button type="button" class="closeBtn" data-action="close-pw" aria-label="Cerrar">' + icon("x") + '</button></div>' +
      '<form id="f-pw" novalidate>' +
        '<div class="field"><label for="pw-nombre">Nombre completo</label><input type="text" id="pw-nombre" autocomplete="off" maxlength="160" spellcheck="false" placeholder="Como aparece en tu registro"/></div>' +
        pwField("pw-actual", "Contraseña actual", "current-password") +
        pwField("pw-new", "Contraseña nueva", "new-password") +
        pwField("pw-new2", "Confirma la contraseña nueva", "new-password") +
        '<p class="hint" style="margin:-6px 0 14px;">Al menos 8 caracteres, con una letra y un número. Se cerrará tu sesión en otros dispositivos.</p>' +
        (m.error ? '<p class="errorText" role="alert">' + icon("alert") + '<span>' + esc(m.error) + '</span></p>' : '') +
        '<button type="submit" class="btnPrimary"' + (m.pending ? ' disabled' : '') + '>' + (m.pending ? 'Guardando…' : 'Guardar contraseña') + '</button>' +
      '</form></div></div>';
  }

  function auditModalTpl(){
    if(!st.auditModal) return "";
    var m = st.auditModal;
    return '<div class="overlay" data-action="audit-backdrop"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="audit-title">' +
      '<div class="modalHead"><div>' +
        '<div class="modalTitle" id="audit-title">Auditar herramienta</div>' +
        '<p class="modalSub">Colaborador: <b>' + esc(titleCase(m.colaborador)) + '</b></p>' +
      '</div>' +
      '<button type="button" class="closeBtn" data-action="close-audit" aria-label="Cerrar">' + icon("x") + '</button></div>' +
      '<div style="background:var(--surface);border:1px solid var(--sep);border-radius:var(--r-sm);padding:12px 14px;margin-bottom:16px;">' +
        '<div style="font-size:12.5px;color:var(--label3);font-weight:600;">Herramienta física</div>' +
        '<div style="font-size:16px;font-weight:700;margin-top:2px;">' + esc(m.herramienta) + '</div>' +
      '</div>' +
      '<form id="f-audit" novalidate>' +
        '<label>Resultado de la inspección física</label>' +
        '<div class="auditChoices">' +
          '<label class="auditChoice">' +
            '<input type="radio" name="audit-res" value="bueno"' + (m.resultado === "bueno" ? ' checked' : '') + '/>' +
            '<div><span class="auditChoiceTitle" style="color:var(--okInk);">✓ Bueno / Operativo</span><span class="auditChoiceDesc">La herramienta está presente físicamente, en buenas condiciones y operable.</span></div>' +
          '</label>' +
          '<label class="auditChoice">' +
            '<input type="radio" name="audit-res" value="danado"' + (m.resultado === "danado" ? ' checked' : '') + '/>' +
            '<div><span class="auditChoiceTitle" style="color:var(--warnInk);">⚠ Dañado / Requiere atención</span><span class="auditChoiceDesc">Presente pero requiere reemplazo, reparación o mantenimiento.</span></div>' +
          '</label>' +
          '<label class="auditChoice">' +
            '<input type="radio" name="audit-res" value="no_localizado"' + (m.resultado === "no_localizado" ? ' checked' : '') + '/>' +
            '<div><span class="auditChoiceTitle" style="color:var(--danger);">✕ No localizado / Faltante</span><span class="auditChoiceDesc">El colaborador no presentó la herramienta durante la inspección.</span></div>' +
          '</label>' +
        '</div>' +
        '<div class="field">' +
          '<label for="in-audit-nota">Notas de la revisión (opcional)</label>' +
          '<input type="text" id="in-audit-nota" maxlength="200" placeholder="Ej. Desgaste en mango, serie verificada..." value="' + esc(m.nota || "") + '"/>' +
        '</div>' +
        (m.error ? '<p class="errorText" role="alert">' + icon("alert") + '<span>' + esc(m.error) + '</span></p>' : '') +
        '<button type="submit" class="btnPrimary"' + (m.pending ? ' disabled' : '') + '>' + (m.pending ? 'Guardando auditoría…' : 'Guardar auditoría oficial') + '</button>' +
      '</form>' +
    '</div></div>';
  }

  // ---------- Render ----------
  function render(){
    var keep = captureInputs();
    var html = st.view === "activar" ? activarTpl() : st.view === "nip" ? nipTpl() : st.view === "portal" ? portalTpl() + pwModalTpl() + auditModalTpl() : loginTpl();
    if(st.toast) html += '<div class="toast ' + (st.toast.type === "err" ? "err" : "") + '" role="status"><span class="tIcon">' + icon(st.toast.type === "err" ? "alert" : "check") + '</span>' + esc(st.toast.msg) + '</div>';
    app.innerHTML = html;
    restoreInputs(keep);
    if(st.view === "portal" && st.data && !st.entered){
      st.entered = true;
      countUp();
      var list = document.getElementById("list"); if(list) list.classList.add("enter");
    }
  }
  // Conserva lo tecleado y el foco entre renders (para no borrar campos al mostrar un error).
  function captureInputs(){
    var out = { vals: {}, focus: document.activeElement && document.activeElement.id };
    Array.prototype.forEach.call(app.querySelectorAll("input[id]"), function(i){ out.vals[i.id] = { v: i.value, t: i.type }; });
    return out;
  }
  function restoreInputs(k){
    Object.keys(k.vals).forEach(function(id){ var el = document.getElementById(id); if(el){ el.value = k.vals[id].v; el.type = k.vals[id].t; } });
    var f = k.focus && document.getElementById(k.focus);
    if(f && f.focus){ try{ f.focus({ preventScroll: true }); }catch(e){} }
    updateRules();
  }
  function countUp(){
    if(reduceMotion()) return;
    Array.prototype.forEach.call(document.querySelectorAll(".sumValue[data-count]"), function(el, idx){
      var to = Number(el.getAttribute("data-count")) || 0, txt = el.textContent;
      if(!to || txt === "—") return;
      var t0 = null, dur = 900, delay = 450 + idx * 90;
      el.textContent = "0";
      function step(now){
        if(t0 === null) t0 = now + delay;
        var k = Math.min(1, Math.max(0, (now - t0) / dur));
        el.textContent = String(Math.round(to * (1 - Math.pow(1 - k, 3))));
        if(k < 1) requestAnimationFrame(step); else el.textContent = txt;
      }
      requestAnimationFrame(step);
    });
  }
  var toastTimer = null;
  function toast(type, msg){
    st.toast = { type: type, msg: msg }; render();
    clearTimeout(toastTimer); toastTimer = setTimeout(function(){ st.toast = null; render(); }, 3200);
  }
  function updateRules(){
    var box = document.getElementById("rules"); if(!box) return;
    var v = (document.getElementById("in-new") || {}).value || "";
    var rules = { len: v.length >= 8, mix: /[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/.test(v) && /\d/.test(v), num: v.length > 0 && normNum(v) !== st.actNumero };
    Array.prototype.forEach.call(box.querySelectorAll("li"), function(li){ li.classList.toggle("ok", !!rules[li.getAttribute("data-rule")]); });
  }
  function passwordProblem(p, num){
    if(p.length < 8) return "La contraseña debe tener al menos 8 caracteres.";
    if(!/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/.test(p) || !/\d/.test(p)) return "Usa al menos una letra y un número.";
    if(normNum(p) === num) return "Elige una contraseña distinta de tu número de empleado.";
    return "";
  }
  function val(id){ var el = document.getElementById(id); return el ? el.value : ""; }

  // ---------- Acciones ----------
  function submitLogin(){
    if(st.pending) return;
    st.numero = val("in-num").trim();
    var pass = val("in-pass");
    st.error = ""; st.info = "";
    if(!st.numero || !pass){ st.error = "Escribe tu número de empleado y tu contraseña."; render(); return; }
    st.pending = true; render();
    call("colab_login", { p_numero: st.numero, p_password: pass }).then(function(r){
      st.pending = false;
      if(!r.ok){ st.error = r.mensaje || "No se pudo iniciar sesión."; clearPass(); render(); return; }
      if(r.etapa === "activar"){
        st.actToken = r.token; st.actNumero = String(r.numero || normNum(st.numero));
        st.actTotal = (Number(r.minutos) || 10) * 60; st.actUntil = Date.now() + st.actTotal * 1000;
        st.view = "activar"; st.error = ""; render(); startActTimer();
        var n = document.getElementById("in-nombre"); if(n) n.focus();
        return;
      }
      saveToken(r.token); enterPortal();
    }, function(e){ st.pending = false; st.error = e.message; render(); });
  }
  function clearPass(){ var p = document.getElementById("in-pass"); if(p) p.value = ""; }

  var actTimer = null;
  function startActTimer(){
    clearInterval(actTimer);
    actTimer = setInterval(function(){
      if(st.view !== "activar"){ clearInterval(actTimer); return; }
      var left = Math.max(0, Math.round((st.actUntil - Date.now()) / 1000));
      var l = document.getElementById("act-left"), f = document.getElementById("act-fill"), t = document.getElementById("act-timer");
      if(l) l.textContent = mmss(left);
      if(f) f.style.transform = "scaleX(" + (left / st.actTotal).toFixed(3) + ")";
      if(t) t.classList.toggle("low", left < 120);
      if(left <= 0){ cancelActivation("El tiempo para crear tu contraseña terminó. Vuelve a entrar con tu número de empleado."); }
    }, 1000);
  }
  function cancelActivation(msg){
    clearInterval(actTimer);
    st.actToken = null; animated = {}; st.view = "login"; st.pending = false; st.error = msg || ""; st.info = "";
    render();
  }

  function submitActivar(){
    if(st.pending) return;
    var nombre = val("in-nombre"), p1 = val("in-new"), p2 = val("in-new2");
    st.error = "";
    if(!nombre.trim()){ st.error = "Escribe tu nombre completo."; render(); return; }
    var prob = passwordProblem(p1, st.actNumero);
    if(prob){ st.error = prob; render(); return; }
    if(p1 !== p2){ st.error = "Las contraseñas no coinciden."; render(); return; }
    st.pending = true; render();
    call("colab_activar", { p_token: st.actToken, p_nombre: nombre, p_password: p1 }).then(function(r){
      st.pending = false;
      if(!r.ok){
        if(r.error === "sesion" || r.error === "bloqueado" || r.error === "requiere_almacen"){ cancelActivation(r.mensaje); return; }
        st.error = r.mensaje + (r.intentos_restantes != null ? " Te quedan " + r.intentos_restantes + " intento(s)." : "");
        render(); return;
      }
      clearInterval(actTimer); st.actToken = null;
      saveToken(r.token); st.recienActivado = true;
      showWelcome(function(){ enterPortal(); });
    }, function(e){ st.pending = false; st.error = e.message; render(); });
  }
  function showWelcome(done){
    var w = document.createElement("div");
    w.className = "welcome";
    w.innerHTML = '<span class="welcomeCheck"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>' +
      '<b>Contraseña guardada</b><span>A partir de hoy entra con ella; tu número de empleado ya no funciona como contraseña. Falta un paso: tu NIP.</span>';
    document.body.appendChild(w);
    done();
    setTimeout(function(){ w.classList.add("out"); setTimeout(function(){ if(w.parentNode) w.parentNode.removeChild(w); }, 450); }, reduceMotion() ? 900 : 2300);
  }

  function enterPortal(){
    st.view = "portal"; st.error = ""; st.data = null; st.entered = false; st.tab = "activos";
    touch(); render(); load();
  }
  function load(silent){
    if(!st.token) return;
    st.loading = true;
    call("colab_mis_resguardos", { p_token: st.token }).then(function(r){
      st.loading = false;
      if(!r.ok){ sessionEnded(r.mensaje); return; }
      st.data = r; st.error = ""; lastLoad = Date.now();
      var n = r.nip || {};
      if(st.view === "portal" && !silent){
        if(!n.tiene){ openNip("crear", true); return; }                    // sin NIP: se pide antes de entrar
        if(st.recienActivado){ st.recienActivado = false; openNip("cambiar", false, true); return; }
      }
      loadEquipo(true);
      render();
    }, function(e){
      st.loading = false;
      if(silent && st.data){ return; }
      st.error = e.message; render();
    });
  }
  function loadEquipo(silent){
    if(!st.token) return;
    st.equipoLoading = true;
    call("colab_mi_equipo", { p_token: st.token }).then(function(res){
      st.equipoLoading = false;
      if(res && res.ok){
        st.equipoData = res;
      } else {
        st.equipoData = null;
        if(st.tab === "equipo") st.tab = "activos";
      }
      render();
    }).catch(function(){
      st.equipoLoading = false;
      st.equipoData = null;
      if(st.tab === "equipo") st.tab = "activos";
      render();
    });
  }
  function openNip(modo, obligatorio, recienActivado){
    st.nip = { modo: modo, pasos: modo === "crear" ? ["nuevo", "confirmar"] : ["actual", "nuevo", "confirmar"], paso: 0,
               digitos: "", valores: {}, error: "", err: false, pending: false, obligatorio: !!obligatorio, recienActivado: !!recienActivado, listo: false };
    delete animated.nip;
    st.view = "nip"; render();
  }
  function nipRegla(n){
    if(/^(\d)\1{3}$/.test(n)) return "Evita números repetidos como 1111 o 0000.";
    if("0123456789".indexOf(n) >= 0 || "9876543210".indexOf(n) >= 0) return "Evita números seguidos como 1234; son los primeros que alguien intentaría.";
    var num = st.data && st.data.perfil ? String(st.data.perfil.numero_empleado || "") : "";
    if(num && n === num.slice(-4)) return "Tu NIP no puede ser tu número de empleado.";
    return "";
  }
  function nipDots(){
    var f = st.nip, box = document.getElementById("nip-dots"); if(!box) return;
    Array.prototype.forEach.call(box.children, function(d, i){
      var was = d.classList.contains("filled"), now = i < f.digitos.length;
      d.classList.toggle("filled", now); d.classList.remove("err");
      if(now && !was && !reduceMotion()){ d.classList.remove("pop"); void d.offsetWidth; d.classList.add("pop"); }
    });
    box.setAttribute("aria-label", f.digitos.length + " de 4 números");
  }
  function nipShake(msg, volverA){
    var f = st.nip; f.error = msg; f.err = true; f.digitos = "";
    if(volverA != null){ f.paso = volverA; }
    render();
    var box = document.getElementById("nip-dots");
    if(box && !reduceMotion()){ box.classList.remove("shake"); void box.offsetWidth; box.classList.add("shake"); }
    if(navigator.vibrate){ try{ navigator.vibrate(120); }catch(e){} }
  }
  function nipPress(k){
    var f = st.nip; if(!f || f.pending || f.listo || f.digitos.length >= 4) return;
    if(f.err){ f.err = false; }
    f.digitos += k; nipDots();
    if(f.digitos.length < 4) return;
    var paso = f.pasos[f.paso], v = f.digitos;
    setTimeout(function(){
      if(st.nip !== f) return;
      if(paso === "nuevo"){
        var r = nipRegla(v); if(r){ nipShake(r); return; }
        if(f.valores.actual && v === f.valores.actual){ nipShake("El NIP nuevo debe ser distinto del actual."); return; }
      }
      if(paso === "confirmar" && v !== f.valores.nuevo){ nipShake("Los NIP no coinciden. Escribe el nuevo otra vez.", f.pasos.indexOf("nuevo")); return; }
      f.valores[paso] = v; f.digitos = ""; f.error = "";
      if(f.paso < f.pasos.length - 1){ f.paso++; render(); return; }
      nipSubmit();
    }, 160);
  }
  function nipDel(){ var f = st.nip; if(!f || f.pending || !f.digitos) return; f.digitos = f.digitos.slice(0, -1); nipDots(); }
  function nipSubmit(){
    var f = st.nip; f.pending = true; render();
    call("colab_establecer_nip", { p_token: st.token, p_nip_actual: f.valores.actual || null, p_nip_nuevo: f.valores.nuevo }).then(function(r){
      if(st.nip !== f) return;
      f.pending = false;
      if(!r.ok){
        if(r.error === "sesion"){ st.nip = null; sessionEnded(r.mensaje); return; }
        if(r.error === "espera" || r.error === "nip_bloqueado"){ st.nip = null; st.view = "portal"; toast("err", r.mensaje); load(true); return; }
        f.valores = {};
        nipShake(r.mensaje, r.error === "nip_actual" ? 0 : f.pasos.indexOf("nuevo"));
        return;
      }
      f.listo = true; render();
      setTimeout(function(){ if(st.nip !== f) return; st.nip = null; st.view = "portal"; render(); load(true); }, reduceMotion() ? 900 : 2200);
    }, function(e){ if(st.nip !== f) return; f.pending = false; f.valores = {}; nipShake(e.message, 0); });
  }

  function sessionEnded(msg){
    saveToken(null); st.data = null; st.pwModal = null; st.nip = null; animated = {}; st.view = "login"; st.error = ""; st.info = msg || "Tu sesión terminó. Vuelve a iniciar sesión.";
    render();
  }
  function logout(){
    var t = st.token;
    saveToken(null);
    if(t) call("colab_logout", { p_token: t }).catch(function(){});
    st.data = null; st.pwModal = null; st.nip = null; st.recienActivado = false; animated = {}; st.view = "login"; st.error = ""; st.info = "Cerraste sesión."; st.numero = "";
    render();
  }

  function submitPw(){
    var m = st.pwModal; if(!m || m.pending) return;
    var nombre = val("pw-nombre"), actual = val("pw-actual"), n1 = val("pw-new"), n2 = val("pw-new2");
    m.error = "";
    if(!nombre.trim() || !actual){ m.error = "Escribe tu nombre completo y tu contraseña actual."; render(); return; }
    var num = st.data && st.data.perfil ? String(st.data.perfil.numero_empleado || "") : "";
    var prob = passwordProblem(n1, num); if(prob){ m.error = prob; render(); return; }
    if(n1 !== n2){ m.error = "Las contraseñas nuevas no coinciden."; render(); return; }
    if(n1 === actual){ m.error = "La contraseña nueva debe ser distinta de la actual."; render(); return; }
    m.pending = true; render();
    call("colab_cambiar_password", { p_token: st.token, p_nombre: nombre, p_actual: actual, p_nueva: n1 }).then(function(r){
      m.pending = false;
      if(!r.ok){
        if(r.error === "sesion" || r.error === "bloqueado" || r.error === "requiere_almacen"){ st.pwModal = null; sessionEnded(r.mensaje); return; }
        m.error = r.mensaje + (r.intentos_restantes != null ? " Te quedan " + r.intentos_restantes + " intento(s)." : "");
        render(); return;
      }
      st.pwModal = null; toast("ok", "Contraseña actualizada.");
    }, function(e){ m.pending = false; m.error = e.message; render(); });
  }

  function submitAudit(){
    var m = st.auditModal; if(!m || m.pending) return;
    var nota = (val("in-audit-nota") || "").trim();
    var checkedRadio = document.querySelector('input[name="audit-res"]:checked');
    var res = checkedRadio ? checkedRadio.value : m.resultado;
    if(!res){ m.error = "Elige el resultado de la inspección."; render(); return; }
    m.pending = true; render();
    call("colab_registrar_revision", {
      p_token: st.token,
      p_resguardo_id: m.resguardoId,
      p_resultado: res,
      p_nota: nota
    }).then(function(r){
      m.pending = false;
      if(!r.ok){
        if(r.error === "sesion"){ st.auditModal = null; sessionEnded(r.mensaje); return; }
        m.error = r.mensaje || "No se pudo registrar la auditoría."; render(); return;
      }
      st.auditModal = null;
      toast("ok", "Auditoría registrada correctamente.");
      loadEquipo(true);
    }, function(e){
      m.pending = false;
      m.error = e.message;
      render();
    });
  }

  // ---------- Eventos ----------
  document.addEventListener("submit", function(e){
    e.preventDefault();
    var id = e.target && e.target.id;
    if(id === "f-login") submitLogin();
    else if(id === "f-activar") submitActivar();
    else if(id === "f-pw") submitPw();
    else if(id === "f-audit") submitAudit();
  });
  document.addEventListener("input", function(e){
    if(e.target && e.target.id === "in-new") updateRules();
    else if(e.target && e.target.id === "in-search-equipo"){
      st.equipoQuery = e.target.value;
      render();
    }
    touch();
  });
  document.addEventListener("click", function(e){
    var el = e.target.closest ? e.target.closest("[data-action]") : null;
    touch();
    if(!el) return;
    var a = el.getAttribute("data-action");
    if(a === "pw-backdrop"){ if(e.target === el && !(st.pwModal && st.pwModal.pending)){ st.pwModal = null; render(); } return; }
    if(a === "audit-backdrop"){ if(e.target === el && !(st.auditModal && st.auditModal.pending)){ st.auditModal = null; render(); } return; }
    if(a === "eye"){
      var inp = document.getElementById(el.getAttribute("data-for"));
      if(inp){ var show = inp.type === "password"; inp.type = show ? "text" : "password"; el.innerHTML = icon(show ? "eyeOff" : "eye"); el.setAttribute("aria-label", show ? "Ocultar contraseña" : "Mostrar contraseña"); }
      return;
    }
    if(a === "tab"){
      var t = el.getAttribute("data-tab");
      if(t !== st.tab){ st.tab = t; render(); var l = document.getElementById("list"); if(l && !reduceMotion()) l.classList.add("enter"); }
      return;
    }
    if(a === "filtro-equipo"){
      var f = el.getAttribute("data-f");
      if(f && f !== st.equipoFiltro){ st.equipoFiltro = f; render(); }
      return;
    }
    if(a === "toggle-sub"){
      var subId = el.getAttribute("data-id");
      st.expandedSubId = (st.expandedSubId === subId ? null : subId);
      render();
      return;
    }
    if(a === "open-audit"){
      st.auditModal = {
        resguardoId: el.getAttribute("data-id"),
        herramienta: el.getAttribute("data-tool"),
        colaborador: el.getAttribute("data-who"),
        resultado: "bueno",
        nota: "",
        pending: false,
        error: ""
      };
      render();
      return;
    }
    if(a === "close-audit"){ st.auditModal = null; render(); return; }
    if(a === "pin"){ nipPress(el.getAttribute("data-k")); return; }
    if(a === "pin-del"){ nipDel(); return; }
    if(a === "open-nip"){ openNip(st.data && st.data.nip && st.data.nip.tiene ? "cambiar" : "crear", false); return; }
    if(a === "nip-cancel"){ st.nip = null; st.view = "portal"; render(); return; }
    if(a === "logout") logout();
    else if(a === "open-pw"){ st.pwModal = { error: "", pending: false }; render(); var n = document.getElementById("pw-nombre"); if(n) n.focus(); }
    else if(a === "close-pw"){ st.pwModal = null; render(); }
    else if(a === "cancel-act"){ if(st.actToken) call("colab_logout", { p_token: st.actToken }).catch(function(){}); cancelActivation(""); }
    else if(a === "reload"){ st.error = ""; render(); load(); }
  });
  document.addEventListener("keydown", function(e){
    touch();
    if(e.key === "Escape" && st.pwModal && !st.pwModal.pending){ st.pwModal = null; render(); }
    if(st.view === "nip" && st.nip){
      if(/^[0-9]$/.test(e.key)){ e.preventDefault(); nipPress(e.key); }
      else if(e.key === "Backspace"){ e.preventDefault(); nipDel(); }
    }
  });
  // Onda al presionar el botón principal
  document.addEventListener("pointerdown", function(e){
    var b = e.target.closest ? e.target.closest(".btnPrimary,.pinKey") : null;
    if(!b || b.disabled || reduceMotion()) return;
    var rc = b.getBoundingClientRect(), s = Math.max(rc.width, rc.height) * 2.2, sp = document.createElement("span");
    sp.className = "ripple"; sp.style.width = sp.style.height = s + "px";
    sp.style.left = (e.clientX - rc.left - s / 2) + "px"; sp.style.top = (e.clientY - rc.top - s / 2) + "px";
    b.appendChild(sp); setTimeout(function(){ if(sp.parentNode) sp.parentNode.removeChild(sp); }, 650);
  }, { passive: true });

  // Inactividad: se cierra la sesión sola (la base también la vence).
  var lastActivity = Date.now(), lastLoad = 0;
  function touch(){ lastActivity = Date.now(); }
  setInterval(function(){
    if((st.view === "portal" || st.view === "nip") && st.token && Date.now() - lastActivity > IDLE_MIN * 60000){
      logout(); st.info = "Se cerró la sesión por inactividad."; render();
    }
  }, 20000);
  document.addEventListener("visibilitychange", function(){
    if(!document.hidden && st.view === "portal" && st.token && Date.now() - lastLoad > 60000){ load(true); }
  });

  // ---------- Inicio ----------
  (function init(){
    var t = storedToken();
    if(t){ st.token = t; enterPortal(); return; }
    render();
    var n = document.getElementById("in-num"); if(n && !("ontouchstart" in window)) n.focus();
  })();
})();
