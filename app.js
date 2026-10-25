(function(){
  "use strict";
  // GitHub Pages no permite la cabecera frame-ancestors: evitar que otro sitio
  // incruste la app en un iframe para engañar clics (clickjacking).
  if(window.top !== window.self){
    try{ window.top.location = window.self.location.href; }catch(e){}
    document.documentElement.innerHTML = "";
    return;
  }
  var LOGO = "logo.png";
  var employees = [], resguardos = [], tools = [], users = [];
  var formerEmployees = {};   // colaboradores dados de baja (para mostrar su nombre en el historial)
  var ui = {
    tab: "dashboard",
    query: "", tableQuery: "", catQuery: "", empListQuery: "",
    empQuery: "", toolQuery: "",
    currentUser: null,
    loginForm: { username: "", password: "" },   // username = correo electrónico
    loginError: "", loginPending: false,
    booting: true, loading: false, loadError: "", offline: false,
    busy: false, confirmClearLegacy: false, confirmReturnId: null,
    showNewUserModal: false,
    newUserForm: { username: "", password: "", password2: "", rol: "supervisor" },
    newUserError: "",
    form: { employeeId: "", herramienta: "", cantidad: 1, occ: "", idArticulo: "", idArticuloHint: "", idArticuloMatched: false, notas: "", fechaPrestamo: "" },
    showNewEmployeeModal: false,
    empForm: { numero: "", nombre: "", pin: "", pin2: "" },
    editingFechaId: null, editFechaValue: "",
    viewEmployeeToolsId: null,
    authFlow: null,
    cart: [],
    empFormError: "",
    catForm: { nombre: "", idArticulo: "" },
    catFormError: "",
    confirmDeleteEmpId: null,
    confirmDeleteToolId: null,
    pinFlow: null,
    toast: null,
    pageSize: 40,
    visible: { activos: 40, historial: 40, catalogo: 40, empleados: 40, tabla: 40 },
    justStamped: []
  };

  function paginate(list, key){
    var n = ui.visible[key] || ui.pageSize;
    return { shown: list.slice(0, n), total: list.length, hasMore: list.length > n };
  }
  function loadMoreBtn(key, label){
    return '<button type="button" class="link loadMore" data-action="load-more" data-key="'+key+'">'+
      'Cargar más · '+label+'</button>';
  }
  function sortByNombre(arr){
    return arr.slice().sort(function(a,b){ return norm(a.nombre).localeCompare(norm(b.nombre)); });
  }

  function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,7); }
  function todayISO(){ return new Date().toISOString().slice(0,10); }
  function fmt(iso){
    if(!iso) return "—";
    var d = new Date(iso+"T00:00:00");
    return d.toLocaleDateString("es-MX",{day:"2-digit",month:"short",year:"numeric"});
  }
  function fmtShort(iso){
    if(!iso) return "—";
    var d = new Date(iso+"T00:00:00");
    return d.toLocaleDateString("es-MX",{day:"2-digit",month:"2-digit",year:"2-digit"});
  }
  function diasDesde(iso){
    if(!iso) return "—";
    var d = Math.floor((new Date(todayISO()+"T00:00:00") - new Date(iso+"T00:00:00"))/86400000);
    if(d<=0) return "Hoy";
    if(d===1) return "1 día";
    return d.toLocaleString("es-MX")+" días";
  }
  function initials(name){
    return (name||"").trim().split(/\s+/).slice(0,2).map(function(w){return (w[0]||"").toUpperCase();}).join("");
  }
  function norm(s){
    return (s||"").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/\s+/g," ");
  }
  function esc(s){
    return (s==null?"":String(s)).replace(/[&<>"']/g, function(c){
      return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];
    });
  }
  function empName(id){
    for(var i=0;i<employees.length;i++) if(employees[i].id===id) return employees[i];
    return Object.prototype.hasOwnProperty.call(formerEmployees, id) ? formerEmployees[id] : null;
  }
  function avatarColorClass(name){
    var s = name || "";
    var hash = 0;
    for(var i=0;i<s.length;i++){ hash = (hash*31 + s.charCodeAt(i)) % 5; }
    if(hash<0) hash += 5;
    return "c" + hash;
  }

  // Datos del navegador de la versión anterior (solo se leen para exportar un respaldo).
  var LEGACY_STORAGE_KEY = "citrojugo_resguardos_offline_v1";
  var SESSION_KEY = "citrojugo_sesion_v2";

  // =====================================================================
  //  Backend: Supabase (Postgres + Auth + RLS) vía REST, sin librerías.
  //  La seguridad vive en la base de datos (supabase/schema.sql); aquí
  //  solo se llama a la API con la clave pública "anon" + la sesión.
  // =====================================================================
  var CFG = window.CITROJUGO_CONFIG || {};
  var API_URL = String(CFG.supabaseUrl || "").replace(/\/+$/, "");
  var API_KEY = String(CFG.supabaseAnonKey || "");
  var IDLE_MIN = Number(CFG.inactividadMinutos) > 0 ? Number(CFG.inactividadMinutos) : 30;
  var PAGE_ROWS = 1000;               // máximo de filas por petición (límite por defecto de Supabase)

  function configOk(){
    return /^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(API_URL) && API_KEY.length > 30 &&
      API_URL.indexOf("TU-PROYECTO") < 0 && API_KEY.indexOf("PEGA_AQUI") < 0;
  }

  function ApiError(message, opts){
    opts = opts || {};
    this.name = "ApiError"; this.message = message;
    this.status = opts.status || 0; this.code = opts.code || ""; this.hint = opts.hint || "";
    this.network = !!opts.network; this.isApi = true;
  }
  ApiError.prototype = Object.create(Error.prototype);

  function apiErrorFrom(status, data){
    data = data || {};
    var code = String(data.code || data.error_code || data.error || "");
    var msg = data.message || data.msg || data.error_description || "";
    if(status === 429 || code === "over_request_rate_limit" || code === "over_email_send_rate_limit"){
      msg = "Demasiados intentos. Espera unos minutos e inténtalo de nuevo.";
    } else if(code === "invalid_credentials" || code === "invalid_grant" && /credential/i.test(msg)){
      msg = "Correo o contraseña incorrectos.";
    } else if(code === "email_not_confirmed"){
      msg = "Esta cuenta no ha confirmado su correo. Pide al administrador que la confirme en Supabase.";
    } else if(code === "PGRST301" || code === "PGRST303" || (status === 401 && !msg)){
      msg = "Tu sesión expiró. Vuelve a iniciar sesión.";
    } else if(!msg || status >= 500){
      msg = status >= 500 ? "El servidor no respondió correctamente. Intenta de nuevo en un momento." : "No se pudo completar la operación.";
    }
    return new ApiError(String(msg).slice(0, 300), {status: status, code: code, hint: data.hint || ""});
  }

  function http(method, path, opts){
    opts = opts || {};
    if(!configOk()) return Promise.reject(new ApiError("La aplicación no está configurada (config.js)."));
    var headers = { "apikey": API_KEY };
    if(opts.token) headers["Authorization"] = "Bearer " + opts.token;
    if(opts.body !== undefined) headers["Content-Type"] = "application/json";
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function(){ if(ctrl) ctrl.abort(); }, opts.timeout || 25000);
    return fetch(API_URL + path, {
      method: method, headers: headers, signal: ctrl ? ctrl.signal : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", mode: "cors"
    }).then(function(res){
      return res.text().then(function(txt){
        var data = null;
        try{ data = txt ? JSON.parse(txt) : null; }catch(e){ data = null; }
        if(!res.ok) throw apiErrorFrom(res.status, data);
        return data;
      });
    }, function(err){
      var aborted = err && err.name === "AbortError";
      throw new ApiError(aborted ? "El servidor tardó demasiado en responder. Revisa tu conexión e intenta de nuevo."
                                 : "Sin conexión con el servidor. Revisa tu internet e intenta de nuevo.", {network: true});
    }).then(function(d){ clearTimeout(timer); return d; }, function(e){ clearTimeout(timer); throw e; });
  }

  // ---------- Sesión (Supabase Auth: correo + contraseña) ----------
  var session = null;            // {access_token, refresh_token, expires_at}
  var refreshTimer = null, refreshing = null;

  function storeSession(s){
    session = s ? { access_token: s.access_token, refresh_token: s.refresh_token,
                    user_id: (s.user && s.user.id) ? String(s.user.id) : (session && session.user_id) || "",
                    expires_at: s.expires_at || (Math.floor(Date.now()/1000) + (s.expires_in || 3600)) } : null;
    // Solo el refresh token, y en sessionStorage: se borra al cerrar el navegador.
    try{
      if(session) sessionStorage.setItem(SESSION_KEY, JSON.stringify({ refresh_token: session.refresh_token }));
      else sessionStorage.removeItem(SESSION_KEY);
    }catch(e){}
    clearTimeout(refreshTimer);
    if(session){
      var ms = Math.max(10000, (session.expires_at - 60) * 1000 - Date.now());
      refreshTimer = setTimeout(function(){ refreshSession().catch(function(){}); }, ms);
    }
  }
  function authPassword(email, password){
    return http("POST", "/auth/v1/token?grant_type=password", { body: { email: email, password: password } });
  }
  function refreshSession(){
    if(refreshing) return refreshing;
    var rt = session && session.refresh_token;
    if(!rt){ try{ rt = (JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null") || {}).refresh_token; }catch(e){ rt = null; } }
    if(!rt) return Promise.reject(new ApiError("Sin sesión.", {status: 401}));
    refreshing = http("POST", "/auth/v1/token?grant_type=refresh_token", { body: { refresh_token: rt } })
      .then(function(s){ refreshing = null; storeSession(s); return s; },
            function(e){ refreshing = null; if(!e.network) storeSession(null); throw e; });
    return refreshing;
  }
  function authSignOut(token){
    return http("POST", "/auth/v1/logout?scope=local", { token: token, timeout: 8000 }).catch(function(){});
  }
  // Petición con la sesión actual; si el token caducó, se renueva una vez.
  function authed(method, path, body){
    if(!session) return Promise.reject(new ApiError("Tu sesión expiró. Vuelve a iniciar sesión.", {status: 401}));
    var go = function(){ return http(method, path, { token: session.access_token, body: body }); };
    var pre = (session.expires_at - 30) * 1000 < Date.now() ? refreshSession() : Promise.resolve();
    return pre.then(go).catch(function(e){
      if(e.status === 401 && !e.network){
        return refreshSession().then(go, function(e2){ onSessionLost(); throw e2; });
      }
      throw e;
    });
  }
  function rpc(fn, args, token){
    if(token) return http("POST", "/rest/v1/rpc/" + fn, { token: token, body: args || {} });
    return authed("POST", "/rest/v1/rpc/" + fn, args || {});
  }
  function selectAll(table, columns, order){
    var out = [];
    function page(offset){
      return authed("GET", "/rest/v1/" + table + "?select=" + encodeURIComponent(columns) +
        "&order=" + encodeURIComponent(order) + "&limit=" + PAGE_ROWS + "&offset=" + offset)
        .then(function(rows){
          rows = Array.isArray(rows) ? rows : [];
          out = out.concat(rows);
          return rows.length === PAGE_ROWS ? page(offset + PAGE_ROWS) : out;
        });
    }
    return page(0);
  }

  // Autorización de supervisor/admin: se abre una sesión TEMPORAL con su
  // correo y contraseña, se llama la función con ESE token (la base valida
  // rol y que la contraseña se escribió hace segundos) y se cierra.
  function withSupervisor(email, password, fn){
    return authPassword(email, password).then(function(tmp){
      return Promise.resolve().then(function(){ return fn(tmp.access_token, tmp.user || {}); })
        .then(function(r){ authSignOut(tmp.access_token); return r; },
              function(e){ authSignOut(tmp.access_token); throw e; });
    });
  }

  function newRequestId(){
    if(window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = Array.prototype.map.call(b, function(x){ return ("0"+x.toString(16)).slice(-2); }).join("");
    return h.slice(0,8)+"-"+h.slice(8,12)+"-"+h.slice(12,16)+"-"+h.slice(16,20)+"-"+h.slice(20);
  }

  // ---------- Mapeo servidor → modelo que usan las plantillas ----------
  // Los ids que vienen del servidor se insertan en atributos data-id: se
  // aceptan solo UUID (defensa en profundidad contra inyección de HTML).
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function okId(row){ return row && UUID_RE.test(String(row.id)); }
  function isoDate(v){ return (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) ? v : ""; }
  function mapEmployee(c){ return { id: String(c.id), numero: String(c.numero_empleado || ""), nombre: String(c.nombre || ""), area: String(c.area || ""), puesto: String(c.puesto || ""), activo: c.activo !== false, nipPendiente: !!c.nip_pendiente }; }
  function normNum(s){ return String(s || "").replace(/\s+/g, "").toUpperCase(); }
  // "Nombre · #123" para mostrar al colaborador con su número de empleado.
  function empLabel(emp){ return emp ? emp.nombre + (emp.numero ? " · #" + emp.numero : "") : ""; }
  function empMatches(emp, q){
    if(!emp) return false;
    var n = norm(q), u = normNum(q);
    return norm(emp.nombre).indexOf(n) >= 0 || (!!u && !!emp.numero && emp.numero.indexOf(u) >= 0);
  }
  function mapTool(t){ return { id: String(t.id), nombre: String(t.nombre || ""), idArticulo: String(t.id_articulo || "") }; }
  function mapResguardo(r){
    return {
      id: String(r.id), grupoId: r.grupo_id ? String(r.grupo_id) : "", employeeId: String(r.colaborador_id),
      herramienta: String(r.herramienta || ""), cantidad: Math.max(1, parseInt(r.cantidad, 10) || 1),
      occ: String(r.occ || ""), idArticulo: String(r.id_articulo || ""),
      fechaPrestamo: isoDate(r.fecha_prestamo), fechaDevolucion: isoDate(r.fecha_devolucion),
      estado: r.estado === "devuelto" ? "devuelto" : "activo", notas: String(r.notas || ""),
      creadoPor: String(r.creado_por || ""), devueltoPor: String(r.devuelto_por || ""),
      creadoEn: String(r.creado_en || "")
    };
  }
  function mapUser(p){
    var rol = (p.rol === "admin" || p.rol === "supervisor") ? p.rol : "almacen";
    return { id: String(p.id), email: String(p.email || ""), username: String(p.nombre || p.email || ""), rol: rol, activo: p.activo ? 1 : 0 };
  }
  function upsertResguardo(r){
    if(!UUID_RE.test(r.id)) return;
    for(var i=0;i<resguardos.length;i++){ if(resguardos[i].id === r.id){ resguardos[i] = r; return; } }
    resguardos.unshift(r);
  }

  var RES_COLS = "id,grupo_id,colaborador_id,herramienta,cantidad,occ,id_articulo,fecha_prestamo,fecha_devolucion,estado,notas,creado_por,devuelto_por,creado_en";
  var lastLoadAt = 0;

  // Carga completa (paginada de 1000 en 1000). Con ~5 mil resguardos son
  // ~1 MB y permite que búsqueda, filtros y gráficas sigan siendo instantáneos.
  function loadData(opts){
    opts = opts || {};
    if(!opts.silent){ ui.loading = true; ui.loadError = ""; render(); }
    return Promise.all([
      selectAll("colaboradores", "id,numero_empleado,nombre,area,puesto,activo,nip_pendiente", "nombre.asc,id.asc"),
      selectAll("herramientas", "id,nombre,id_articulo", "nombre.asc,id.asc"),
      selectAll("resguardos", RES_COLS, "creado_en.desc,id.desc"),
      ui.currentUser && ui.currentUser.rol === "admin" ? selectAll("perfiles", "id,email,nombre,rol,activo", "email.asc") : Promise.resolve(null)
    ]).then(function(res){
      var all = res[0].filter(okId).map(mapEmployee);
      employees = all.filter(function(e){ return e.activo; });
      formerEmployees = {};
      all.forEach(function(e){ if(!e.activo) formerEmployees[e.id] = e; });
      tools = res[1].filter(okId).map(mapTool);
      resguardos = res[2].filter(function(r){ return okId(r) && UUID_RE.test(String(r.colaborador_id)); }).map(mapResguardo);
      if(res[3]) users = res[3].filter(okId).map(mapUser);
      lastLoadAt = Date.now();
      ui.loading = false; ui.loadError = ""; ui.offline = false;
      render();
    }, function(e){
      ui.loading = false;
      if(e.status === 401 || !session){ onSessionLost(); return; }
      if(opts.silent){
        if(e.network && !ui.offline){ ui.offline = true; toast("err", "Sin conexión. Los datos en pantalla pueden no estar al día."); }
        return;
      }
      ui.loadError = e.message;
      render();
    });
  }

  function loadProfile(){
    var uidSes = session && session.user_id;
    if(!uidSes || !UUID_RE.test(uidSes)) return Promise.reject(new ApiError("No se pudo identificar tu cuenta. Vuelve a iniciar sesión.", {status: 401}));
    // Filtrar por id: un admin puede leer todos los perfiles (RLS) y sin filtro llegaría otro.
    return authed("GET", "/rest/v1/perfiles?select=id,email,nombre,rol,activo&id=eq." + uidSes + "&limit=1").then(function(rows){
      var p = Array.isArray(rows) ? rows[0] : null;
      if(!p) throw new ApiError("Tu cuenta no tiene perfil. Pide al administrador que revise la configuración.");
      if(!p.activo) throw new ApiError("Tu cuenta todavía no está activa. Pide a un administrador que la active.", {code: "inactive"});
      var u = mapUser(p);
      ui.currentUser = { id: u.id, username: u.username, email: u.email, rol: u.rol };
      return u;
    });
  }

  function onSessionLost(msg){
    var had = !!ui.currentUser;
    storeSession(null);
    clearPrivateState();
    ui.currentUser = null; ui.loading = false; ui.loadError = "";
    ui.loginError = msg || (had ? "Tu sesión terminó. Vuelve a iniciar sesión." : "");
    render();
  }
  function clearPrivateState(){
    employees = []; resguardos = []; tools = []; users = []; formerEmployees = {};
    ui.pinFlow = null; ui.authFlow = null; ui.cart = []; ui.viewEmployeeToolsId = null;
    ui.showNewEmployeeModal = false; ui.showNewUserModal = false;
    ui.form = { employeeId: "", herramienta: "", cantidad: 1, occ: "", idArticulo: "", idArticuloHint: "", idArticuloMatched: false, notas: "", fechaPrestamo: "" };
    ui.empQuery = ""; ui.toolQuery = ""; ui.query = ""; ui.tableQuery = ""; ui.catQuery = ""; ui.empListQuery = "";
  }

  // ---------- Respaldo de la versión anterior (localStorage de esta PC) ----------
  function legacyRaw(){ try{ return localStorage.getItem(LEGACY_STORAGE_KEY); }catch(e){ return null; } }
  function hasLegacyData(){ var r = legacyRaw(); return !!(r && r.length > 2); }
  function exportLegacyData(){
    var raw = legacyRaw();
    if(!raw){ toast("err", "No hay datos de la versión anterior en este navegador."); return; }
    var data;
    try{ data = JSON.parse(raw); }catch(e){ toast("err", "Los datos guardados están dañados; no se pudieron exportar."); return; }
    var payload = { formato: "citrojugo-resguardos-localstorage", version: 1, exportado: new Date().toISOString(),
      employees: data.employees || [], tools: data.tools || [], resguardos: data.resguardos || [] };
    var blob = new Blob([JSON.stringify(payload, null, 1)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = "respaldo-resguardos-" + todayISO() + ".json";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function(){ URL.revokeObjectURL(url); }, 4000);
    toast("ok", "Respaldo descargado. Contiene NIPs: guárdalo en un lugar seguro y bórralo después de migrar.");
  }
  function clearLegacyData(){
    try{ localStorage.removeItem(LEGACY_STORAGE_KEY); }catch(e){}
    ui.confirmClearLegacy = false;
    toast("ok", "Se borraron los datos de la versión anterior de este navegador.");
  }

  // ---------- Limitador de intentos en pantalla (disuasivo; el límite real lo aplica Supabase Auth) ----------
  var pwFails = 0, pwLockUntil = 0;
  function pwLocked(){
    if(Date.now() < pwLockUntil) return "Demasiados intentos. Espera " + Math.ceil((pwLockUntil - Date.now())/1000) + " s.";
    return "";
  }
  function pwFailed(){ pwFails++; if(pwFails >= 5){ pwLockUntil = Date.now() + 30000 * Math.pow(2, Math.min(pwFails - 5, 5)); } }
  function pwOk(){ pwFails = 0; pwLockUntil = 0; }

  var toastTimer = null, toastLeaveTimer = null;
  function toast(type, msg){
    clearTimeout(toastTimer); clearTimeout(toastLeaveTimer);
    ui.toast = {type:type, msg:msg, fresh:true};
    render();
    ui.toast.fresh = false;
    toastTimer = setTimeout(function(){
      var el = document.querySelector(".toast");
      if(el){ el.classList.remove("enter"); el.classList.add("leaving"); }
      toastLeaveTimer = setTimeout(function(){ ui.toast=null; render(); }, 170);
    }, 2800);
  }

  function icon(name){
    var icons = {
      search: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
      trash: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
      lock: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
      x: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
      del: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"/><line x1="18" y1="9" x2="12" y2="15"/><line x1="12" y1="9" x2="18" y2="15"/></svg>',
      check: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
      pencil: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
      plus: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
      logout: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
      arrow: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>',
      undo: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>',
      nav_dashboard: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
      nav_activos: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
      nav_nuevo: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>',
      nav_catalogo: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><line x1="12" y1="13" x2="12" y2="21"/></svg>',
      nav_empleados: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
      nav_historial: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><polyline points="3 3 3 8 8 8"/><polyline points="12 7 12 12 15 14"/></svg>',
      nav_tabla: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="10" y1="10" x2="10" y2="20"/></svg>',
      nav_usuarios: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3z"/><polyline points="9 12 11 14 15 10"/></svg>',
      chevron: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>',
      alert: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'
    };
    return icons[name] || "";
  }

  // ---------- Derived data ----------
  function getActivos(){ return resguardos.filter(function(r){return r.estado==="activo";}); }
  function getDevueltos(){
    return resguardos.filter(function(r){return r.estado==="devuelto";})
      .sort(function(a,b){ return (b.fechaDevolucion||"").localeCompare(a.fechaDevolucion||""); });
  }
  function getAllSorted(){
    return resguardos.slice().sort(function(a,b){ return (b.fechaPrestamo||"").localeCompare(a.fechaPrestamo||""); });
  }
  function filterByQuery(list, q){
    if(!q.trim()) return list;
    var n = norm(q);
    return list.filter(function(r){
      var emp = empName(r.employeeId);
      return norm(r.herramienta).indexOf(n)>=0 || empMatches(emp, q);
    });
  }

  // ---------- Templates ----------
  function sidebarTpl(){
    var activos = getActivos().length;
    var tabs = [
      {id:"dashboard", label:"Resumen"},
      {id:"activos", label:"Activos", badge:activos},
      {id:"nuevo", label:"Nuevo resguardo"},
      {id:"catalogo", label:"Catálogo", badge:tools.length},
      {id:"empleados", label:"Colaboradores", badge:employees.length},
      {id:"historial", label:"Historial"},
      {id:"tabla", label:"Tabla completa"}
    ];
    if(ui.currentUser && ui.currentUser.rol === "admin"){
      tabs.push({id:"usuarios", label:"Usuarios", badge:users.length});
    }
    return '' +
    '<div class="brandBlock">' +
      '<div class="brandRow"><img src="'+LOGO+'" alt="Citrojugo"/>' +
        '<div><div class="brandEyebrow">Citrojugo</div><div class="brandTitle">Resguardo de herramienta</div></div>' +
        '<button type="button" class="logoutBtn mobileLogout" data-action="logout" title="Cerrar sesión" aria-label="Cerrar sesión">'+icon("logout")+'</button>' +
      '</div>' +
      '<div class="subtitle">Registro y autorización con NIP</div>' +
    '</div>' +
    '<div class="navList">' + tabs.map(function(t, i){
      var active = ui.tab===t.id ? " active" : "";
      var badge = t.badge ? '<span class="badge">'+t.badge.toLocaleString("es-MX")+'</span>' : "";
      var section = i===3 ? '<div class="navSection">Registros</div>' : (t.id==="usuarios" ? '<div class="navSection">Administración</div>' : "");
      return section + '<button class="navBtn'+active+'"'+(active?' aria-current="page"':'')+' data-action="set-tab" data-tab="'+t.id+'">' +
        '<span class="navIco" aria-hidden="true">'+icon("nav_"+t.id)+'</span><span class="navLabel">'+esc(t.label)+'</span>'+badge+'</button>';
    }).join("") + '</div>' +
    '<div class="sidebarFooter"><div class="userRow">' +
      '<div class="avatar avatarLg">'+esc(initials(ui.currentUser?ui.currentUser.username:""))+'</div>' +
      '<div style="min-width:0;"><div class="userName">'+esc(ui.currentUser?ui.currentUser.username:"")+'</div>' +
      '<div class="userRole">'+esc(ui.currentUser?(ROL_LABEL[ui.currentUser.rol]||ui.currentUser.rol):"")+'</div></div>' +
      '<button type="button" class="logoutBtn" data-action="logout" title="Cerrar sesión" aria-label="Cerrar sesión">'+icon("logout")+'</button>' +
    '</div></div>';
  }

  function dashboardTpl(){
    var activos = getActivos(), devueltos = getDevueltos(), all = getAllSorted();
    var toolCounts = {};
    resguardos.forEach(function(r){ toolCounts[r.herramienta] = (toolCounts[r.herramienta]||0)+1; });
    var topTools = Object.keys(toolCounts).sort(function(a,b){return toolCounts[b]-toolCounts[a];}).slice(0,6);
    var maxTool = topTools.length ? toolCounts[topTools[0]] : 1;

    var empCounts = {};
    activos.forEach(function(r){ empCounts[r.employeeId] = (empCounts[r.employeeId]||0)+1; });
    var topEmpIds = Object.keys(empCounts).sort(function(a,b){return empCounts[b]-empCounts[a];}).slice(0,6);
    var maxEmp = topEmpIds.length ? empCounts[topEmpIds[0]] : 1;
    var barColors = ["var(--tint)"], barColorsEmp = ["#5E9A2C"];

    var monthCounts = {}, monthOrder = [];
    resguardos.forEach(function(r){
      if(!r.fechaPrestamo) return;
      var key = r.fechaPrestamo.slice(0,7);
      if(!(key in monthCounts)){ monthCounts[key]=0; monthOrder.push(key); }
      monthCounts[key]++;
    });
    monthOrder.sort();
    var lastMonths = monthOrder.slice(-8);
    var maxMonth = lastMonths.length ? Math.max.apply(null, lastMonths.map(function(k){return monthCounts[k];})) : 1;
    var monthNames = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];

    var recent = all.slice(0,6);

    var html = '<div class="metricGrid">' +
      '<div class="metric m-lime"><div class="metricLabel">Resguardos activos</div><div class="metricValue">'+activos.length.toLocaleString("es-MX")+'</div></div>' +
      '<div class="metric m-amber"><div class="metricLabel">Devueltos</div><div class="metricValue">'+devueltos.length.toLocaleString("es-MX")+'</div></div>' +
      '<div class="metric m-teal"><div class="metricLabel">Colaboradores</div><div class="metricValue">'+employees.length.toLocaleString("es-MX")+'</div></div>' +
      '<div class="metric m-plum"><div class="metricLabel">Catálogo</div><div class="metricValue">'+tools.length.toLocaleString("es-MX")+'</div></div>' +
    '</div>';

    html += '<div class="chartsRow">';

    html += '<div class="dashBlock d-amber"><div class="dashHead">Herramientas más prestadas</div>';
    if(topTools.length===0){ html += '<p class="emptyInline">Aún no hay resguardos registrados.</p>'; }
    else {
      html += '<div class="barChart">' + topTools.map(function(name, i){
        var v = toolCounts[name];
        var pct = Math.max(6, Math.round(v/maxTool*100));
        return '<div class="barRow"><div class="barLabel" title="'+esc(name)+'">'+esc(name)+'</div>' +
          '<div class="barTrack"><div class="barFill" style="width:'+pct+'%;background:'+barColors[0]+'"></div></div>' +
          '<div class="barValue">'+v+'</div></div>';
      }).join("") + '</div>';
    }
    html += '</div>';

    html += '<div class="dashBlock d-plum"><div class="dashHead">Colaboradores con más herramienta en resguardo</div>';
    if(topEmpIds.length===0){ html += '<p class="emptyInline">Nadie tiene herramienta en resguardo por ahora.</p>'; }
    else {
      html += '<div class="barChart">' + topEmpIds.map(function(id, i){
        var emp = empName(id);
        var v = empCounts[id];
        var pct = Math.max(6, Math.round(v/maxEmp*100));
        var name = emp ? emp.nombre : "Colaborador eliminado";
        return '<div class="barRow"><div class="barLabel" title="'+esc(name)+'">'+esc(name)+'</div>' +
          '<div class="barTrack"><div class="barFill" style="width:'+pct+'%;background:'+barColorsEmp[0]+'"></div></div>' +
          '<div class="barValue">'+v+'</div></div>';
      }).join("") + '</div>';
    }
    html += '</div>';

    html += '</div>';

    html += '<div class="dashBlock d-teal"><div class="dashHead">Resguardos registrados por mes</div>';
    if(lastMonths.length===0){ html += '<p class="emptyInline">Sin datos de fecha todavía.</p>'; }
    else {
      html += '<div class="trendChart">' + lastMonths.map(function(key, mi){
        var v = monthCounts[key];
        var pct = Math.max(4, Math.round(v/maxMonth*100));
        var parts = key.split("-");
        var label = monthNames[parseInt(parts[1],10)-1]+" "+parts[0].slice(2);
        return '<div class="trendCol'+(mi===lastMonths.length-1?' last':'')+'"><div class="trendValue">'+v+'</div>' +
          '<div class="trendBar" style="height:'+pct+'%"></div>' +
          '<div class="trendLabel">'+label+'</div></div>';
      }).join("") + '</div>';
    }
    html += '</div>';

    html += '<div class="dashBlock"><div class="dashHead">Actividad reciente</div>';
    if(recent.length===0){ html += '<p class="emptyInline">Sin movimientos todavía.</p>'; }
    else {
      recent.forEach(function(r){
        var emp = empName(r.employeeId);
        html += '<div class="recentRow"><div class="avatar avatarLg '+(emp?avatarColorClass(emp.nombre):"")+'">'+(emp?esc(initials(emp.nombre)):"?")+'</div><div class="recentMain">' +
          '<div class="recentTitle">'+esc(r.herramienta)+'</div>' +
          '<div class="recentSub">'+(emp?esc(emp.nombre):"—")+' · '+fmtShort(r.fechaPrestamo)+'</div>' +
          '</div><span class="statusChip '+r.estado+'">'+(r.estado==="activo"?"Activo":"Devuelto")+'</span></div>';
      });
    }
    html += '</div>';
    return html;
  }

  function resguardoCardTpl(r){
    var emp = empName(r.employeeId);
    var tagsHtml = "";
    if(r.occ || r.idArticulo){
      tagsHtml = '<div class="tagsRow">';
      if(r.occ) tagsHtml += '<span class="tag tag-occ">OCC '+esc(r.occ)+'</span>';
      if(r.idArticulo) tagsHtml += '<span class="tag tag-id">ID '+esc(r.idArticulo)+'</span>';
      tagsHtml += '</div>';
    }
    return '' +
    '<div class="resCard '+r.estado+(renderStamp[r.id]?' stamped':'')+'">' +
      '<div class="resTop">' +
        '<div style="min-width:0;"><div class="resTitle">'+esc(r.herramienta)+(r.cantidad>1?'<span class="qty">×'+r.cantidad+'</span>':'')+'</div></div>' +
        '<span class="pill '+r.estado+'">'+(r.estado==="activo"?"Activo":"Devuelto")+'</span>' +
      '</div>' +
      '<div class="empRow"><div class="avatar '+(emp?avatarColorClass(emp.nombre):"")+'">'+(emp?esc(initials(emp.nombre)):"?")+'</div>' +
        '<span style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+(emp?esc(emp.nombre):"Colaborador eliminado")+'</span>' +
        (emp && emp.numero ? '<span class="code" style="font-size:12px;color:var(--hint);white-space:nowrap;">#'+esc(emp.numero)+'</span>' : '') +
      '</div>' +
      '<div class="datesGrid"><div>Fecha de entrega<b>'+
        (ui.editingFechaId===r.id ?
          '<span class="dateEdit"><input type="date" id="input-edit-fecha-'+r.id+'" value="'+esc(ui.editFechaValue)+'" max="'+todayISO()+'"/>' +
          '<button type="button" class="link iconBtn ok" data-action="edit-fecha-save" data-id="'+r.id+'" title="Guardar fecha" aria-label="Guardar fecha">'+icon("check")+'</button>' +
          '<button type="button" class="link iconBtn" data-action="edit-fecha-cancel" title="Cancelar" aria-label="Cancelar">'+icon("x")+'</button></span>'
          : fmt(r.fechaPrestamo)+' <button type="button" class="link iconBtn" data-action="edit-fecha-start" data-id="'+r.id+'" title="Cambiar fecha" aria-label="Cambiar fecha de entrega">'+icon("pencil")+'</button>') +
      '</b></div>'+(r.estado==="activo"
        ? '<div>En resguardo<b>'+diasDesde(r.fechaPrestamo)+'</b></div>'
        : '<div>Devuelto<b>'+fmt(r.fechaDevolucion)+'</b></div>')+'</div>' +
      tagsHtml +
      (r.notas ? '<p class="notas">“'+esc(r.notas)+'”</p>' : '') +
      (r.creadoPor ? '<p class="meta">Autorizó: '+esc(r.creadoPor)+(r.devueltoPor?' · Devolvió: '+esc(r.devueltoPor):'')+'</p>' : '') +
      (r.estado==="activo" ? (ui.confirmReturnId===r.id ?
        '<div class="confirmBox" style="margin:auto 0 0;"><p>¿Registrar la devolución de <b>'+esc(r.herramienta)+'</b>? Quedará a tu nombre en la bitácora.</p>' +
          '<div class="confirmActions"><button class="confirmYes" data-action="devolver-confirm" data-id="'+r.id+'"'+(ui.busy?' disabled':'')+'>'+(ui.busy?'Guardando…':'Sí, devolver')+'</button>' +
          '<button class="confirmNo" data-action="devolver-cancel">Cancelar</button></div></div>'
        : '<div class="cardFoot" style="margin-top:auto;"><button class="btnOutline" data-action="devolver" data-id="'+r.id+'">'+icon("undo")+' Marcar devolución</button></div>') : '') +
    '</div>';
  }

  function activosTpl(){
    var full = filterByQuery(getActivos(), ui.query);
    var page = paginate(full, "activos");
    var html = '<div class="searchWrap" style="max-width:480px;"><span class="searchIcon">'+icon("search")+'</span>' +
      '<input type="text" id="input-search-activos" placeholder="Buscar colaborador, número de empleado o herramienta" value="'+esc(ui.query)+'"/></div>';
    if(full.length===0){
      html += '<div class="empty">' + (getActivos().length===0 ? 'No hay resguardos activos.<br/><button class="link" data-action="set-tab" data-tab="nuevo">Registrar el primero '+icon("arrow")+'</button>' : 'Sin resultados para tu búsqueda.') + '</div>';
    } else {
      html += '<div class="cardGrid">';
      page.shown.forEach(function(r){ html += resguardoCardTpl(r); });
      html += '</div>';
      html += '<p class="hint center" style="margin-top:4px;">Mostrando '+page.shown.length+' de '+page.total+'</p>';
      if(page.hasMore) html += loadMoreBtn("activos", (page.total-page.shown.length)+' restantes');
    }
    return html;
  }

  function historialTpl(){
    var full = filterByQuery(getDevueltos(), ui.query);
    var page = paginate(full, "historial");
    var html = '<div class="searchWrap" style="max-width:480px;"><span class="searchIcon">'+icon("search")+'</span>' +
      '<input type="text" id="input-search-historial" placeholder="Buscar colaborador, número de empleado o herramienta" value="'+esc(ui.query)+'"/></div>';
    if(full.length===0){ html += '<div class="empty">Sin devoluciones registradas todavía.</div>'; }
    else {
      html += '<div class="cardGrid">';
      page.shown.forEach(function(r){ html += resguardoCardTpl(r); });
      html += '</div>';
      html += '<p class="hint center" style="margin-top:4px;">Mostrando '+page.shown.length+' de '+page.total+'</p>';
      if(page.hasMore) html += loadMoreBtn("historial", (page.total-page.shown.length)+' restantes');
    }
    return html;
  }

  function nuevoTpl(){
    if(employees.length===0){
      return '<div class="empty">Primero registra al menos un colaborador.<br/>' +
        '<button class="link" data-action="set-tab" data-tab="empleados">Ir a Colaboradores '+icon("arrow")+'</button></div>';
    }
    var cartHtml = "";
    if(ui.cart.length){
      cartHtml = '<div class="cartBox">' +
        '<div class="cartHead"><span>Herramienta en este resguardo</span><span aria-label="'+ui.cart.length+' en la lista">'+ui.cart.length+'</span></div>' +
        ui.cart.map(function(c){
          var sub = [];
          if(c.idArticulo) sub.push('ID '+esc(c.idArticulo));
          if(c.occ) sub.push('OCC '+esc(c.occ));
          return '<div class="toolRow"><span style="min-width:0;"><b style="font-weight:600;">'+esc(c.herramienta)+'</b> <span class="qty">×'+c.cantidad+'</span>' +
            (sub.length ? '<span class="sub code">'+sub.join(' · ')+'</span>' : '') +
            '</span><button type="button" class="deleteBtn" data-action="cart-remove" data-id="'+c.tempId+'" title="Quitar de la lista" aria-label="Quitar de la lista">'+icon("trash")+'</button></div>';
        }).join("") +
      '</div>';
    }
    return '' +
    '<form id="form-new-resguardo">' +
      '<p class="sectionTitle">Colaborador</p>' +
      '<div class="formGroup"><div class="field"><label for="input-emp-query">Número de empleado o nombre completo</label>' +
        '<input type="text" id="input-emp-query" autocomplete="off" placeholder="Ej. 1234 o nombre completo del colaborador" value="'+esc(ui.empQuery)+'"/>' +
        '<p class="hint">Escribe el número de empleado o el nombre tal como está registrado. Se valida al autorizar el resguardo.</p>' +
      '</div></div>' +
      cartHtml +
      '<p class="sectionTitle">Agregar herramienta</p>' +
      '<div class="formGroup">' +
      '<div class="field"><label for="input-idarticulo">ID de artículo</label><input type="text" id="input-idarticulo" autocomplete="off" placeholder="Opcional — si existe en el catálogo, se vincula solo" value="'+esc(ui.form.idArticulo)+'" style="font-family:var(--mono)"/>' +
        (ui.form.idArticuloHint ? '<p class="hint" style="color:'+(ui.form.idArticuloMatched?'var(--limeDark)':'var(--hint)')+'">'+esc(ui.form.idArticuloHint)+'</p>' : '') +
      '</div>' +
      '<div class="field"><label for="input-tool-query">Herramienta</label>' +
        '<input type="text" id="input-tool-query" autocomplete="off" placeholder="Escribe el nombre y presiona Enter para agregarla" value="'+esc(ui.toolQuery)+'"/>' +
        '<p class="hint">Presiona Enter para agregarla a la lista de este resguardo. Si no existe, se agregará como nueva al catálogo.</p>' +
      '</div>' +
      '<div class="row2">' +
        '<div class="field"><label for="input-cantidad">Cantidad</label><input type="number" min="1" id="input-cantidad" value="'+esc(ui.form.cantidad)+'"/></div>' +
        '<div class="field"><label for="input-occ">OCC (orden de compra)</label><input type="text" id="input-occ" placeholder="Opcional" value="'+esc(ui.form.occ)+'" style="font-family:var(--mono)"/></div>' +
      '</div>' +
      '<button type="button" class="btnGhost" data-action="cart-add" style="margin-bottom:18px;">'+icon("plus")+' Agregar herramienta a la lista</button>' +
      '</div>' +
      '<p class="sectionTitle">Entrega</p>' +
      '<div class="formGroup">' +
      '<div class="field"><label for="input-fecha-prestamo">Fecha de entrega</label><input type="date" id="input-fecha-prestamo" value="'+esc(ui.form.fechaPrestamo || todayISO())+'" max="'+todayISO()+'"/>' +
        '<p class="hint">Por defecto es hoy; puedes elegir un día anterior si la herramienta ya se había entregado.</p></div>' +
      '<div class="field"><label for="input-notas">Notas</label><textarea id="input-notas" rows="2" placeholder="Opcional">'+esc(ui.form.notas)+'</textarea></div>' +
      '</div>' +
      '<div class="formActions"><button type="submit" class="btnPrimary">'+icon("lock")+' Continuar y autorizar con NIP</button></div>' +
    '</form>';
  }

  function catalogoTpl(){
    var full = ui.catQuery.trim() ? tools.filter(function(t){
      var q = norm(ui.catQuery);
      return norm(t.nombre).indexOf(q)>=0 || (t.idArticulo && norm(t.idArticulo).indexOf(q)>=0);
    }) : tools;
    full = full.slice().sort(function(a,b){ return norm(a.nombre).localeCompare(norm(b.nombre)); });
    var page = paginate(full, "catalogo");
    var html = '<p class="sectionTitle">Agregar herramienta al catálogo</p><div class="card" style="max-width:520px;">' +
      '<form id="form-new-tool">' +
        '<input type="text" id="input-cat-nombre" placeholder="Nombre de la herramienta" value="'+esc(ui.catForm.nombre)+'" style="margin-bottom:8px;"/>' +
        '<input type="text" id="input-cat-idarticulo" placeholder="ID de artículo (opcional)" value="'+esc(ui.catForm.idArticulo)+'" style="margin-bottom:8px;font-family:var(--mono)"/>' +
        (ui.catFormError ? '<p class="errorText" style="margin:0 0 8px;">'+icon("alert")+' '+esc(ui.catFormError)+'</p>' : '') +
        '<button type="submit" class="btnPrimary" style="margin-top:6px;min-height:44px;font-size:15px;">'+icon("plus")+' Agregar al catálogo</button>' +
      '</form>' +
    '</div>';
    html += '<div class="searchWrap" style="max-width:520px;"><span class="searchIcon">'+icon("search")+'</span>' +
      '<input type="text" id="input-search-catalog" placeholder="Buscar en el catálogo ('+tools.length+' en total)" value="'+esc(ui.catQuery)+'"/></div>';
    if(full.length===0){
      html += '<p class="empty">'+(tools.length===0 ? "El catálogo está vacío. Agrega tu primera herramienta." : "Sin resultados similares.")+'</p>';
    } else {
      html += '<div class="cardGrid catalogGrid listGroup">';
      page.shown.forEach(function(t){
        if(ui.confirmDeleteToolId === t.id){
          html += '<div class="confirmBox"><p>¿Eliminar <b>'+esc(t.nombre)+'</b> del catálogo?</p>' +
            '<div class="confirmActions"><button class="confirmYes" data-action="confirm-delete-tool" data-id="'+t.id+'">Sí, eliminar</button>' +
            '<button class="confirmNo" data-action="cancel-delete-tool">Cancelar</button></div></div>';
        } else {
          html += '<div class="toolRow"><span style="min-width:0;">'+esc(t.nombre)+
            (t.idArticulo ? '<span class="sub code">ID '+esc(t.idArticulo)+'</span>' : '') +
            '</span>' +
            '<button class="deleteBtn" data-action="request-delete-tool" data-id="'+t.id+'" title="Eliminar del catálogo" aria-label="Eliminar del catálogo">'+icon("trash")+'</button></div>';
        }
      });
      html += '</div>';
      html += '<p class="hint center" style="margin-top:4px;">Mostrando '+page.shown.length+' de '+page.total+'</p>';
      if(page.hasMore) html += loadMoreBtn("catalogo", (page.total-page.shown.length)+' restantes');
    }
    return html;
  }

  function empleadosTpl(){
    var html = '<div class="toolbar"><button class="btnGhost toolbarBtn" data-action="open-new-employee">'+icon("plus")+' Nuevo colaborador</button></div>';
    if(employees.length > 4){
      html += '<div class="searchWrap" style="max-width:480px;"><span class="searchIcon">'+icon("search")+'</span>' +
        '<input type="text" id="input-search-employees" placeholder="Buscar por nombre o número de empleado ('+employees.length+' en total)" value="'+esc(ui.empListQuery)+'"/></div>';
    }
    if(employees.length===0){ html += '<p class="empty">Aún no hay colaboradores registrados.</p>'; }
    var full = sortByNombre(employees.filter(function(e){ return !ui.empListQuery.trim() || empMatches(e, ui.empListQuery); }));
    var page = paginate(full, "empleados");
    html += '<div class="cardGrid listGroup">';
    page.shown.forEach(function(emp){
      var activosEmp = resguardos.filter(function(r){return r.employeeId===emp.id && r.estado==="activo";}).length;
      if(ui.confirmDeleteEmpId === emp.id){
        html += '<div class="confirmBox" style="grid-column:1/-1;margin:0;"><p>¿Eliminar a <b>'+esc(emp.nombre)+'</b>?' +
          (activosEmp>0 ? ' Tiene '+activosEmp+' herramienta(s) en resguardo activo; se marcarán como devueltas.' : '') + ' Se pedirá autorización de un supervisor o administrador.</p>' +
          '<div class="confirmActions"><button class="confirmYes" data-action="confirm-delete-employee" data-id="'+emp.id+'">Sí, eliminar</button>' +
          '<button class="confirmNo" data-action="cancel-delete-employee">Cancelar</button></div></div>';
      } else {
        html += '<div class="empCard"><div class="avatar avatarLg '+avatarColorClass(emp.nombre)+'">'+esc(initials(emp.nombre))+'</div>' +
          '<div style="min-width:0;flex:1;"><div class="name">'+esc(emp.nombre)+'</div>' +
            '<div class="area">'+(emp.numero ? '<span class="code">#'+esc(emp.numero)+'</span>' : 'Sin número de empleado')+(emp.area ? ' · '+esc(emp.area) : '')+'</div>' +
            (emp.nipPendiente ? '<div class="area">NIP pendiente · asígnalo con el botón NIP</div>' : '') + '</div>' +
          '<button type="button" class="link" data-action="cambiar-nip" data-id="'+emp.id+'" style="font-size:13px;font-weight:600;" title="Cambiar NIP o desbloquear">NIP</button>' +
          (activosEmp>0 ? '<button type="button" class="countChip" data-action="view-employee-tools" data-id="'+emp.id+'">'+activosEmp+' en resguardo '+icon("chevron")+'</button>' : '') +
          '<button class="deleteBtn" data-action="request-delete-employee" data-id="'+emp.id+'" title="Eliminar colaborador" aria-label="Eliminar colaborador">'+icon("trash")+'</button>' +
        '</div>';
      }
    });
    html += '</div>';
    if(full.length>0){
      html += '<p class="hint center" style="margin-top:4px;">Mostrando '+page.shown.length+' de '+page.total+'</p>';
      if(page.hasMore) html += loadMoreBtn("empleados", (page.total-page.shown.length)+' restantes');
    }
    return html;
  }

  function tablaTpl(){
    var list = getAllSorted();
    if(ui.tableQuery.trim()){
      var q = norm(ui.tableQuery);
      list = list.filter(function(r){
        var emp = empName(r.employeeId);
        return norm(r.herramienta).indexOf(q)>=0 || norm(r.occ).indexOf(q)>=0 || norm(r.idArticulo).indexOf(q)>=0 || empMatches(emp, ui.tableQuery);
      });
    }
    var page = paginate(list, "tabla");
    var html = '<div class="searchWrap"><span class="searchIcon">'+icon("search")+'</span>' +
      '<input type="text" id="input-search-table" placeholder="Buscar en la tabla ('+resguardos.length+' en total)" value="'+esc(ui.tableQuery)+'"/></div>';
    if(list.length===0){
      html += '<p class="empty">Sin registros.</p>';
    } else {
      html += '<div class="tableScroll"><table><thead><tr>' +
        ["Entrega","Colaborador","Herramienta","Cant.","OCC","ID art.","Estado","Devuelto","Autorizó","Notas"].map(function(h){return '<th'+(h==="Cant."?' style="text-align:right;"':'')+'>'+h+'</th>';}).join("") +
        '</tr></thead><tbody>';
      page.shown.forEach(function(r){
        var emp = empName(r.employeeId);
        html += '<tr'+(r.estado==="devuelto"?' class="devuelto-row"':'')+'>' +
          '<td>'+fmtShort(r.fechaPrestamo)+'</td>' +
          '<td class="clip" title="'+(emp?esc(empLabel(emp)):"")+'">'+(emp?esc(emp.nombre):"—")+(emp && emp.numero ? ' <span class="code dim">#'+esc(emp.numero)+'</span>' : '')+'</td>' +
          '<td class="clip" title="'+esc(r.herramienta)+'">'+esc(r.herramienta)+'</td>' +
          '<td style="text-align:right;">'+r.cantidad+'</td>' +
          '<td class="code">'+(r.occ?esc(r.occ):"—")+'</td>' +
          '<td class="code">'+(r.idArticulo?esc(r.idArticulo):"—")+'</td>' +
          '<td><span class="estado '+r.estado+'">'+(r.estado==="activo"?"Activo":"Devuelto")+'</span></td>' +
          '<td>'+fmtShort(r.fechaDevolucion)+'</td>' +
          '<td class="dim">'+(r.creadoPor?esc(r.creadoPor):"—")+'</td>' +
          '<td class="clip dim" title="'+(r.notas?esc(r.notas):"")+'">'+(r.notas?esc(r.notas):"—")+'</td>' +
        '</tr>';
      });
      html += '</tbody></table></div>';
    }
    html += '<p class="hint center" style="margin-top:8px;">'+page.shown.length+' de '+page.total+' registro'+(page.total!==1?'s':'')+'</p>';
    if(page.hasMore) html += loadMoreBtn("tabla", (page.total-page.shown.length)+' restantes');
    return html;
  }

  function newEmployeeModalTpl(){
    if(!ui.showNewEmployeeModal) return "";
    return '' +
    '<div class="overlay'+overlayEnter+'"><form id="form-new-employee" class="modal">' +
      '<div class="modalHead"><div class="modalTitle">Nuevo colaborador</div>' +
      '<button type="button" class="closeBtn" data-action="close-new-employee" aria-label="Cerrar">'+icon("x")+'</button></div>' +
      '<div class="field"><label for="input-emp-numero">Número de empleado</label><input type="text" id="input-emp-numero" autocomplete="off" maxlength="30" value="'+esc(ui.empForm.numero)+'" style="font-family:var(--mono)" autofocus/></div>' +
      '<div class="field"><label for="input-emp-nombre">Nombre completo</label><input type="text" id="input-emp-nombre" maxlength="120" value="'+esc(ui.empForm.nombre)+'"/></div>' +
      '<div class="row2">' +
        '<div class="field"><label for="input-emp-pin">NIP (4 dígitos)</label><input type="password" inputmode="numeric" id="input-emp-pin" value="'+esc(ui.empForm.pin)+'" style="font-family:var(--mono)"/></div>' +
        '<div class="field"><label for="input-emp-pin2">Confirmar NIP</label><input type="password" inputmode="numeric" id="input-emp-pin2" value="'+esc(ui.empForm.pin2)+'" style="font-family:var(--mono)"/></div>' +
      '</div>' +
      '<p class="hint">El NIP es privado del colaborador; se usará para autorizar cada resguardo. Se guarda cifrado y nadie puede consultarlo.</p>' +
      (ui.empFormError ? '<p class="errorText">'+icon("alert")+' '+esc(ui.empFormError)+'</p>' : '') +
      '<button type="submit" class="btnPrimary" style="margin-top:10px;">Registrar colaborador</button>' +
    '</form></div>';
  }

  function pinPadModalTpl(){
    if(!ui.pinFlow) return "";
    var emp = empName(ui.pinFlow.employeeId);
    var pinLen = ui.pinFlow.pin.length;
    var dots = "";
    for(var i=0;i<4;i++){
      var cls = "dot" + (i<pinLen?" filled":"") + (ui.pinFlow.error?" err":"") + (i===pinLen-1 && pinLen>renderPrevPinLen ? " pop":"");
      dots += '<div class="'+cls+'"></div>';
    }
    var digits = ["1","2","3","4","5","6","7","8","9"];
    var keys = digits.map(function(d){ return '<button type="button" class="pinKey" data-action="pin-digit" data-digit="'+d+'">'+d+'</button>'; }).join("");
    return '' +
    '<div class="overlay'+overlayEnter+'"><div class="modal pinModal" style="max-width:360px;">' +
      '<div class="modalHead"><div style="min-width:0;">' +
        '<div class="modalTitle">'+(emp?esc(emp.nombre):"Colaborador")+'</div>' +
        (emp && emp.numero ? '<p class="modalSub code">No. de empleado #'+esc(emp.numero)+'</p>' : '') +
        '<p class="modalSub">'+(ui.pinFlow.mode==="nuevo"?"Autoriza la entrega de "+(ui.cart.length===1?"1 herramienta":ui.cart.length+" herramientas"):"Confirma la devolución")+'</p></div>' +
        '<button type="button" class="closeBtn" data-action="pin-cancel" aria-label="Cancelar">'+icon("x")+'</button></div>' +
      '<p class="hint center" style="margin:0;font-size:14px;color:var(--label2);">Ingresa tu NIP de 4 dígitos</p>' +
      '<div class="pinDots'+(renderShake?' shake':'')+'" role="status" aria-label="'+pinLen+' de 4 dígitos">'+dots+'</div>' +
      (ui.pinFlow.error ? '<p class="errorText" style="justify-content:center;margin:-8px 0 12px;">'+icon("alert")+' '+esc(ui.pinFlow.errorMsg || "NIP incorrecto, intenta de nuevo")+'</p>' : '') +
      (ui.pinFlow.pending ? '<p class="hint center" style="margin:-6px 0 10px;">Verificando…</p>' : '') +
      '<div class="pinGrid">' + keys + '<div></div>' +
        '<button type="button" class="pinKey" data-action="pin-digit" data-digit="0">0</button>' +
        '<button type="button" class="pinKey keyDel" data-action="pin-del" aria-label="Borrar">'+icon("del")+'</button>' +
      '</div>' +
    '</div></div>';
  }

  function employeeToolsModalTpl(){
    if(!ui.viewEmployeeToolsId) return "";
    var emp = empName(ui.viewEmployeeToolsId);
    if(!emp) return "";
    var items = resguardos.filter(function(r){ return r.employeeId===emp.id && r.estado==="activo"; });
    var rows = items.length===0 ? '<p class="empty">Este colaborador no tiene herramienta en resguardo.</p>' :
      items.map(function(r){
        return '<div class="toolRow"><span style="min-width:0;">'+esc(r.herramienta)+(r.cantidad>1?' <span class="qty">×'+r.cantidad+'</span>':'')+
          '<span class="sub">Entregado '+fmt(r.fechaPrestamo)+'</span></span>' +
          '<button class="deleteBtn" data-action="quitar-sin-pin" data-id="'+r.id+'" title="Quitar del resguardo (requiere autorización)" aria-label="Quitar del resguardo">'+icon("trash")+'</button></div>';
      }).join("");
    return '' +
    '<div class="overlay'+overlayEnter+'"><div class="modal">' +
      '<div class="modalHead"><div class="modalTitle">'+esc(emp.nombre)+'</div>' +
      '<button type="button" class="closeBtn" data-action="close-employee-tools" aria-label="Cerrar">'+icon("x")+'</button></div>' +
      '<p class="hint" style="margin:-8px 0 16px;font-size:14px;color:var(--label2);">Herramienta actualmente en resguardo. Quitar aquí pedirá correo y contraseña de un supervisor o administrador.</p>' +
      rows +
    '</div></div>';
  }

  function authModalTpl(){
    if(!ui.authFlow) return "";
    var f = ui.authFlow;
    var target = f.payload && f.payload.employeeId ? empName(f.payload.employeeId) : null;
    var titles = {
      "devolver-item": "Autorizar devolución",
      "quitar-sin-pin": "Autorizar remoción de resguardo",
      "delete-employee-cascade": "Autorizar baja de colaborador",
      "delete-employee": "Autorizar baja de colaborador",
      "cambiar-nip": "Asignar o cambiar NIP",
      "admin-user": "Confirmar cambio de cuenta"
    };
    var subtitles = {
      "devolver-item": "Esta acción cierra el resguardo.",
      "quitar-sin-pin": "Esta acción libera la herramienta sin pasar por el colaborador. Requiere correo y contraseña de un supervisor o administrador.",
      "delete-employee-cascade": "Este colaborador tiene herramienta en resguardo activa; se marcará como devuelta al eliminarlo. Requiere correo y contraseña de un supervisor o administrador.",
      "delete-employee": "Dar de baja a un colaborador requiere correo y contraseña de un supervisor o administrador. Su historial se conserva.",
      "cambiar-nip": "Asigna un NIP nuevo y desbloquea al colaborador si estaba bloqueado por intentos fallidos. Requiere correo y contraseña de un supervisor o administrador.",
      "admin-user": "Confirma con tu correo y contraseña de administrador."
    };
    return '' +
    '<div class="overlay'+overlayEnter+'"><div class="modal" style="max-width:340px;">' +
      '<div class="modalHead"><div class="modalTitle">'+(titles[f.kind]||"Autorización")+'</div>' +
      '<button type="button" class="closeBtn" data-action="auth-cancel" aria-label="Cerrar">'+icon("x")+'</button></div>' +
      '<p class="hint" style="margin:-6px 0 16px;font-size:14px;line-height:1.45;color:var(--label2);">'+(target ? '<b>'+esc(empLabel(target))+'</b>. ' : '')+(f.kind === "admin-user" && f.payload ? esc(f.payload.email)+' → '+esc(f.payload.rol)+(f.payload.activo?' · activa':' · desactivada')+'. ' : '')+(subtitles[f.kind]||"")+'</p>' +
      '<form id="form-auth">' +
        (f.kind === "cambiar-nip" ?
          '<div class="row2">' +
            '<div class="field"><label for="input-auth-pin">NIP nuevo</label><input type="password" inputmode="numeric" autocomplete="off" id="input-auth-pin" value="'+esc(f.pin)+'" style="font-family:var(--mono)" autofocus/></div>' +
            '<div class="field"><label for="input-auth-pin2">Confirmar NIP</label><input type="password" inputmode="numeric" autocomplete="off" id="input-auth-pin2" value="'+esc(f.pin2)+'" style="font-family:var(--mono)"/></div>' +
          '</div>' : '') +
        '<div class="field"><label for="input-auth-user">Correo</label><input type="text" id="input-auth-user" autocomplete="username" inputmode="email" spellcheck="false" maxlength="254" value="'+esc(f.username)+'"'+(f.kind === "cambiar-nip" ? '' : ' autofocus')+'/></div>' +
        '<div class="field"><label for="input-auth-pass">Contraseña</label><input type="password" id="input-auth-pass" autocomplete="current-password" maxlength="128" value="'+esc(f.password)+'"/></div>' +
        (f.error ? '<p class="errorText" style="margin:-6px 0 12px;">'+icon("alert")+' '+esc(f.error)+'</p>' : '') +
        '<button type="submit" class="btnPrimary" style="width:100%;margin-top:6px;"'+(f.pending?' disabled':'')+'>'+(f.pending?'Verificando…':'Confirmar')+'</button>' +
      '</form>' +
    '</div></div>';
  }

  function loginTpl(){
    return '' +
    '<div class="loginShell"><div class="loginCard">' +
      '<div class="loginBrand"><img src="'+LOGO+'" alt="Citrojugo"/>' +
        '<div class="loginName">Citrojugo</div>' +
        '<div class="loginSub">Resguardo de herramienta</div></div>' +
      '<form id="form-login">' +
        '<div class="field"><label for="input-login-user">Correo</label><input type="text" id="input-login-user" autocomplete="username" inputmode="email" spellcheck="false" maxlength="254" value="'+esc(ui.loginForm.username)+'" autofocus/></div>' +
        '<div class="field"><label for="input-login-pass">Contraseña</label><input type="password" id="input-login-pass" autocomplete="current-password" maxlength="128" value="'+esc(ui.loginForm.password)+'"/></div>' +
        (!configOk() ? '<p class="errorText" style="margin:-6px 0 12px;">'+icon("alert")+' Falta configurar la conexión (config.js). Revisa SEGURIDAD.md.</p>' : '') +
        (ui.loginError ? '<p class="errorText" style="margin:-6px 0 12px;">'+icon("alert")+' '+esc(ui.loginError)+'</p>' : '') +
        '<button type="submit" class="btnPrimary" style="width:100%;margin-top:6px;"'+(ui.loginPending||ui.booting||!configOk()?' disabled':'')+'>'+(ui.booting?'Cargando…':ui.loginPending?'Verificando…':'Iniciar sesión')+'</button>' +
      '</form>' +
    '</div></div>';
  }

  var ROL_LABEL = { admin: "Administrador", supervisor: "Supervisor", almacen: "Almacén" };
  function usersTpl(){
    if(!ui.currentUser || ui.currentUser.rol !== "admin") return '<p class="empty">Solo un administrador puede ver esta sección.</p>';
    var html = '<div class="toolbar"><button class="btnGhost toolbarBtn" data-action="open-new-user">'+icon("plus")+' Nueva cuenta</button></div>';
    html += '<div class="cardGrid listGroup">';
    sortByNombre(users.map(function(u){return {nombre:u.username, u:u};})).forEach(function(wrap){
      var u = wrap.u;
      var self = u.id === ui.currentUser.id;
      html += '<div class="empCard"><div class="avatar avatarLg '+avatarColorClass(u.username)+'">'+esc(initials(u.username))+'</div>' +
        '<div style="min-width:0;flex:1;"><div class="name">'+esc(u.username)+'</div>' +
          '<div style="font-size:12px;color:var(--hint);">'+esc(u.email !== u.username ? u.email+' · ' : '')+esc(ROL_LABEL[u.rol]||u.rol)+(u.activo?'':' · desactivada')+'</div></div>' +
        (!self ?
          '<select data-action="user-rol" data-id="'+u.id+'" aria-label="Rol de '+esc(u.username)+'" style="width:auto;font-size:12px;">' +
            ["almacen","supervisor","admin"].map(function(r){ return '<option value="'+r+'"'+(u.rol===r?' selected':'')+'>'+ROL_LABEL[r]+'</option>'; }).join("") +
          '</select>' +
          '<button type="button" class="link'+(u.activo?' linkDanger':'')+'" data-action="toggle-user" data-id="'+u.id+'" style="font-size:13px;font-weight:600;">'+(u.activo?'Desactivar':'Activar')+'</button>'
          : '<span class="youTag">Tú</span>') +
      '</div>';
    });
    html += '</div>';
    // Respaldo de la versión anterior (datos que quedaron en el navegador de esta PC)
    if(hasLegacyData()){
      html += '<div class="card" style="max-width:520px;margin-top:20px;">' +
        '<p style="font-size:14px;font-weight:700;margin:0 0 6px;">Datos de la versión anterior en esta computadora</p>' +
        '<p class="hint" style="margin:0 0 12px;">Este navegador todavía guarda los resguardos de la versión sin servidor. Descárgalos para migrarlos (ver SEGURIDAD.md) y después bórralos de aquí. El archivo contiene NIPs: no lo compartas.</p>' +
        (ui.confirmClearLegacy ?
          '<div class="confirmBox"><p>¿Borrar los datos de la versión anterior de este navegador? Hazlo solo después de migrarlos.</p>' +
            '<div class="confirmActions"><button class="confirmYes" data-action="clear-legacy">Sí, borrar</button>' +
            '<button class="confirmNo" data-action="clear-legacy-cancel">Cancelar</button></div></div>'
          : '<button type="button" class="btnPrimary" data-action="export-legacy" style="margin-right:8px;">Descargar respaldo (JSON)</button>' +
            '<button type="button" class="btnGhost" data-action="clear-legacy-ask" style="max-width:220px;">Borrar de este navegador</button>') +
      '</div>';
    }
    return html;
  }

  // Las cuentas NO se crean desde la página: crear usuarios requiere la
  // service_role key, que nunca debe estar en el navegador.
  function newUserModalTpl(){
    if(!ui.showNewUserModal) return "";
    return '' +
    '<div class="overlay'+overlayEnter+'"><form id="form-new-user" class="modal">' +
      '<div class="modalHead"><div class="modalTitle">Nueva cuenta</div>' +
      '<button type="button" class="closeBtn" data-action="close-new-user" aria-label="Cerrar">'+icon("x")+'</button></div>' +
      '<p class="hint" style="margin:0 0 10px;">Por seguridad, las cuentas se crean en el panel de Supabase:</p>' +
      '<p class="hint" style="margin:0 0 6px;">1. Supabase → Authentication → Users → <b>Add user</b> → <b>Create new user</b> (o <b>Send invitation</b>).</p>' +
      '<p class="hint" style="margin:0 0 6px;">2. Escribe el correo y una contraseña de al menos 10 caracteres.</p>' +
      '<p class="hint" style="margin:0 0 14px;">3. Regresa aquí, recarga la página y en esta lista elige su rol y pulsa <b>Activar</b>.</p>' +
      '<button type="submit" class="btnPrimary" style="margin-top:10px;">Entendido</button>' +
    '</form></div>';
  }

  function toastTpl(){
    if(!ui.toast) return "";
    var ic = ui.toast.type==="ok" ? icon("check") : icon("alert");
    return '<div class="toast '+(ui.toast.type==="ok"?"ok":"err")+(ui.toast.fresh?' enter':'')+'" role="status" aria-live="polite"><span class="tIcon">'+ic+'</span>'+esc(ui.toast.msg)+'</div>';
  }

  // ---------- Motion gating ----------
  // render() reemplaza todo el DOM; estas banderas evitan que las animaciones
  // se repitan en cada tecla. Solo animan al aparecer algo nuevo.
  var overlayEnter = "", renderStamp = {}, renderShake = false, renderPrevPinLen = 0;
  var lastTab = null, lastModalKey = "", lastPinLen = 0;
  function modalKey(){
    if(ui.pinFlow) return "pin";
    if(ui.authFlow) return "auth:"+ui.authFlow.kind;
    if(ui.showNewEmployeeModal) return "emp";
    if(ui.showNewUserModal) return "user";
    if(ui.viewEmployeeToolsId) return "tools:"+ui.viewEmployeeToolsId;
    return "";
  }
  var pageTitles = {
    dashboard: ["Resumen", "Estado general de la herramienta en resguardo"],
    activos: ["Resguardos activos", "Herramienta que hoy está en manos de un colaborador"],
    nuevo: ["Nuevo resguardo", "Registra la entrega y autorízala con el NIP del colaborador"],
    catalogo: ["Catálogo", "Herramienta registrada y su ID de artículo"],
    empleados: ["Colaboradores", "Personal que puede recibir herramienta en resguardo"],
    historial: ["Historial", "Resguardos cerrados con su fecha de devolución"],
    tabla: ["Tabla completa", "Todos los movimientos, del más reciente al más antiguo"],
    usuarios: ["Usuarios", "Cuentas que pueden autorizar devoluciones y ajustes"]
  };
  function pageHeadTpl(){
    var p = pageTitles[ui.tab]; if(!p) return "";
    return '<header class="pageHead"><h1 class="pageTitle">'+p[0]+'</h1><p class="pageSub">'+p[1]+'</p></header>';
  }

  var tabRenderers = {
    dashboard: dashboardTpl, activos: activosTpl, nuevo: nuevoTpl,
    catalogo: catalogoTpl, empleados: empleadosTpl, historial: historialTpl, tabla: tablaTpl,
    usuarios: usersTpl
  };

  function render(){
    var active = document.activeElement;
    var activeId = active && active.id;
    var selStart, selEnd;
    if(active && typeof active.selectionStart === "number"){
      selStart = active.selectionStart; selEnd = active.selectionEnd;
    }
    if(!ui.currentUser){
      document.getElementById("app").innerHTML = loginTpl();
      lastTab = null; lastModalKey = ""; lastPinLen = 0;
      if(activeId){
        var elLogin = document.getElementById(activeId);
        if(elLogin){
          elLogin.focus();
          if(typeof selStart === "number" && elLogin.setSelectionRange){
            try{ elLogin.setSelectionRange(selStart, selEnd); }catch(e){}
          }
        }
      }
      return;
    }
    var narrow = (ui.tab === "nuevo") ? " narrow" : "";
    var tabEnter = (ui.tab !== lastTab) ? " enter" : "";
    var mk = modalKey();
    overlayEnter = (mk && mk !== lastModalKey) ? " enter" : "";
    renderStamp = {};
    (ui.justStamped || []).forEach(function(id){ renderStamp[id] = true; });
    ui.justStamped = [];
    renderShake = !!(ui.pinFlow && ui.pinFlow.shake);
    if(ui.pinFlow) ui.pinFlow.shake = false;
    renderPrevPinLen = lastPinLen;
    var body;
    if(ui.loading){
      body = '<div class="empty" role="status">Cargando información…</div>';
    } else if(ui.loadError){
      body = '<div class="empty" role="alert">'+icon("alert")+' '+esc(ui.loadError)+'<br/>' +
        '<button type="button" class="link" data-action="retry-load">Reintentar '+icon("arrow")+'</button></div>';
    } else {
      body = (ui.offline ? '<p class="errorText" role="status" style="margin:0 0 12px;">'+icon("alert")+' Sin conexión con el servidor. Lo que ves puede no estar al día y no se podrán guardar cambios.</p>' : '') +
        (tabRenderers[ui.tab] ? tabRenderers[ui.tab]() : "");
    }
    var html = '<div class="shell"><nav class="sidebar" aria-label="Secciones">' + sidebarTpl() + '</nav>' +
      '<main class="main"><div class="content'+narrow+tabEnter+'">' + pageHeadTpl() + body + '</div></main>' +
    '</div>' + newEmployeeModalTpl() + pinPadModalTpl() + employeeToolsModalTpl() + newUserModalTpl() + authModalTpl() + toastTpl();
    document.getElementById("app").innerHTML = html;
    if(tabEnter && lastTab !== null) window.scrollTo(0,0);
    lastTab = ui.tab; lastModalKey = mk; lastPinLen = ui.pinFlow ? ui.pinFlow.pin.length : 0;
    if(overlayEnter && !activeId){
      var af = document.querySelector(".overlay [autofocus]");
      if(af) af.focus();
    }
    if(activeId){
      var el = document.getElementById(activeId);
      if(el){
        el.focus();
        if(typeof selStart === "number" && el.setSelectionRange){
          try{ el.setSelectionRange(selStart, selEnd); }catch(e){}
        }
      }
    }
  }

  // ---------- Actions ----------
  function setTab(id){
    ui.tab = id; ui.confirmDeleteEmpId=null; ui.confirmDeleteToolId=null; ui.confirmReturnId=null;
    ui.visible = { activos: ui.pageSize, historial: ui.pageSize, catalogo: ui.pageSize, empleados: ui.pageSize, tabla: ui.pageSize };
    render();
  }

  function submitLogin(){
    if(ui.loginPending) return;
    ui.loginError = "";
    var email = ui.loginForm.username.trim().toLowerCase();
    var pass = ui.loginForm.password;
    if(!email || !pass){ ui.loginError = "Escribe tu correo y contraseña."; render(); return; }
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){ ui.loginError = "Escribe un correo válido."; render(); return; }
    var locked = pwLocked(); if(locked){ ui.loginError = locked; render(); return; }
    ui.loginPending = true;
    render();
    authPassword(email, pass).then(function(s){
      storeSession(s);
      return loadProfile();
    }).then(function(){
      pwOk();
      ui.loginPending = false;
      ui.loginForm = { username: "", password: "" };
      ui.tab = "dashboard";
      touchActivity();
      return loadData();
    }).catch(function(e){
      ui.loginPending = false;
      ui.loginForm.password = "";
      if(session){ authSignOut(session.access_token); storeSession(null); }
      ui.currentUser = null;
      if(!e.network && e.code === "invalid_credentials") pwFailed();
      ui.loginError = e.message || "No se pudo iniciar sesión.";
      render();
    });
  }

  function logout(){
    var tok = session && session.access_token;
    storeSession(null);
    clearPrivateState();
    ui.currentUser = null; ui.tab = "dashboard"; ui.loginError = "";
    render();
    if(tok) authSignOut(tok);
  }

  // Las cuentas se crean en el panel de Supabase (nunca con la service_role
  // key en el navegador). Aquí el admin solo las activa y les asigna rol.
  function submitNewUser(){ ui.showNewUserModal = false; render(); }

  function submitNewEmployee(){
    if(ui.busy) return;
    ui.empFormError = "";
    var f = ui.empForm;
    var num = normNum(f.numero);
    if(!num){ ui.empFormError="Escribe el número de empleado."; render(); return; }
    if(!/^[A-Z0-9][A-Z0-9._\/-]{0,29}$/.test(num)){ ui.empFormError="El número de empleado solo admite letras, números, punto, guion y diagonal (máx. 30)."; render(); return; }
    if(!f.nombre.trim()){ ui.empFormError="Escribe el nombre del colaborador."; render(); return; }
    if(f.nombre.trim().length > 120){ ui.empFormError="El nombre admite máximo 120 caracteres."; render(); return; }
    if(!/^\d{4}$/.test(f.pin)){ ui.empFormError="El NIP debe tener 4 dígitos."; render(); return; }
    if(f.pin === "0000"){ ui.empFormError="El NIP 0000 no está permitido; elige otro."; render(); return; }
    if(f.pin !== f.pin2){ ui.empFormError="Los NIP no coinciden."; render(); return; }
    if(employees.some(function(e){ return e.numero === num; })){
      ui.empFormError="Ya existe un colaborador con ese número de empleado."; render(); return;
    }
    ui.busy = true;
    rpc("alta_colaborador", { p_numero_empleado: num, p_nombre: f.nombre.trim(), p_nip: f.pin, p_area: "" }).then(function(c){
      ui.busy = false;
      if(okId(c)) employees.push(mapEmployee(c));
      ui.empForm = {numero:"",nombre:"",pin:"",pin2:""};
      ui.showNewEmployeeModal = false;
      toast("ok","Colaborador registrado.");
    }, function(e){
      ui.busy = false;
      ui.empForm.pin = ""; ui.empForm.pin2 = "";
      ui.empFormError = e.message; render();
    });
  }

  function actionError(e){
    if(e && e.status === 401){ onSessionLost(); return; }
    toast("err", (e && e.message) || "No se pudo completar la operación.");
  }

  // Autorización de supervisor/admin para devoluciones, ajustes, bajas,
  // cambio de NIP y administración de cuentas. Ver withSupervisor().
  function submitAuth(){
    var f = ui.authFlow;
    if(!f || f.pending) return;
    f.error = "";
    var email = f.username.trim().toLowerCase();
    if(!email || !f.password){ f.error = "Escribe correo y contraseña."; render(); return; }
    if(f.kind === "cambiar-nip"){
      if(!/^\d{4}$/.test(f.pin || "")){ f.error = "El NIP nuevo debe tener 4 dígitos."; render(); return; }
      if(f.pin === "0000"){ f.error = "El NIP 0000 no está permitido."; render(); return; }
      if(f.pin !== f.pin2){ f.error = "Los NIP nuevos no coinciden."; render(); return; }
    }
    var locked = pwLocked(); if(locked){ f.error = locked; render(); return; }
    f.pending = true;
    render();
    var flow = f;
    withSupervisor(email, f.password, function(token, user){
      return runAuthorized(flow, token, user);
    }).then(function(result){
      pwOk();
      if(ui.authFlow !== flow) return;
      resolveAuthFlow(result);
    }, function(e){
      if(ui.authFlow !== flow) return;
      if(!e.network && e.code === "invalid_credentials") pwFailed();
      flow.pending = false;
      flow.password = "";
      flow.error = e.message;
      render();
    });
  }

  function runAuthorized(f, token, user){
    var p = f.payload || {};
    if(f.kind === "devolver-item")  return rpc("devolver_resguardo", { p_resguardo_id: p.resguardoId, p_tipo: "devolucion" }, token).then(function(r){ return { rows: [r] }; });
    if(f.kind === "quitar-sin-pin") return rpc("devolver_resguardo", { p_resguardo_id: p.resguardoId, p_tipo: "ajuste" }, token).then(function(r){ return { rows: [r] }; });
    if(f.kind === "delete-employee-cascade" || f.kind === "delete-employee") return rpc("baja_colaborador", { p_colaborador_id: p.employeeId }, token);
    if(f.kind === "cambiar-nip") return rpc("cambiar_nip", { p_colaborador_id: p.employeeId, p_nip: f.pin }, token);
    if(f.kind === "admin-user")  return rpc("admin_actualizar_usuario", { p_id: p.userId, p_rol: p.rol, p_activo: !!p.activo }, token);
    return Promise.reject(new ApiError("Acción no reconocida."));
  }

  function resolveAuthFlow(result){
    var f = ui.authFlow;
    if(!f) return;
    result = result || {};
    if(f.kind === "devolver-item" || f.kind === "quitar-sin-pin"){
      (result.rows || []).forEach(function(r){ if(r) upsertResguardo(mapResguardo(r)); });
      var who = result.rows && result.rows[0] ? result.rows[0].devuelto_por : "";
      toast("ok", f.kind === "devolver-item" ? "Devolución autorizada" + (who ? " por " + who : "") + "." : "Herramienta quitada del resguardo.");
    } else if(f.kind === "delete-employee-cascade" || f.kind === "delete-employee"){
      var ids = {}; (result.devueltos || []).forEach(function(id){ ids[String(id)] = true; });
      resguardos.forEach(function(r){
        if(ids[r.id]){ r.estado = "devuelto"; r.fechaDevolucion = isoDate(result.fecha_devolucion) || todayISO(); r.devueltoPor = String(result.devuelto_por || ""); }
      });
      var emp = empName(f.payload.employeeId);
      if(emp){ formerEmployees[emp.id] = emp; }
      employees = employees.filter(function(e){ return e.id !== f.payload.employeeId; });
      ui.confirmDeleteEmpId = null; ui.viewEmployeeToolsId = null;
      var nDev = Object.keys(ids).length;
      toast("ok", nDev ? "Colaborador dado de baja y "+nDev+" herramienta(s) marcada(s) como devuelta(s)." : "Colaborador dado de baja.");
    } else if(f.kind === "cambiar-nip"){
      var e2 = empName(f.payload.employeeId); if(e2) e2.nipPendiente = false;
      toast("ok","NIP actualizado y desbloqueado.");
    } else if(f.kind === "admin-user"){
      if(!okId(result)){ ui.authFlow = null; render(); return; }
      var u = mapUser(result);
      users = users.map(function(x){ return x.id === u.id ? u : x; });
      toast("ok","Cuenta actualizada.");
    }
    ui.authFlow = null;
    render();
  }

  // Devolución: la registra el usuario con sesión iniciada (almacén, supervisor o
  // admin). La base valida que la cuenta esté activa y firma la bitácora con su
  // identidad; no se pide la contraseña de un supervisor.
  function confirmReturn(id){ ui.confirmReturnId = id; render(); }
  function submitReturn(id){
    if(ui.busy) return;
    ui.busy = true; render();
    rpc("devolver_resguardo", { p_resguardo_id: id, p_tipo: "devolucion" }).then(function(r){
      ui.busy = false; ui.confirmReturnId = null;
      if(okId(r)) upsertResguardo(mapResguardo(r));
      toast("ok", "Devolución registrada" + (r && r.devuelto_por ? " por " + r.devuelto_por : "") + ".");
    }, function(e){ ui.busy = false; ui.confirmReturnId = null; actionError(e); });
  }

  function openAuth(kind, payload){
    ui.authFlow = {kind:kind, payload:payload||{}, username:"", password:"", pin:"", pin2:"", error:"", pending:false};
    render();
  }

  function submitNewTool(){
    if(ui.busy) return;
    ui.catFormError = "";
    var nombre = ui.catForm.nombre.trim(), ida = ui.catForm.idArticulo.trim();
    if(!nombre){ ui.catFormError="Escribe el nombre de la herramienta."; render(); return; }
    if(tools.some(function(t){return norm(t.nombre)===norm(nombre);})){
      ui.catFormError="Esa herramienta ya está en el catálogo."; render(); return;
    }
    ui.busy = true;
    rpc("agregar_herramienta", { p_nombre: nombre, p_id_articulo: ida }).then(function(t){
      ui.busy = false;
      if(okId(t)) tools.push(mapTool(t));
      ui.catForm = {nombre:"", idArticulo:""};
      toast("ok","Herramienta agregada al catálogo.");
    }, function(e){ ui.busy = false; ui.catFormError = e.message; render(); });
  }

  function findToolByIdArticulo(q){
    var n = norm(q);
    if(!n) return null;
    var match = tools.filter(function(t){ return t.idArticulo && norm(t.idArticulo)===n; });
    return match.length===1 ? match[0] : null;
  }

  function deleteTool(id){
    if(ui.busy) return;
    ui.busy = true;
    rpc("eliminar_herramienta", { p_id: id }).then(function(){
      ui.busy = false;
      tools = tools.filter(function(t){return t.id!==id;});
      ui.confirmDeleteToolId = null;
      render();
    }, function(e){ ui.busy = false; ui.confirmDeleteToolId = null; actionError(e); });
  }

  function saveFecha(id){
    if(!ui.editFechaValue || !/^\d{4}-\d{2}-\d{2}$/.test(ui.editFechaValue)){ toast("err","Elige una fecha válida."); return; }
    if(ui.editFechaValue > todayISO()){ toast("err","La fecha de entrega no puede ser futura."); return; }
    if(ui.busy) return;
    ui.busy = true;
    rpc("editar_fecha_prestamo", { p_resguardo_id: id, p_fecha: ui.editFechaValue }).then(function(r){
      ui.busy = false;
      upsertResguardo(mapResguardo(r));
      ui.editingFechaId = null;
      toast("ok","Fecha de entrega actualizada.");
    }, function(e){ ui.busy = false; actionError(e); });
  }

  function addToCart(){
    var nombre = ui.toolQuery.trim();
    if(!nombre){ toast("err","Escribe qué herramienta se presta."); return; }
    if(nombre.length > 200){ toast("err","El nombre de la herramienta admite máximo 200 caracteres."); return; }
    var cant = Math.floor(Number(ui.form.cantidad)) || 1;
    if(cant < 1 || cant > 9999){ toast("err","La cantidad debe estar entre 1 y 9999."); return; }
    if(ui.cart.length >= 50){ toast("err","Máximo 50 herramientas por resguardo."); return; }
    ui.cart.push({
      tempId: uid(),
      herramienta: nombre,
      cantidad: cant,
      occ: ui.form.occ.trim().slice(0, 60),
      idArticulo: ui.form.idArticulo.trim().slice(0, 60)
    });
    ui.toolQuery = ""; ui.form.herramienta = ""; ui.form.cantidad = 1;
    ui.form.occ = ""; ui.form.idArticulo = ""; ui.form.idArticuloHint = ""; ui.form.idArticuloMatched = false;
    render();
    var toolInput = document.getElementById("input-tool-query");
    if(toolInput) toolInput.focus();
  }

  // Identifica al colaborador por número de empleado exacto (admite "#123")
  // o por nombre completo exacto. Si el nombre se repite, pide el número.
  function resolveEmployeeByQuery(q){
    var n = norm(q);
    if(!n) return { emp: null };
    var u = normNum(q).replace(/^#/, "");
    var byNum = u ? employees.filter(function(e){ return e.numero && e.numero === u; }) : [];
    if(byNum.length === 1) return { emp: byNum[0] };
    var exact = employees.filter(function(e){ return norm(e.nombre) === n; });
    if(exact.length === 1) return { emp: exact[0] };
    return { emp: null, ambiguous: exact.length > 1 };
  }

  function submitNewResguardo(){
    var match = { emp: null };
    if(!ui.form.employeeId){
      match = resolveEmployeeByQuery(ui.empQuery);
      if(match.emp){ ui.form.employeeId = match.emp.id; }
    }
    if(!ui.form.employeeId){
      toast("err", match.ambiguous ? "Hay varios colaboradores con ese nombre. Escribe su número de empleado."
                                   : "No se encontró ese colaborador. Escribe su número de empleado o el nombre exacto, o regístralo en Colaboradores.");
      return;
    }
    // Si el usuario dejó algo escrito en "Herramienta" sin darle Enter/Agregar, lo sumamos a la lista.
    if(ui.toolQuery.trim()){ addToCart(); }
    if(ui.cart.length === 0){ toast("err","Agrega al menos una herramienta a la lista."); return; }
    if(!ui.form.fechaPrestamo){ ui.form.fechaPrestamo = todayISO(); }
    if(ui.form.fechaPrestamo > todayISO()){ toast("err","La fecha de entrega no puede ser futura."); return; }
    if(ui.form.notas.length > 500){ toast("err","Las notas admiten máximo 500 caracteres."); return; }
    // requestId: mismo valor en reintentos → la base no duplica el resguardo.
    ui.pinFlow = {mode:"nuevo", employeeId:ui.form.employeeId, resguardoId:null, pin:"", error:false, errorMsg:"", pending:false, requestId:newRequestId()};
    render();
  }

  function pinPress(d){
    if(!ui.pinFlow || ui.pinFlow.pending) return;
    if(ui.pinFlow.pin.length>=4) return;
    ui.pinFlow.pin += d;
    render();
    if(ui.pinFlow.pin.length===4){ setTimeout(submitPin,120); }
  }
  function pinDel(){
    if(!ui.pinFlow || ui.pinFlow.pending) return;
    ui.pinFlow.pin = ui.pinFlow.pin.slice(0,-1);
    render();
  }

  // El NIP se envía a la función crear_resguardo de la base; allí se compara
  // con el hash bcrypt, se cuentan los intentos y se crean los resguardos.
  function submitPin(){
    var flow = ui.pinFlow;
    if(!flow || flow.pending || flow.pin.length !== 4) return;
    var emp = empName(flow.employeeId);
    var pin = flow.pin;
    flow.pending = true;
    render();
    var items = ui.cart.map(function(c){ return { herramienta: c.herramienta, cantidad: c.cantidad, occ: c.occ, id_articulo: c.idArticulo }; });
    rpc("crear_resguardo", {
      p_colaborador_id: flow.employeeId, p_nip: pin, p_items: items,
      p_fecha: ui.form.fechaPrestamo || todayISO(), p_notas: ui.form.notas.trim(), p_solicitud: flow.requestId
    }).then(function(res){
      if(ui.pinFlow !== flow) return;
      if(!res || !res.ok){
        flow.error = true; flow.pending = false; flow.pin = ""; flow.shake = true;
        flow.errorMsg = (res && res.mensaje) || "NIP incorrecto, intenta de nuevo";
        render();
        return;
      }
      var stamped = [];
      (res.resguardos || []).slice().reverse().forEach(function(r){ var m = mapResguardo(r); upsertResguardo(m); stamped.push(m.id); });
      (res.herramientas || []).forEach(function(t){
        if(okId(t) && !tools.some(function(x){ return x.id === String(t.id); })) tools.push(mapTool(t));
      });
      var count = (res.resguardos || []).length;
      ui.cart = [];
      ui.form = {employeeId:"", herramienta:"", cantidad:1, occ:"", idArticulo:"", idArticuloHint:"", idArticuloMatched:false, notas:"", fechaPrestamo:""};
      ui.empQuery = ""; ui.toolQuery = "";
      ui.pinFlow = null;
      ui.tab = "activos";
      ui.query = ""; ui.visible.activos = ui.pageSize;
      ui.justStamped = stamped;
      var nombre = emp ? emp.nombre : "el colaborador";
      toast("ok", count + (count===1?" herramienta autorizada para ":" herramientas autorizadas para ") + nombre + "." +
        (res.nip_pendiente ? " Aviso: su NIP sigue siendo 0000; pide a un supervisor que lo cambie." : ""));
    }, function(e){
      if(ui.pinFlow !== flow) return;
      if(e.status === 401){ onSessionLost(); return; }
      flow.pending = false; flow.pin = ""; flow.error = true; flow.shake = true;
      flow.errorMsg = e.network ? "Sin conexión. Revisa tu internet e intenta de nuevo; no se registró nada duplicado." : e.message;
      render();
    });
  }

  // ---------- Inactividad: cierra sesión en PCs compartidas ----------
  var lastActivity = Date.now();
  function touchActivity(){ lastActivity = Date.now(); }
  setInterval(function(){
    if(ui.currentUser && Date.now() - lastActivity > IDLE_MIN * 60000){
      logout();
      ui.loginError = "Se cerró la sesión por inactividad.";
      render();
    }
  }, 30000);
  // Refresco silencioso para ver lo que capturan otras computadoras.
  function maybeRefresh(){
    if(ui.currentUser && !ui.loading && !ui.pinFlow && !ui.authFlow && !ui.busy && Date.now() - lastLoadAt > 60000){
      loadData({silent:true});
    }
  }
  setInterval(maybeRefresh, 120000);
  document.addEventListener("visibilitychange", function(){ if(!document.hidden) maybeRefresh(); });
  window.addEventListener("online", function(){ if(ui.offline){ ui.offline = false; maybeRefresh(); render(); } });
  window.addEventListener("offline", function(){ if(ui.currentUser){ ui.offline = true; render(); } });


  // ---------- Event delegation ----------
  document.addEventListener("click", function(e){
    var actionEl = e.target.closest ? e.target.closest("[data-action]") : null;
    if(actionEl){
      var action = actionEl.dataset.action;
      var id = actionEl.dataset.id;
      switch(action){
        case "set-tab": setTab(actionEl.dataset.tab); break;
        case "load-more": ui.visible[actionEl.dataset.key] = (ui.visible[actionEl.dataset.key]||ui.pageSize) + ui.pageSize; render(); break;
        case "open-new-employee":
          ui.empForm = {numero:"",nombre:"",pin:"",pin2:""}; ui.empFormError="";
          ui.showNewEmployeeModal = true; render(); break;
        case "close-new-employee": ui.showNewEmployeeModal = false; render(); break;
        case "request-delete-employee": ui.confirmDeleteEmpId = id; render(); break;
        case "cancel-delete-employee": ui.confirmDeleteEmpId = null; render(); break;
        case "confirm-delete-employee": {
          // La baja siempre la autoriza un supervisor/admin (la base lo exige).
          var tieneActivos = resguardos.some(function(r){ return r.employeeId===id && r.estado==="activo"; });
          openAuth(tieneActivos ? "delete-employee-cascade" : "delete-employee", {employeeId:id});
          break;
        }
        case "request-delete-tool": ui.confirmDeleteToolId = id; render(); break;
        case "cancel-delete-tool": ui.confirmDeleteToolId = null; render(); break;
        case "confirm-delete-tool": deleteTool(id); break;
        case "devolver": confirmReturn(id); break;
        case "devolver-cancel": ui.confirmReturnId = null; render(); break;
        case "devolver-confirm": submitReturn(id); break;
        case "pin-digit": pinPress(actionEl.dataset.digit); break;
        case "pin-del": pinDel(); break;
        case "pin-cancel": if(ui.pinFlow && !ui.pinFlow.pending){ ui.pinFlow = null; render(); } break;
        case "view-employee-tools": ui.viewEmployeeToolsId = id; render(); break;
        case "close-employee-tools": ui.viewEmployeeToolsId = null; render(); break;
        case "quitar-sin-pin": openAuth("quitar-sin-pin", {resguardoId:id}); break;
        case "cambiar-nip": openAuth("cambiar-nip", {employeeId:id}); break;
        case "auth-cancel": if(ui.authFlow && !ui.authFlow.pending){ ui.authFlow = null; render(); } break;
        case "edit-fecha-start":
          ui.editingFechaId = id;
          var rEdit = null;
          for(var j=0;j<resguardos.length;j++) if(resguardos[j].id===id) rEdit=resguardos[j];
          ui.editFechaValue = rEdit ? rEdit.fechaPrestamo : todayISO();
          render();
          break;
        case "edit-fecha-cancel": ui.editingFechaId = null; render(); break;
        case "edit-fecha-save": saveFecha(id); break;
        case "cart-remove":
          ui.cart = ui.cart.filter(function(c){ return c.tempId !== id; });
          render();
          break;
        case "cart-add": addToCart(); break;
        case "logout": logout(); break;
        case "retry-load": loadData(); break;
        case "export-legacy": exportLegacyData(); break;
        case "clear-legacy-ask": ui.confirmClearLegacy = true; render(); break;
        case "clear-legacy-cancel": ui.confirmClearLegacy = false; render(); break;
        case "clear-legacy": clearLegacyData(); break;
        case "open-new-user":
          ui.newUserForm = {username:"",password:"",password2:"",rol:"supervisor"}; ui.newUserError="";
          ui.showNewUserModal = true; render(); break;
        case "close-new-user": ui.showNewUserModal = false; render(); break;
        case "toggle-user": {
          var tu = users.filter(function(u){ return u.id===id; })[0];
          if(tu) openAuth("admin-user", {userId:id, rol:tu.rol, activo:!tu.activo, email:tu.email});
          break;
        }
      }
      return;
    }
  });


  document.addEventListener("input", function(e){
    var id = e.target.id, v = e.target.value;
    switch(id){
      case "input-emp-query": ui.empQuery = v; ui.form.employeeId=""; break;
      case "input-tool-query": ui.toolQuery = v; ui.form.herramienta = v; break;
      case "input-cantidad": ui.form.cantidad = v; break;
      case "input-occ": ui.form.occ = v; break;
      case "input-idarticulo": {
        ui.form.idArticulo = v;
        var foundTool = findToolByIdArticulo(v);
        if(foundTool){
          ui.toolQuery = foundTool.nombre; ui.form.herramienta = foundTool.nombre;
          ui.form.idArticuloHint = "Vinculado: " + foundTool.nombre;
          ui.form.idArticuloMatched = true;
        } else {
          ui.form.idArticuloHint = v.trim() ? "Sin registro con ese ID en el catálogo; selecciona o escribe la herramienta manualmente." : "";
          ui.form.idArticuloMatched = false;
        }
        render();
        break;
      }
      case "input-notas": ui.form.notas = v; break;
      case "input-search-activos": ui.query = v; ui.visible.activos = ui.pageSize; render(); break;
      case "input-search-historial": ui.query = v; ui.visible.historial = ui.pageSize; render(); break;
      case "input-search-table": ui.tableQuery = v; ui.visible.tabla = ui.pageSize; render(); break;
      case "input-search-catalog": ui.catQuery = v; ui.visible.catalogo = ui.pageSize; render(); break;
      case "input-search-employees": ui.empListQuery = v; ui.visible.empleados = ui.pageSize; render(); break;
      case "input-cat-nombre": ui.catForm.nombre = v; break;
      case "input-cat-idarticulo": ui.catForm.idArticulo = v; break;
      case "input-emp-numero": ui.empForm.numero = v; break;
      case "input-emp-nombre": ui.empForm.nombre = v; break;
      case "input-emp-pin": { var p=v.replace(/\D/g,"").slice(0,4); ui.empForm.pin=p; e.target.value=p; break; }
      case "input-emp-pin2": { var p2=v.replace(/\D/g,"").slice(0,4); ui.empForm.pin2=p2; e.target.value=p2; break; }
      case "input-login-user": ui.loginForm.username = v; break;
      case "input-login-pass": ui.loginForm.password = v; break;
      case "input-newuser-username": ui.newUserForm.username = v; break;
      case "input-newuser-password": ui.newUserForm.password = v; break;
      case "input-newuser-password2": ui.newUserForm.password2 = v; break;
      case "input-newuser-rol": ui.newUserForm.rol = v; break;
      case "input-fecha-prestamo": ui.form.fechaPrestamo = v; break;
      case "input-auth-user": if(ui.authFlow) ui.authFlow.username = v; break;
      case "input-auth-pass": if(ui.authFlow) ui.authFlow.password = v; break;
      case "input-auth-pin": { var ap=v.replace(/\D/g,"").slice(0,4); if(ui.authFlow) ui.authFlow.pin=ap; e.target.value=ap; break; }
      case "input-auth-pin2": { var ap2=v.replace(/\D/g,"").slice(0,4); if(ui.authFlow) ui.authFlow.pin2=ap2; e.target.value=ap2; break; }
      default:
        if(id && id.indexOf("input-edit-fecha-")===0){ ui.editFechaValue = v; }
    }
  });

  // Cambio de rol de una cuenta (pide confirmación de admin)
  document.addEventListener("change", function(e){
    var t = e.target;
    if(t && t.dataset && t.dataset.action === "user-rol"){
      var cu = users.filter(function(u){ return u.id===t.dataset.id; })[0];
      var rol = ["admin","supervisor","almacen"].indexOf(t.value) >= 0 ? t.value : "almacen";
      if(cu) openAuth("admin-user", {userId:cu.id, rol:rol, activo:!!cu.activo, email:cu.email});
    }
  });

  ["click","keydown","input"].forEach(function(ev){ document.addEventListener(ev, touchActivity, true); });

  document.addEventListener("submit", function(e){
    e.preventDefault();
    if(e.target.id === "form-login") submitLogin();
    else if(e.target.id === "form-new-user") submitNewUser();
    else if(e.target.id === "form-auth") submitAuth();
    else if(e.target.id === "form-new-employee") submitNewEmployee();
    else if(e.target.id === "form-new-tool") submitNewTool();
    else if(e.target.id === "form-new-resguardo") submitNewResguardo();
  });

  document.addEventListener("keydown", function(e){
    var tid = e.target && e.target.id;
    if(e.key === "Escape"){
      if(ui.pinFlow && !ui.pinFlow.pending){ ui.pinFlow = null; render(); return; }
      if(ui.authFlow && !ui.authFlow.pending){ ui.authFlow = null; render(); return; }
      if(ui.showNewEmployeeModal){ ui.showNewEmployeeModal = false; render(); return; }
      if(ui.showNewUserModal){ ui.showNewUserModal = false; render(); return; }
      if(ui.viewEmployeeToolsId){ ui.viewEmployeeToolsId = null; render(); return; }
      if(ui.editingFechaId){ ui.editingFechaId = null; render(); return; }
      if(ui.confirmReturnId && !ui.busy){ ui.confirmReturnId = null; render(); return; }
    }
    if(e.key === "Enter" && (tid==="input-tool-query" || tid==="input-idarticulo" || tid==="input-occ" || tid==="input-cantidad")){
      e.preventDefault();
      addToCart();
      return;
    }
    if(!ui.pinFlow || ui.pinFlow.pending) return;
    if(/^[0-9]$/.test(e.key)){ e.preventDefault(); pinPress(e.key); }
    else if(e.key === "Backspace" || e.key === "Delete"){ e.preventDefault(); pinDel(); }
  });

  // ---------- Init ----------
  // Si la pestaña ya tenía sesión (recarga), se restaura con el refresh token.
  (function init(){
    if(!configOk()){ ui.booting = false; render(); return; }
    var hasStored = false;
    try{ hasStored = !!sessionStorage.getItem(SESSION_KEY); }catch(e){}
    if(!hasStored){ ui.booting = false; render(); return; }
    render();
    refreshSession().then(loadProfile).then(function(){
      ui.booting = false; touchActivity(); return loadData();
    }).catch(function(e){
      ui.booting = false;
      if(session){ storeSession(null); }
      ui.currentUser = null;
      ui.loginError = e.network ? e.message : (e.code === "inactive" ? e.message : "");
      render();
    });
  })();
})();
