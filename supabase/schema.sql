-- =====================================================================
--  Citrojugo · Resguardo de herramienta — Esquema de base de datos
--  Supabase (PostgreSQL 15+) · Row Level Security en todas las tablas
-- ---------------------------------------------------------------------
--  Cómo usarlo: en el panel de Supabase → SQL Editor → New query →
--  pega TODO este archivo → Run. Se puede volver a ejecutar sin perder
--  datos (crea lo que falte y reemplaza funciones y políticas).
--
--  Principios:
--   * El navegador solo tiene la clave pública "anon". Con ella, sin
--     sesión, NO se puede leer ni escribir nada (sin GRANT y con RLS).
--   * Con sesión (Supabase Auth) y perfil ACTIVO se puede LEER.
--   * TODA escritura pasa por funciones RPC (SECURITY DEFINER, con
--     search_path vacío) que validan rol, datos y dejan bitácora.
--     Las tablas no tienen INSERT/UPDATE/DELETE para los clientes.
--   * Los NIP viven con hash bcrypt en el esquema privado "app", que
--     la API no expone y que ningún rol cliente puede leer.
-- =====================================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create schema if not exists app;
revoke all on schema app from public;
-- "authenticated" necesita USAGE para evaluar las funciones auxiliares
-- de las políticas RLS. La API (PostgREST) NO expone este esquema.
grant usage on schema app to authenticated;

-- ---------------------------------------------------------------------
-- Ajustes de seguridad (una sola fila; editable desde el SQL Editor)
-- ---------------------------------------------------------------------
create table if not exists app.ajustes (
  id                       int primary key default 1 check (id = 1),
  nip_max_intentos         int  not null default 5,     -- fallos seguidos antes de bloquear
  nip_bloqueo_minutos      int  not null default 15,    -- 1er bloqueo; se duplica en cada bloqueo seguido
  nip_bloqueo_max_minutos  int  not null default 1440,  -- tope del bloqueo (24 h)
  usuario_max_fallos_hora  int  not null default 20,    -- NIP fallidos por cuenta de usuario en 1 hora
  usuario_max_fallos_dia   int  not null default 40,    -- NIP fallidos por cuenta de usuario en 24 horas
  reauth_segundos          int  not null default 300,   -- antigüedad máxima de la contraseña para acciones de supervisor (0 = no exigir)
  permitir_nip_0000        boolean not null default true, -- false = quien tenga NIP 0000 heredado no puede recibir herramienta hasta que se le asigne otro
  permitir_nip_importado   boolean not null default true, -- (heredado de versiones con migración; sin efecto en arranque en blanco)
  zona_horaria             text not null default 'America/Mexico_City'
);
alter table app.ajustes add column if not exists permitir_nip_0000 boolean not null default true;
alter table app.ajustes add column if not exists permitir_nip_importado boolean not null default true;
alter table app.ajustes add column if not exists usuario_max_fallos_dia int not null default 40;
insert into app.ajustes (id) values (1) on conflict (id) do nothing;
alter table app.ajustes enable row level security;
revoke all on app.ajustes from public;

-- ---------------------------------------------------------------------
-- Normalización de nombres (igual que norm() del navegador):
-- minúsculas, sin acentos, espacios colapsados.
-- ---------------------------------------------------------------------
create or replace function app.norm(t text)
returns text language sql immutable parallel safe
set search_path = ''
as $$
  select regexp_replace(
           regexp_replace(normalize(lower(btrim(coalesce(t, ''))), NFD), '[̀-ͯ]', '', 'g'),
           '\s+', ' ', 'g')
$$;

-- Número de empleado normalizado: sin espacios, mayúsculas; '' -> NULL.
create or replace function app.norm_num(t text)
returns text language sql immutable parallel safe
set search_path = ''
as $$
  select nullif(upper(regexp_replace(coalesce(t, ''), '\s+', '', 'g')), '')
$$;

-- =====================================================================
-- TABLAS
-- =====================================================================

-- Perfiles: uno por usuario de Supabase Auth. Nace INACTIVO.
create table if not exists public.perfiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text not null default '',
  nombre     text not null default '',
  rol        text not null default 'almacen' check (rol in ('admin', 'supervisor', 'almacen')),
  activo     boolean not null default false,
  creado_en  timestamptz not null default now()
);

-- Cargo visible (p. ej. "Gerente"). Solo es una etiqueta: los permisos los da "rol".
alter table public.perfiles add column if not exists cargo text not null default '';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'perfiles_cargo_len') then
    alter table public.perfiles add constraint perfiles_cargo_len check (char_length(cargo) <= 40);
  end if;
end $$;

create table if not exists public.colaboradores (
  id           uuid primary key default gen_random_uuid(),
  nombre       text not null check (char_length(btrim(nombre)) between 1 and 120),
  nombre_norm  text generated always as (app.norm(nombre)) stored,
  area         text not null default '' check (char_length(area) <= 80),
  activo       boolean not null default true,
  creado_en    timestamptz not null default now(),
  creado_por   uuid,
  baja_en      timestamptz,
  baja_por     uuid
);
-- true = el colaborador no tiene NIP utilizable (sin asignar, 0000 heredado o importado)
-- y un supervisor debe asignarle uno antes de que pueda recibir herramienta.
alter table public.colaboradores add column if not exists nip_pendiente boolean not null default false;
-- Número de empleado que asigna la empresa (identificador oficial). Obligatorio en
-- altas nuevas (lo exigen alta_colaborador e importar_colaboradores); único entre
-- los colaboradores activos. Se guarda en mayúsculas y sin espacios.
alter table public.colaboradores add column if not exists numero_empleado text;
alter table public.colaboradores add column if not exists puesto text not null default '';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'colaboradores_numero_empleado_formato') then
    alter table public.colaboradores add constraint colaboradores_numero_empleado_formato
      check (numero_empleado is null or numero_empleado ~ '^[A-Z0-9][A-Z0-9._/-]{0,29}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'colaboradores_puesto_largo') then
    alter table public.colaboradores add constraint colaboradores_puesto_largo check (char_length(puesto) <= 80);
  end if;
end $$;
create unique index if not exists colaboradores_numero_activo_uq
  on public.colaboradores (numero_empleado) where activo and numero_empleado is not null;
-- El nombre ya no es único (puede haber homónimos); el número de empleado sí.
drop index if exists public.colaboradores_nombre_activo_uq;
create index if not exists colaboradores_nombre_idx on public.colaboradores (nombre_norm) where activo;

-- NIP con hash bcrypt. Esquema privado, sin GRANT, RLS sin políticas.
create table if not exists app.colaborador_nip (
  colaborador_id     uuid primary key references public.colaboradores (id) on delete cascade,
  nip_hash           text not null,
  nip_por_defecto    boolean not null default false,  -- true si el NIP es 0000 (heredado)
  nip_importado      boolean not null default false,  -- (heredado; en arranque en blanco siempre false)
  intentos_fallidos  int not null default 0,
  bloqueos           int not null default 0,
  bloqueado_hasta    timestamptz,
  actualizado_en     timestamptz not null default now()
);

alter table app.colaborador_nip add column if not exists nip_importado boolean not null default false;

create table if not exists public.herramientas (
  id           uuid primary key default gen_random_uuid(),
  nombre       text not null check (char_length(btrim(nombre)) between 1 and 200),
  nombre_norm  text generated always as (app.norm(nombre)) stored,
  id_articulo  text not null default '' check (char_length(id_articulo) <= 60),
  creado_en    timestamptz not null default now(),
  creado_por   uuid
);
create unique index if not exists herramientas_nombre_uq on public.herramientas (nombre_norm);

create table if not exists public.resguardos (
  id                uuid primary key default gen_random_uuid(),
  grupo_id          uuid,
  colaborador_id    uuid not null references public.colaboradores (id) on delete restrict,
  herramienta       text not null check (char_length(btrim(herramienta)) between 1 and 200),
  cantidad          int  not null default 1 check (cantidad between 1 and 9999),
  occ               text not null default '' check (char_length(occ) <= 60),
  id_articulo       text not null default '' check (char_length(id_articulo) <= 60),
  fecha_prestamo    date,
  fecha_devolucion  date,
  estado            text not null default 'activo' check (estado in ('activo', 'devuelto')),
  notas             text not null default '' check (char_length(notas) <= 500),
  creado_por        text not null default '',
  creado_por_id     uuid,
  devuelto_por      text not null default '',
  devuelto_por_id   uuid,
  creado_en         timestamptz not null default now(),
  actualizado_en    timestamptz not null default now(),
  import_key        text unique
);
create index if not exists resguardos_colab_activo_idx on public.resguardos (colaborador_id) where estado = 'activo';
create index if not exists resguardos_grupo_idx on public.resguardos (grupo_id);
create index if not exists resguardos_creado_idx on public.resguardos (creado_en desc, id);

-- Bitácora de auditoría: solo se agrega; nadie la edita ni borra.
create table if not exists public.bitacora (
  id          bigint generated always as identity primary key,
  ts          timestamptz not null default now(),
  usuario_id  uuid,
  usuario     text not null default '',
  accion      text not null,
  entidad     text not null default '',
  entidad_id  text,
  detalle     jsonb not null default '{}'::jsonb
);
create index if not exists bitacora_usuario_accion_idx on public.bitacora (usuario_id, accion, ts desc);
create index if not exists bitacora_ts_idx on public.bitacora (ts desc);

create or replace function app.bitacora_inmutable()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = '42501', message = 'La bitácora no se puede modificar ni borrar.';
end $$;
drop trigger if exists bitacora_inmutable on public.bitacora;
create trigger bitacora_inmutable before update or delete on public.bitacora
  for each row execute function app.bitacora_inmutable();
drop trigger if exists bitacora_inmutable_trunc on public.bitacora;
create trigger bitacora_inmutable_trunc before truncate on public.bitacora
  for each statement execute function app.bitacora_inmutable();

-- =====================================================================
-- FUNCIONES AUXILIARES (esquema privado app)
-- =====================================================================

-- Rol del usuario de la sesión, o NULL si no hay sesión o está inactivo.
create or replace function app.rol_actual()
returns text language sql stable security definer set search_path = '' as $$
  select p.rol from public.perfiles p where p.id = auth.uid() and p.activo
$$;

create or replace function app.usuario_activo()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.perfiles p where p.id = auth.uid() and p.activo)
$$;

create or replace function app.es_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.perfiles p where p.id = auth.uid() and p.activo and p.rol = 'admin')
$$;

create or replace function app.nombre_actual()
returns text language sql stable security definer set search_path = '' as $$
  select coalesce(nullif(p.nombre, ''), p.email, '') from public.perfiles p where p.id = auth.uid()
$$;

create or replace function app.hoy()
returns date language sql stable security definer set search_path = '' as $$
  select (now() at time zone (select a.zona_horaria from app.ajustes a where a.id = 1))::date
$$;

-- ¿La contraseña se escribió hace poco? Lee el claim "amr" del JWT de
-- Supabase Auth ([{"method":"password","timestamp":...}]). Falla cerrado.
create or replace function app.reauth_reciente()
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  v_seg int;
  v_amr jsonb := auth.jwt() -> 'amr';
  v_ts  bigint;
begin
  select a.reauth_segundos into v_seg from app.ajustes a where a.id = 1;
  if coalesce(v_seg, 0) <= 0 then return true; end if;
  if v_amr is null or jsonb_typeof(v_amr) <> 'array' then return false; end if;
  select max((e ->> 'timestamp')::bigint) into v_ts
    from jsonb_array_elements(v_amr) e
   where jsonb_typeof(e) = 'object'
     and e ->> 'method' in ('password', 'otp', 'totp', 'mfa/totp')
     and (e ->> 'timestamp') ~ '^[0-9]+$';
  return v_ts is not null and v_ts >= extract(epoch from now())::bigint - v_seg;
end $$;

-- Exige sesión activa con uno de los roles; opcionalmente contraseña reciente.
create or replace function app.exigir(p_roles text[], p_reauth boolean default false)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_rol text := app.rol_actual();
begin
  if v_rol is null then
    raise exception using errcode = '42501', message = 'Sesión no válida o cuenta inactiva. Vuelve a iniciar sesión.';
  end if;
  if not (v_rol = any (p_roles)) then
    raise exception using errcode = '42501', message = 'Solo un supervisor o administrador puede autorizar esta acción.';
  end if;
  if p_reauth and not app.reauth_reciente() then
    raise exception using errcode = '42501', message = 'Por seguridad, confirma de nuevo tu correo y contraseña.', hint = 'reauth';
  end if;
  return v_rol;
end $$;

create or replace function app.log(p_accion text, p_entidad text, p_entidad_id text, p_detalle jsonb default '{}'::jsonb)
returns void language sql volatile security definer set search_path = '' as $$
  insert into public.bitacora (usuario_id, usuario, accion, entidad, entidad_id, detalle)
  values (auth.uid(), coalesce(app.nombre_actual(), ''), p_accion, coalesce(p_entidad, ''), p_entidad_id, coalesce(p_detalle, '{}'::jsonb));
$$;

create or replace function app.resguardo_json(r public.resguardos)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', r.id, 'grupo_id', r.grupo_id, 'colaborador_id', r.colaborador_id,
    'herramienta', r.herramienta, 'cantidad', r.cantidad, 'occ', r.occ, 'id_articulo', r.id_articulo,
    'fecha_prestamo', r.fecha_prestamo, 'fecha_devolucion', r.fecha_devolucion, 'estado', r.estado,
    'notas', r.notas, 'creado_por', r.creado_por, 'devuelto_por', r.devuelto_por, 'creado_en', r.creado_en)
$$;

-- Perfil automático al crear un usuario en Supabase Auth (nace inactivo).
create or replace function app.nuevo_usuario()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.perfiles (id, email, nombre, rol, activo)
  values (new.id, coalesce(new.email, ''), coalesce(new.raw_user_meta_data ->> 'nombre', ''), 'almacen', false)
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists citrojugo_nuevo_usuario on auth.users;
create trigger citrojugo_nuevo_usuario after insert on auth.users
  for each row execute function app.nuevo_usuario();

create or replace function app.usuario_email_cambio()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.perfiles set email = coalesce(new.email, '') where id = new.id;
  return new;
end $$;
drop trigger if exists citrojugo_usuario_email on auth.users;
create trigger citrojugo_usuario_email after update of email on auth.users
  for each row execute function app.usuario_email_cambio();

-- Candado en la base para las cuentas: con una sesión de usuario, SOLO un admin
-- activo puede cambiar rol, activo, nombre o correo de un perfil, o borrarlo.
-- (Almacén y supervisor no tienen GRANT de escritura; esto cubre además
-- cualquier función futura con SECURITY DEFINER.) El SQL Editor del panel y la
-- service_role no llevan auth.uid(), así que siguen pudiendo administrar.
create or replace function app.proteger_perfiles()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null and not app.es_admin() then
    if tg_op = 'DELETE'
       or new.rol is distinct from old.rol or new.activo is distinct from old.activo
       or new.nombre is distinct from old.nombre or new.cargo is distinct from old.cargo
       or new.id is distinct from old.id then
      raise exception using errcode = '42501', message = 'Solo un administrador puede modificar cuentas de usuario.';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists proteger_perfiles on public.perfiles;
create trigger proteger_perfiles before update or delete on public.perfiles
  for each row execute function app.proteger_perfiles();

-- =====================================================================
-- FUNCIONES RPC (las únicas que puede llamar el navegador)
-- =====================================================================

-- ---------- Nuevo resguardo autorizado con NIP ----------
drop function if exists public.crear_resguardo(uuid, text, jsonb, date, text);
-- Devuelve jsonb {ok:false,...} en NIP incorrecto/bloqueo (NO lanza
-- excepción, para que el contador de intentos quede guardado).
create or replace function public.crear_resguardo(
  p_colaborador_id uuid,
  p_nip            text,
  p_items          jsonb,
  p_fecha          date default null,
  p_notas          text default '',
  p_solicitud      uuid default null   -- id único generado por el navegador: reintentos no duplican
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid     uuid := auth.uid();
  v_user    text;
  v_cfg     app.ajustes%rowtype;
  v_nip     app.colaborador_nip%rowtype;
  v_col     public.colaboradores%rowtype;
  v_hoy     date := app.hoy();
  v_fecha   date;
  v_notas   text := btrim(coalesce(p_notas, ''));
  v_fallos  int;
  v_item    jsonb;
  v_herr    text; v_cant int; v_occ text; v_ida text;
  v_grupo   uuid := coalesce(p_solicitud, gen_random_uuid());
  v_row     public.resguardos%rowtype;
  v_rows    jsonb := '[]'::jsonb;
  v_tools   jsonb := '[]'::jsonb;
  v_tool    public.herramientas%rowtype;
  v_min     int;
begin
  perform app.exigir(array['admin', 'supervisor', 'almacen']);
  v_user := app.nombre_actual();
  select * into v_cfg from app.ajustes where id = 1;

  -- 1) Validación de datos (no consume intentos de NIP)
  if p_nip is null or p_nip !~ '^[0-9]{4}$' then
    return jsonb_build_object('ok', false, 'error', 'nip_formato', 'mensaje', 'El NIP debe tener 4 dígitos.');
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 50 then
    raise exception using errcode = '22023', message = 'Agrega entre 1 y 50 herramientas al resguardo.';
  end if;
  for v_item in select * from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_item) <> 'object' then
      raise exception using errcode = '22023', message = 'Lista de herramientas no válida.';
    end if;
    v_herr := btrim(coalesce(v_item ->> 'herramienta', ''));
    if char_length(v_herr) < 1 or char_length(v_herr) > 200 then
      raise exception using errcode = '22023', message = 'Cada herramienta necesita un nombre (máx. 200 caracteres).';
    end if;
    if coalesce(v_item ->> 'cantidad', '1') !~ '^[0-9]{1,4}$' or coalesce((v_item ->> 'cantidad')::int, 1) < 1 then
      raise exception using errcode = '22023', message = 'La cantidad debe ser un número entre 1 y 9999.';
    end if;
    if char_length(coalesce(v_item ->> 'occ', '')) > 60 or char_length(coalesce(v_item ->> 'id_articulo', '')) > 60 then
      raise exception using errcode = '22023', message = 'OCC e ID de artículo admiten máximo 60 caracteres.';
    end if;
  end loop;
  v_fecha := coalesce(p_fecha, v_hoy);
  if v_fecha > v_hoy then
    raise exception using errcode = '22023', message = 'La fecha de entrega no puede ser futura.';
  end if;
  if char_length(v_notas) > 500 then
    raise exception using errcode = '22023', message = 'Las notas admiten máximo 500 caracteres.';
  end if;

  select * into v_col from public.colaboradores where id = p_colaborador_id and activo;
  if not found then
    raise exception using errcode = '22023', message = 'Colaborador no encontrado o dado de baja.';
  end if;

  -- 2) Límite por cuenta de usuario (evita barrer NIPs de muchos colaboradores)
  select count(*) filter (where ts > now() - interval '1 hour'), count(*) into v_fallos, v_min
    from public.bitacora
   where usuario_id = v_uid and accion = 'nip_incorrecto' and ts > now() - interval '24 hours';
  if v_fallos >= v_cfg.usuario_max_fallos_hora or v_min >= v_cfg.usuario_max_fallos_dia then
    perform app.log('nip_limite_usuario', 'colaborador', p_colaborador_id::text, jsonb_build_object('fallos_ultima_hora', v_fallos));
    return jsonb_build_object('ok', false, 'error', 'limite_usuario',
      'mensaje', 'Demasiados NIP incorrectos desde esta cuenta. Espera o avisa a un administrador.');
  end if;
  v_min := null;

  -- 3) Verificación de NIP con bloqueo por colaborador (fila bloqueada: sin carreras)
  select * into v_nip from app.colaborador_nip where colaborador_id = p_colaborador_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'sin_nip',
      'mensaje', 'Este colaborador aún no tiene NIP asignado. Un supervisor debe asignárselo (Colaboradores → NIP).');
  end if;
  if v_nip.bloqueado_hasta is not null and v_nip.bloqueado_hasta > now() then
    perform app.log('nip_intento_bloqueado', 'colaborador', p_colaborador_id::text, jsonb_build_object('bloqueado_hasta', v_nip.bloqueado_hasta));
    return jsonb_build_object('ok', false, 'error', 'bloqueado', 'bloqueado_hasta', v_nip.bloqueado_hasta,
      'mensaje', 'NIP bloqueado por intentos fallidos. Intenta después de las ' ||
                 to_char(v_nip.bloqueado_hasta at time zone v_cfg.zona_horaria, 'HH24:MI') || '.');
  end if;

  if extensions.crypt(p_nip, v_nip.nip_hash) is distinct from v_nip.nip_hash then
    v_nip.intentos_fallidos := v_nip.intentos_fallidos + 1;
    if v_nip.intentos_fallidos >= v_cfg.nip_max_intentos then
      v_nip.bloqueos := v_nip.bloqueos + 1;
      v_min := least(v_cfg.nip_bloqueo_minutos * power(2, least(v_nip.bloqueos - 1, 10))::int, v_cfg.nip_bloqueo_max_minutos);
      v_nip.bloqueado_hasta := now() + make_interval(mins => v_min);
      v_nip.intentos_fallidos := 0;
    end if;
    update app.colaborador_nip
       set intentos_fallidos = v_nip.intentos_fallidos, bloqueos = v_nip.bloqueos,
           bloqueado_hasta = v_nip.bloqueado_hasta, actualizado_en = now()
     where colaborador_id = p_colaborador_id;
    perform app.log('nip_incorrecto', 'colaborador', p_colaborador_id::text,
      jsonb_build_object('colaborador', v_col.nombre, 'intentos', v_nip.intentos_fallidos));
    if v_nip.bloqueado_hasta is not null and v_nip.bloqueado_hasta > now() then
      perform app.log('nip_bloqueado', 'colaborador', p_colaborador_id::text,
        jsonb_build_object('colaborador', v_col.nombre, 'minutos', v_min, 'bloqueado_hasta', v_nip.bloqueado_hasta));
      return jsonb_build_object('ok', false, 'error', 'bloqueado', 'bloqueado_hasta', v_nip.bloqueado_hasta,
        'mensaje', 'NIP incorrecto. Se bloqueó por ' || v_min || ' minutos por seguridad.');
    end if;
    return jsonb_build_object('ok', false, 'error', 'nip_incorrecto',
      'intentos_restantes', v_cfg.nip_max_intentos - v_nip.intentos_fallidos,
      'mensaje', 'NIP incorrecto. Te quedan ' || (v_cfg.nip_max_intentos - v_nip.intentos_fallidos) || ' intento(s).');
  end if;

  -- 4) NIP correcto. Si es el 0000 heredado, aplicar la política configurada.
  if v_nip.nip_importado and not v_cfg.permitir_nip_importado then
    perform app.log('nip_importado_rechazado', 'colaborador', p_colaborador_id::text, jsonb_build_object('colaborador', v_col.nombre));
    return jsonb_build_object('ok', false, 'error', 'nip_pendiente',
      'mensaje', 'Por seguridad, este colaborador necesita un NIP nuevo. Pide a un supervisor que se lo asigne.');
  end if;
  if v_nip.nip_por_defecto and not v_cfg.permitir_nip_0000 then
    perform app.log('nip_0000_rechazado', 'colaborador', p_colaborador_id::text, jsonb_build_object('colaborador', v_col.nombre));
    return jsonb_build_object('ok', false, 'error', 'nip_pendiente',
      'mensaje', 'Este colaborador aún tiene el NIP 0000. Un supervisor debe asignarle un NIP nuevo.');
  end if;
  -- Reintento de una solicitud que ya se guardó (p. ej. se cortó la red al responder)
  if p_solicitud is not null and exists (select 1 from public.resguardos where grupo_id = p_solicitud) then
    if exists (select 1 from public.resguardos where grupo_id = p_solicitud and colaborador_id <> p_colaborador_id) then
      raise exception using errcode = '22023', message = 'Solicitud duplicada no válida.';
    end if;
    return jsonb_build_object('ok', true, 'repetida', true, 'herramientas', '[]'::jsonb,
      'resguardos', (select jsonb_agg(app.resguardo_json(r) order by r.creado_en) from public.resguardos r where r.grupo_id = p_solicitud));
  end if;
  -- Reiniciar contadores y crear los resguardos (misma transacción)
  update app.colaborador_nip set intentos_fallidos = 0, bloqueos = 0, bloqueado_hasta = null, actualizado_en = now()
   where colaborador_id = p_colaborador_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_herr := btrim(v_item ->> 'herramienta');
    v_cant := coalesce((v_item ->> 'cantidad')::int, 1);
    v_occ  := btrim(coalesce(v_item ->> 'occ', ''));
    v_ida  := btrim(coalesce(v_item ->> 'id_articulo', ''));
    insert into public.resguardos (grupo_id, colaborador_id, herramienta, cantidad, occ, id_articulo,
                                   fecha_prestamo, estado, notas, creado_por, creado_por_id)
    values (v_grupo, p_colaborador_id, v_herr, v_cant, v_occ, v_ida, v_fecha, 'activo', v_notas, v_user, v_uid)
    returning * into v_row;
    v_rows := v_rows || jsonb_build_array(app.resguardo_json(v_row));

    insert into public.herramientas (nombre, id_articulo, creado_por)
    values (v_herr, v_ida, v_uid)
    on conflict (nombre_norm) do nothing
    returning * into v_tool;
    if v_tool.id is not null then
      v_tools := v_tools || jsonb_build_array(jsonb_build_object('id', v_tool.id, 'nombre', v_tool.nombre, 'id_articulo', v_tool.id_articulo));
      v_tool := null;
    end if;
  end loop;

  perform app.log('resguardo_creado', 'colaborador', p_colaborador_id::text,
    jsonb_build_object('colaborador', v_col.nombre, 'grupo_id', v_grupo, 'piezas', jsonb_array_length(v_rows), 'nip_0000', v_nip.nip_por_defecto,
                       'herramientas', (select jsonb_agg(x ->> 'herramienta') from jsonb_array_elements(v_rows) x)));
  return jsonb_build_object('ok', true, 'resguardos', v_rows, 'herramientas', v_tools, 'nip_pendiente', v_nip.nip_por_defecto);
end $$;

-- ---------- Devolución / quitar sin NIP (supervisor/admin, contraseña reciente) ----------
create or replace function public.devolver_resguardo(p_resguardo_id uuid, p_tipo text default 'devolucion')
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_user text;
  v_row  public.resguardos%rowtype;
  v_sufijo text;
  v_rol  text;
  v_col  text;
begin
  if p_tipo not in ('devolucion', 'ajuste') then
    raise exception using errcode = '22023', message = 'Tipo de devolución no válido.';
  end if;
  if p_tipo = 'devolucion' then
    -- Devolución normal: cualquier usuario activo (almacén, supervisor, admin)
    -- con su propia sesión. Queda firmada con su identidad en la bitácora.
    v_rol := app.exigir(array['admin', 'supervisor', 'almacen']);
  else
    -- "Quitar sin NIP" (ajuste): solo supervisor/admin con contraseña reciente.
    v_rol := app.exigir(array['admin', 'supervisor'], true);
  end if;
  v_user := app.nombre_actual();
  v_sufijo := case when p_tipo = 'ajuste' then ' (ajuste admin)' else '' end;
  update public.resguardos
     set estado = 'devuelto', fecha_devolucion = app.hoy(), devuelto_por = v_user || v_sufijo,
         devuelto_por_id = auth.uid(), actualizado_en = now()
   where id = p_resguardo_id and estado = 'activo'
  returning * into v_row;
  if not found then
    raise exception using errcode = '22023', message = 'Ese resguardo no existe o ya estaba devuelto.';
  end if;
  select c.nombre into v_col from public.colaboradores c where c.id = v_row.colaborador_id;
  perform app.log(case when p_tipo = 'ajuste' then 'resguardo_quitado' else 'resguardo_devuelto' end,
                  'resguardo', v_row.id::text,
                  jsonb_build_object('herramienta', v_row.herramienta, 'cantidad', v_row.cantidad,
                                     'colaborador_id', v_row.colaborador_id, 'colaborador', v_col,
                                     'rol', v_rol, 'fecha_devolucion', v_row.fecha_devolucion));
  return app.resguardo_json(v_row);
end $$;

-- ---------- Verificación de NIP reutilizable (uso interno) ----------
-- Devuelve NULL si el NIP es correcto (y reinicia sus contadores) o un
-- jsonb {ok:false, error, mensaje} si no. Aplica el mismo bloqueo por
-- intentos y deja la misma bitácora que crear_resguardo.
create or replace function app.verificar_nip(p_colaborador_id uuid, p_nip text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_cfg app.ajustes%rowtype;
  v_nip app.colaborador_nip%rowtype;
  v_col public.colaboradores%rowtype;
  v_min int;
begin
  select * into v_cfg from app.ajustes where id = 1;
  select * into v_col from public.colaboradores where id = p_colaborador_id;
  if p_nip is null or p_nip !~ '^[0-9]{4}$' then
    return jsonb_build_object('ok', false, 'error', 'nip_formato', 'mensaje', 'El NIP debe tener 4 dígitos.');
  end if;
  select * into v_nip from app.colaborador_nip where colaborador_id = p_colaborador_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'sin_nip',
      'mensaje', v_col.nombre || ' aún no tiene NIP asignado. Un supervisor debe asignárselo (Colaboradores → NIP).');
  end if;
  if v_nip.bloqueado_hasta is not null and v_nip.bloqueado_hasta > now() then
    perform app.log('nip_intento_bloqueado', 'colaborador', p_colaborador_id::text, jsonb_build_object('bloqueado_hasta', v_nip.bloqueado_hasta));
    return jsonb_build_object('ok', false, 'error', 'bloqueado', 'bloqueado_hasta', v_nip.bloqueado_hasta,
      'mensaje', 'El NIP de ' || v_col.nombre || ' está bloqueado por intentos fallidos. Intenta después de las ' ||
                 to_char(v_nip.bloqueado_hasta at time zone v_cfg.zona_horaria, 'HH24:MI') || '.');
  end if;
  if extensions.crypt(p_nip, v_nip.nip_hash) is distinct from v_nip.nip_hash then
    v_nip.intentos_fallidos := v_nip.intentos_fallidos + 1;
    if v_nip.intentos_fallidos >= v_cfg.nip_max_intentos then
      v_nip.bloqueos := v_nip.bloqueos + 1;
      v_min := least(v_cfg.nip_bloqueo_minutos * power(2, least(v_nip.bloqueos - 1, 10))::int, v_cfg.nip_bloqueo_max_minutos);
      v_nip.bloqueado_hasta := now() + make_interval(mins => v_min);
      v_nip.intentos_fallidos := 0;
    end if;
    update app.colaborador_nip
       set intentos_fallidos = v_nip.intentos_fallidos, bloqueos = v_nip.bloqueos,
           bloqueado_hasta = v_nip.bloqueado_hasta, actualizado_en = now()
     where colaborador_id = p_colaborador_id;
    perform app.log('nip_incorrecto', 'colaborador', p_colaborador_id::text,
      jsonb_build_object('colaborador', v_col.nombre, 'intentos', v_nip.intentos_fallidos, 'accion', 'transferencia'));
    if v_nip.bloqueado_hasta is not null and v_nip.bloqueado_hasta > now() then
      perform app.log('nip_bloqueado', 'colaborador', p_colaborador_id::text,
        jsonb_build_object('colaborador', v_col.nombre, 'minutos', v_min, 'bloqueado_hasta', v_nip.bloqueado_hasta));
      return jsonb_build_object('ok', false, 'error', 'bloqueado', 'bloqueado_hasta', v_nip.bloqueado_hasta,
        'mensaje', 'NIP de ' || v_col.nombre || ' incorrecto. Se bloqueó por ' || v_min || ' minutos por seguridad.');
    end if;
    return jsonb_build_object('ok', false, 'error', 'nip_incorrecto',
      'intentos_restantes', v_cfg.nip_max_intentos - v_nip.intentos_fallidos,
      'mensaje', 'NIP de ' || v_col.nombre || ' incorrecto. Le quedan ' || (v_cfg.nip_max_intentos - v_nip.intentos_fallidos) || ' intento(s).');
  end if;
  if v_nip.nip_importado and not v_cfg.permitir_nip_importado then
    return jsonb_build_object('ok', false, 'error', 'nip_pendiente',
      'mensaje', v_col.nombre || ' necesita un NIP nuevo. Pide a un supervisor que se lo asigne.');
  end if;
  if v_nip.nip_por_defecto and not v_cfg.permitir_nip_0000 then
    return jsonb_build_object('ok', false, 'error', 'nip_pendiente',
      'mensaje', v_col.nombre || ' aún tiene el NIP 0000. Un supervisor debe asignarle un NIP nuevo.');
  end if;
  update app.colaborador_nip set intentos_fallidos = 0, bloqueos = 0, bloqueado_hasta = null, actualizado_en = now()
   where colaborador_id = p_colaborador_id;
  return null;
end $$;

-- ---------- Transferencia de herramienta entre colaboradores ----------
-- El colaborador que entrega y el que recibe confirman con su NIP. El
-- resguardo original se cierra ("transferido a …") y se crea uno nuevo a
-- nombre de quien recibe, en la misma transacción. Cualquier usuario activo.
create or replace function public.transferir_resguardo(
  p_resguardo_id uuid,
  p_destino_id   uuid,
  p_nip_origen   text,
  p_nip_destino  text,
  p_solicitud    uuid default null   -- id único del navegador: un reintento no duplica
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid    uuid := auth.uid();
  v_user   text;
  v_cfg    app.ajustes%rowtype;
  v_row    public.resguardos%rowtype;
  v_new    public.resguardos%rowtype;
  v_orig   public.colaboradores%rowtype;
  v_dest   public.colaboradores%rowtype;
  v_err    jsonb;
  v_fallos int; v_dia int;
  v_grupo  uuid := coalesce(p_solicitud, gen_random_uuid());
  v_nota   text;
begin
  perform app.exigir(array['admin', 'supervisor', 'almacen']);
  v_user := app.nombre_actual();
  select * into v_cfg from app.ajustes where id = 1;

  -- Reintento de una transferencia que ya se guardó
  if p_solicitud is not null and exists (select 1 from public.resguardos where grupo_id = p_solicitud) then
    select * into v_new from public.resguardos where grupo_id = p_solicitud limit 1;
    if v_new.colaborador_id <> p_destino_id then
      raise exception using errcode = '22023', message = 'Solicitud duplicada no válida.';
    end if;
    select * into v_row from public.resguardos where id = p_resguardo_id;
    return jsonb_build_object('ok', true, 'repetida', true, 'anterior', app.resguardo_json(v_row), 'nuevo', app.resguardo_json(v_new));
  end if;

  if p_nip_origen is null or p_nip_origen !~ '^[0-9]{4}$' or p_nip_destino is null or p_nip_destino !~ '^[0-9]{4}$' then
    return jsonb_build_object('ok', false, 'error', 'nip_formato', 'mensaje', 'Cada NIP debe tener 4 dígitos.');
  end if;

  select * into v_row from public.resguardos where id = p_resguardo_id and estado = 'activo' for update;
  if not found then
    raise exception using errcode = '22023', message = 'Ese resguardo no existe o ya no está activo.';
  end if;
  select * into v_orig from public.colaboradores where id = v_row.colaborador_id;
  select * into v_dest from public.colaboradores where id = p_destino_id and activo;
  if not found then
    raise exception using errcode = '22023', message = 'El colaborador que recibe no existe o está dado de baja.';
  end if;
  if v_dest.id = v_orig.id then
    raise exception using errcode = '22023', message = 'Elige a un colaborador distinto del que tiene la herramienta.';
  end if;

  -- Límite por cuenta de usuario (igual que en crear_resguardo)
  select count(*) filter (where ts > now() - interval '1 hour'), count(*) into v_fallos, v_dia
    from public.bitacora
   where usuario_id = v_uid and accion = 'nip_incorrecto' and ts > now() - interval '24 hours';
  if v_fallos >= v_cfg.usuario_max_fallos_hora or v_dia >= v_cfg.usuario_max_fallos_dia then
    perform app.log('nip_limite_usuario', 'resguardo', p_resguardo_id::text, jsonb_build_object('fallos_ultima_hora', v_fallos));
    return jsonb_build_object('ok', false, 'error', 'limite_usuario',
      'mensaje', 'Demasiados NIP incorrectos desde esta cuenta. Espera o avisa a un administrador.');
  end if;

  v_err := app.verificar_nip(v_orig.id, p_nip_origen);
  if v_err is not null then return v_err || jsonb_build_object('quien', 'origen'); end if;
  v_err := app.verificar_nip(v_dest.id, p_nip_destino);
  if v_err is not null then return v_err || jsonb_build_object('quien', 'destino'); end if;

  update public.resguardos
     set estado = 'devuelto', fecha_devolucion = app.hoy(),
         devuelto_por = left(v_user || ' (transferido a ' || v_dest.nombre || ')', 200),
         devuelto_por_id = v_uid, actualizado_en = now()
   where id = v_row.id
  returning * into v_row;

  v_nota := left('Transferido de ' || v_orig.nombre ||
                 case when v_orig.numero_empleado <> '' then ' (#' || v_orig.numero_empleado || ')' else '' end ||
                 case when v_row.notas <> '' then '. ' || v_row.notas else '' end, 500);
  insert into public.resguardos (grupo_id, colaborador_id, herramienta, cantidad, occ, id_articulo,
                                 fecha_prestamo, estado, notas, creado_por, creado_por_id)
  values (v_grupo, v_dest.id, v_row.herramienta, v_row.cantidad, v_row.occ, v_row.id_articulo,
          app.hoy(), 'activo', v_nota, v_user, v_uid)
  returning * into v_new;

  perform app.log('resguardo_transferido', 'resguardo', v_new.id::text,
    jsonb_build_object('herramienta', v_row.herramienta, 'cantidad', v_row.cantidad,
                       'resguardo_anterior', v_row.id, 'resguardo_nuevo', v_new.id,
                       'de_id', v_orig.id, 'de', v_orig.nombre, 'a_id', v_dest.id, 'a', v_dest.nombre));
  return jsonb_build_object('ok', true, 'anterior', app.resguardo_json(v_row), 'nuevo', app.resguardo_json(v_new));
end $$;

-- ---------- Alta de colaborador ----------
drop function if exists public.alta_colaborador(text, text, text);
create or replace function public.alta_colaborador(p_numero_empleado text, p_nombre text, p_nip text, p_area text default '')
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_nombre text := regexp_replace(btrim(coalesce(p_nombre, '')), '\s+', ' ', 'g');
  v_num    text := app.norm_num(p_numero_empleado);
  v_col public.colaboradores%rowtype;
begin
  perform app.exigir(array['admin', 'supervisor', 'almacen']);
  if v_num is null then
    raise exception using errcode = '22023', message = 'Escribe el número de empleado.';
  end if;
  if v_num !~ '^[A-Z0-9][A-Z0-9._/-]{0,29}$' then
    raise exception using errcode = '22023', message = 'El número de empleado solo admite letras, números, punto, guion y diagonal (máx. 30).';
  end if;
  if char_length(v_nombre) < 1 or char_length(v_nombre) > 120 then
    raise exception using errcode = '22023', message = 'Escribe el nombre del colaborador (máx. 120 caracteres).';
  end if;
  if p_nip is null or p_nip !~ '^[0-9]{4}$' then
    raise exception using errcode = '22023', message = 'El NIP debe tener 4 dígitos.';
  end if;
  if p_nip = '0000' then
    raise exception using errcode = '22023', message = 'El NIP 0000 no está permitido; elige otro.';
  end if;
  if exists (select 1 from public.colaboradores c where c.activo and c.numero_empleado = v_num) then
    raise exception using errcode = '23505', message = 'Ya existe un colaborador activo con ese número de empleado.';
  end if;
  insert into public.colaboradores (numero_empleado, nombre, area, creado_por)
  values (v_num, v_nombre, left(btrim(coalesce(p_area, '')), 80), auth.uid())
  returning * into v_col;
  insert into app.colaborador_nip (colaborador_id, nip_hash)
  values (v_col.id, extensions.crypt(p_nip, extensions.gen_salt('bf', 10)));
  perform app.log('colaborador_alta', 'colaborador', v_col.id::text,
                  jsonb_build_object('nombre', v_col.nombre, 'numero_empleado', v_col.numero_empleado));
  return jsonb_build_object('id', v_col.id, 'numero_empleado', v_col.numero_empleado, 'nombre', v_col.nombre,
                            'area', v_col.area, 'activo', v_col.activo, 'nip_pendiente', false);
end $$;

-- ---------- Baja de colaborador (siempre supervisor/admin + contraseña) ----------
-- Siempre requiere supervisor: si almacén pudiera dar de baja y volver a dar de
-- alta a alguien, podría ponerle un NIP que conoce y firmar resguardos a su nombre.
create or replace function public.baja_colaborador(p_colaborador_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_col public.colaboradores%rowtype;
  v_activos int;
  v_ids jsonb := '[]'::jsonb;
  v_user text;
begin
  perform app.exigir(array['admin', 'supervisor'], true);
  v_user := app.nombre_actual();
  select * into v_col from public.colaboradores where id = p_colaborador_id and activo for update;
  if not found then
    raise exception using errcode = '22023', message = 'Colaborador no encontrado o ya dado de baja.';
  end if;
  select count(*) into v_activos from public.resguardos where colaborador_id = p_colaborador_id and estado = 'activo';
  if v_activos > 0 then
    with upd as (
      update public.resguardos
         set estado = 'devuelto', fecha_devolucion = app.hoy(),
             devuelto_por = v_user || ' (baja de colaborador)', devuelto_por_id = auth.uid(), actualizado_en = now()
       where colaborador_id = p_colaborador_id and estado = 'activo'
      returning id)
    select coalesce(jsonb_agg(id), '[]'::jsonb) into v_ids from upd;
  end if;
  update public.colaboradores set activo = false, baja_en = now(), baja_por = auth.uid() where id = p_colaborador_id;
  perform app.log('colaborador_baja', 'colaborador', p_colaborador_id::text,
    jsonb_build_object('nombre', v_col.nombre, 'resguardos_cerrados', jsonb_array_length(v_ids)));
  return jsonb_build_object('ok', true, 'devueltos', v_ids, 'fecha_devolucion', app.hoy(),
                            'devuelto_por', coalesce(v_user, '') || ' (baja de colaborador)');
end $$;

-- ---------- Cambiar NIP / desbloquear (supervisor/admin + contraseña) ----------
create or replace function public.cambiar_nip(p_colaborador_id uuid, p_nip text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  perform app.exigir(array['admin', 'supervisor'], true);
  if p_nip is null or p_nip !~ '^[0-9]{4}$' or p_nip = '0000' then
    raise exception using errcode = '22023', message = 'El NIP debe tener 4 dígitos y no puede ser 0000.';
  end if;
  if not exists (select 1 from public.colaboradores where id = p_colaborador_id and activo) then
    raise exception using errcode = '22023', message = 'Colaborador no encontrado.';
  end if;
  insert into app.colaborador_nip (colaborador_id, nip_hash)
  values (p_colaborador_id, extensions.crypt(p_nip, extensions.gen_salt('bf', 10)))
  on conflict (colaborador_id) do update
    set nip_hash = excluded.nip_hash, nip_por_defecto = false, nip_importado = false, intentos_fallidos = 0, bloqueos = 0,
        bloqueado_hasta = null, actualizado_en = now();
  update public.colaboradores set nip_pendiente = false where id = p_colaborador_id;
  perform app.log('nip_cambiado', 'colaborador', p_colaborador_id::text, '{}'::jsonb);
  return jsonb_build_object('ok', true);
end $$;

-- ---------- Corregir fecha de entrega ----------
create or replace function public.editar_fecha_prestamo(p_resguardo_id uuid, p_fecha date)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_old date; v_row public.resguardos%rowtype;
begin
  perform app.exigir(array['admin', 'supervisor', 'almacen']);
  if p_fecha is null or p_fecha > app.hoy() or p_fecha < date '1950-01-01' then
    raise exception using errcode = '22023', message = 'Elige una fecha válida (no futura).';
  end if;
  select fecha_prestamo into v_old from public.resguardos where id = p_resguardo_id for update;
  if not found then raise exception using errcode = '22023', message = 'Resguardo no encontrado.'; end if;
  update public.resguardos set fecha_prestamo = p_fecha, actualizado_en = now() where id = p_resguardo_id
  returning * into v_row;
  perform app.log('fecha_editada', 'resguardo', p_resguardo_id::text, jsonb_build_object('antes', v_old, 'despues', p_fecha));
  return app.resguardo_json(v_row);
end $$;

-- ---------- Catálogo ----------
create or replace function public.agregar_herramienta(p_nombre text, p_id_articulo text default '')
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_t public.herramientas%rowtype; v_nombre text := btrim(coalesce(p_nombre, ''));
begin
  perform app.exigir(array['admin', 'supervisor', 'almacen']);
  if char_length(v_nombre) < 1 or char_length(v_nombre) > 200 then
    raise exception using errcode = '22023', message = 'Escribe el nombre de la herramienta (máx. 200 caracteres).';
  end if;
  if char_length(coalesce(p_id_articulo, '')) > 60 then
    raise exception using errcode = '22023', message = 'El ID de artículo admite máximo 60 caracteres.';
  end if;
  insert into public.herramientas (nombre, id_articulo, creado_por)
  values (v_nombre, btrim(coalesce(p_id_articulo, '')), auth.uid())
  on conflict (nombre_norm) do nothing
  returning * into v_t;
  if v_t.id is null then
    raise exception using errcode = '23505', message = 'Esa herramienta ya está en el catálogo.';
  end if;
  perform app.log('herramienta_alta', 'herramienta', v_t.id::text, jsonb_build_object('nombre', v_t.nombre));
  return jsonb_build_object('id', v_t.id, 'nombre', v_t.nombre, 'id_articulo', v_t.id_articulo);
end $$;

create or replace function public.eliminar_herramienta(p_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_t public.herramientas%rowtype;
begin
  perform app.exigir(array['admin', 'supervisor', 'almacen']);
  delete from public.herramientas where id = p_id returning * into v_t;
  if v_t.id is null then raise exception using errcode = '22023', message = 'Herramienta no encontrada.'; end if;
  perform app.log('herramienta_baja', 'herramienta', p_id::text, jsonb_build_object('nombre', v_t.nombre, 'id_articulo', v_t.id_articulo));
  return jsonb_build_object('ok', true);
end $$;

-- ---------- Cuentas de usuario (solo admin + contraseña reciente) ----------
create or replace function public.admin_actualizar_usuario(p_id uuid, p_rol text, p_activo boolean)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_p public.perfiles%rowtype;
begin
  perform app.exigir(array['admin'], true);
  if p_id = auth.uid() then
    raise exception using errcode = '22023', message = 'No puedes cambiar tu propia cuenta (evita quedarte sin administrador).';
  end if;
  if p_rol not in ('admin', 'supervisor', 'almacen') then
    raise exception using errcode = '22023', message = 'Rol no válido.';
  end if;
  update public.perfiles set rol = p_rol, activo = coalesce(p_activo, false) where id = p_id returning * into v_p;
  if not found then raise exception using errcode = '22023', message = 'Cuenta no encontrada.'; end if;
  perform app.log('usuario_actualizado', 'perfil', p_id::text, jsonb_build_object('email', v_p.email, 'rol', v_p.rol, 'activo', v_p.activo));
  return jsonb_build_object('id', v_p.id, 'email', v_p.email, 'nombre', v_p.nombre, 'rol', v_p.rol, 'activo', v_p.activo);
end $$;

-- ---------- Arranque en blanco ----------
-- No se migran datos de la versión anterior (ni colaboradores, ni resguardos, ni
-- catálogo). La función de migración masiva de versiones previas se elimina.
drop function if exists public.importar_lote(jsonb);

-- ---------- Importar catálogo de herramientas desde Excel (SOLO service_role) ----------
create or replace function public.importar_herramientas(p jsonb, p_actualizar boolean default false)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_e jsonb; v_nombre text; v_ida text; v_old public.herramientas%rowtype;
  n_nuevos int := 0; n_act int := 0; n_igual int := 0;
  v_omitidos jsonb := '[]'::jsonb;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' and coalesce(current_setting('role', true), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Solo la importación con service_role puede cargar el catálogo.';
  end if;
  if p is null or jsonb_typeof(p) <> 'array' then
    raise exception using errcode = '22023', message = 'Se esperaba una lista de herramientas.';
  end if;
  for v_e in select * from jsonb_array_elements(p) loop
    v_nombre := regexp_replace(btrim(coalesce(v_e ->> 'nombre', '')), '\s+', ' ', 'g');
    v_ida    := btrim(coalesce(v_e ->> 'id_articulo', ''));
    if char_length(v_nombre) not between 1 and 200 or char_length(v_ida) > 60 then
      v_omitidos := v_omitidos || jsonb_build_array(jsonb_build_object('nombre', left(v_nombre, 60), 'motivo', 'datos no válidos'));
      continue;
    end if;
    select * into v_old from public.herramientas where nombre_norm = app.norm(v_nombre);
    if found then
      if v_old.id_articulo = v_ida or v_ida = '' then
        n_igual := n_igual + 1;
      elsif p_actualizar or v_old.id_articulo = '' then
        update public.herramientas set id_articulo = v_ida where id = v_old.id;
        n_act := n_act + 1;
      else
        v_omitidos := v_omitidos || jsonb_build_array(jsonb_build_object('nombre', v_nombre,
                        'motivo', 'ya existe con otro ID (' || v_old.id_articulo || '); usa --actualizar'));
      end if;
      continue;
    end if;
    insert into public.herramientas (nombre, id_articulo) values (v_nombre, v_ida);
    n_nuevos := n_nuevos + 1;
  end loop;
  insert into public.bitacora (usuario, accion, entidad, detalle)
  values ('importacion', 'catalogo_importado', 'lote',
          jsonb_build_object('nuevos', n_nuevos, 'actualizados', n_act, 'sin_cambios', n_igual, 'omitidos', jsonb_array_length(v_omitidos)));
  return jsonb_build_object('nuevos', n_nuevos, 'actualizados', n_act, 'sin_cambios', n_igual, 'omitidos', v_omitidos);
end $$;

-- ---------- Importar colaboradores desde Excel (SOLO service_role, tools/importar_colaboradores.py) ----------
-- Los importados quedan SIN NIP (no se crea fila en app.colaborador_nip) y con
-- nip_pendiente = true: crear_resguardo los rechaza ('sin_nip') hasta que un
-- supervisor les asigne un NIP. No se usa ningún NIP por defecto adivinable.
create or replace function public.importar_colaboradores(p jsonb, p_actualizar boolean default false)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_e jsonb; v_num text; v_nombre text; v_area text; v_puesto text;
  v_id uuid; v_old public.colaboradores%rowtype;
  n_nuevos int := 0; n_act int := 0; n_igual int := 0;
  v_omitidos jsonb := '[]'::jsonb;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' and coalesce(current_setting('role', true), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Solo la importación con service_role puede cargar colaboradores.';
  end if;
  if p is null or jsonb_typeof(p) <> 'array' then
    raise exception using errcode = '22023', message = 'Se esperaba una lista de colaboradores.';
  end if;
  for v_e in select * from jsonb_array_elements(p) loop
    v_num    := app.norm_num(v_e ->> 'numero_empleado');
    v_nombre := regexp_replace(btrim(coalesce(v_e ->> 'nombre', '')), '\s+', ' ', 'g');
    v_area   := left(btrim(coalesce(v_e ->> 'area', '')), 80);
    v_puesto := left(btrim(coalesce(v_e ->> 'puesto', '')), 80);
    if v_num is null or v_num !~ '^[A-Z0-9][A-Z0-9._/-]{0,29}$' or char_length(v_nombre) not between 1 and 120 then
      v_omitidos := v_omitidos || jsonb_build_array(jsonb_build_object('numero_empleado', v_e ->> 'numero_empleado', 'motivo', 'datos no válidos'));
      continue;
    end if;
    select * into v_old from public.colaboradores where activo and numero_empleado = v_num;
    if found then
      if v_old.nombre = v_nombre and v_old.area = v_area and v_old.puesto = v_puesto then
        n_igual := n_igual + 1;
      elsif p_actualizar then
        update public.colaboradores set nombre = v_nombre, area = v_area, puesto = v_puesto where id = v_old.id;
        n_act := n_act + 1;
      else
        v_omitidos := v_omitidos || jsonb_build_array(jsonb_build_object('numero_empleado', v_num,
                        'motivo', 'ya existe con otros datos (' || v_old.nombre || '); usa --actualizar'));
      end if;
      continue;
    end if;
    insert into public.colaboradores (numero_empleado, nombre, area, puesto, nip_pendiente)
    values (v_num, v_nombre, v_area, v_puesto, true);
    n_nuevos := n_nuevos + 1;
  end loop;
  insert into public.bitacora (usuario, accion, entidad, detalle)
  values ('importacion', 'colaboradores_importados', 'lote',
          jsonb_build_object('nuevos', n_nuevos, 'actualizados', n_act, 'sin_cambios', n_igual, 'omitidos', jsonb_array_length(v_omitidos)));
  return jsonb_build_object('nuevos', n_nuevos, 'actualizados', n_act, 'sin_cambios', n_igual, 'omitidos', v_omitidos);
end $$;

-- ---------- Respaldo completo (SOLO service_role, desde tools/respaldo.py) ----------
create or replace function public.respaldo_completo()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' and coalesce(current_setting('role', true), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Solo service_role puede descargar el respaldo.';
  end if;
  return jsonb_build_object(
    'formato', 'citrojugo-respaldo', 'version', 1, 'generado', now(),
    'perfiles',        (select coalesce(jsonb_agg(to_jsonb(x) order by x.email), '[]') from public.perfiles x),
    'colaboradores',   (select coalesce(jsonb_agg(to_jsonb(x) - 'nombre_norm' order by x.nombre), '[]') from public.colaboradores x),
    'colaborador_nip', (select coalesce(jsonb_agg(jsonb_build_object('colaborador_id', x.colaborador_id, 'nip_hash', x.nip_hash,
                          'nip_por_defecto', x.nip_por_defecto, 'nip_importado', x.nip_importado)), '[]') from app.colaborador_nip x),
    'herramientas',    (select coalesce(jsonb_agg(to_jsonb(x) - 'nombre_norm' order by x.nombre), '[]') from public.herramientas x),
    'resguardos',      (select coalesce(jsonb_agg(to_jsonb(x) order by x.creado_en), '[]') from public.resguardos x),
    'bitacora',        (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') from public.bitacora x));
end $$;

-- =====================================================================
-- ROW LEVEL SECURITY
-- =====================================================================
alter table public.perfiles      enable row level security;
alter table public.colaboradores enable row level security;
alter table public.herramientas  enable row level security;
alter table public.resguardos    enable row level security;
alter table public.bitacora      enable row level security;
alter table app.colaborador_nip  enable row level security;   -- sin políticas: nadie del cliente

drop policy if exists perfiles_leer on public.perfiles;
create policy perfiles_leer on public.perfiles for select to authenticated
  using (id = (select auth.uid()) or (select app.es_admin()));

drop policy if exists colaboradores_leer on public.colaboradores;
create policy colaboradores_leer on public.colaboradores for select to authenticated
  using ((select app.usuario_activo()));

drop policy if exists herramientas_leer on public.herramientas;
create policy herramientas_leer on public.herramientas for select to authenticated
  using ((select app.usuario_activo()));

drop policy if exists resguardos_leer on public.resguardos;
create policy resguardos_leer on public.resguardos for select to authenticated
  using ((select app.usuario_activo()));

drop policy if exists bitacora_leer on public.bitacora;
create policy bitacora_leer on public.bitacora for select to authenticated
  using ((select app.es_admin()));

-- =====================================================================
-- PERMISOS (GRANT/REVOKE). Supabase concede por defecto todo a anon y
-- authenticated en el esquema public; aquí se retira y se concede lo mínimo.
-- =====================================================================
revoke all on public.perfiles, public.colaboradores, public.herramientas, public.resguardos, public.bitacora
  from public, anon, authenticated;
grant select on public.perfiles, public.colaboradores, public.herramientas, public.resguardos, public.bitacora
  to authenticated;
revoke all on app.colaborador_nip, app.ajustes from public, anon, authenticated;

do $$
declare f record;
begin
  -- Ninguna función del esquema public ni app es ejecutable por anon/public.
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'app')
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on function %s from authenticated', f.sig);
    end if;
  end loop;
end $$;

-- Funciones auxiliares que las políticas RLS necesitan evaluar
grant execute on function app.usuario_activo(), app.es_admin() to authenticated;

-- RPC disponibles para usuarios con sesión (cada una valida rol adentro)
grant execute on function
  public.crear_resguardo(uuid, text, jsonb, date, text, uuid),
  public.devolver_resguardo(uuid, text),
  public.transferir_resguardo(uuid, uuid, text, text, uuid),
  public.alta_colaborador(text, text, text, text),
  public.baja_colaborador(uuid),
  public.cambiar_nip(uuid, text),
  public.editar_fecha_prestamo(uuid, date),
  public.agregar_herramienta(text, text),
  public.eliminar_herramienta(uuid),
  public.admin_actualizar_usuario(uuid, text, boolean)
to authenticated;

-- Importadores y respaldo: solo service_role (nunca en el navegador)
grant execute on function public.importar_colaboradores(jsonb, boolean), public.importar_herramientas(jsonb, boolean), public.respaldo_completo() to service_role;

-- =====================================================================
-- ÚLTIMO PASO MANUAL (una sola vez): convertir tu usuario en admin.
--   1) Authentication → Users → Add user → Create new user (tu correo)
--   2) Ejecuta, cambiando el correo:
--      update public.perfiles set rol = 'admin', activo = true, nombre = 'Omar'
--       where email = 'tu-correo@ejemplo.com';
-- =====================================================================
