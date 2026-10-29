-- =====================================================================
-- MIGRACIÓN: Asignación personalizada de personal por número de empleado
-- y Vista Global de Consulta de Resguardos para Directores
-- =====================================================================

-- 1. Tabla de personal asignado manualmente por cada líder
create table if not exists app.lider_subordinado (
  lider_id       uuid not null references public.colaboradores (id) on delete cascade,
  subordinado_id uuid not null references public.colaboradores (id) on delete cascade,
  agregado_en    timestamptz not null default now(),
  primary key (lider_id, subordinado_id)
);
alter table app.lider_subordinado enable row level security;

-- 2. Limpieza de asignaciones automáticas anteriores (inician vacías)
update app.portal_lider set areas = '{}', alcance_tipo = 'personalizado';
update public.colaboradores set supervisor_id = null;
truncate table app.lider_subordinado;

-- 3. RPC: Agregar subordinado por número de empleado
create or replace function public.colab_agregar_subordinado(
  p_token text,
  p_numero_empleado text
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id         uuid := app.portal_sesion_valida(p_token, 'activa');
  v_col        public.colaboradores%rowtype;
  v_lider      app.portal_lider%rowtype;
  v_sub        public.colaboradores%rowtype;
  v_num        text := app.norm_num(p_numero_empleado);
begin
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'sesion', 'mensaje', 'Tu sesión terminó. Vuelve a iniciar sesión.');
  end if;

  select * into v_col from public.colaboradores where id = v_id;
  select * into v_lider from app.portal_lider where colaborador_id = v_id and activo;

  if v_lider.colaborador_id is null or not v_col.puede_auditar then
    return jsonb_build_object('ok', false, 'error', 'no_autorizado', 'mensaje', 'No tienes facultades asignadas de líder o auditoría.');
  end if;

  if v_num is null or v_num = '' then
    return jsonb_build_object('ok', false, 'error', 'numero_vacio', 'mensaje', 'Escribe el número de empleado del colaborador.');
  end if;

  select * into v_sub from public.colaboradores where activo and numero_empleado = v_num;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'no_encontrado', 'mensaje', 'No se encontró ningún colaborador activo con el número ' || v_num || '.');
  end if;

  if v_sub.id = v_id then
    return jsonb_build_object('ok', false, 'error', 'mismo_usuario', 'mensaje', 'No puedes agregarte a ti mismo como personal a cargo.');
  end if;

  if exists (select 1 from app.lider_subordinado where lider_id = v_id and subordinado_id = v_sub.id) then
    return jsonb_build_object('ok', false, 'error', 'ya_asignado', 'mensaje', v_sub.nombre || ' ya está en tu lista de personal.');
  end if;

  insert into app.lider_subordinado (lider_id, subordinado_id)
  values (v_id, v_sub.id);

  perform app.log('lider_agrego_subordinado', 'colaborador', v_sub.id::text,
    jsonb_build_object(
      'lider', v_col.nombre,
      'subordinado', v_sub.nombre,
      'numero_empleado', v_sub.numero_empleado
    ));

  return jsonb_build_object(
    'ok', true,
    'mensaje', 'Colaborador ' || v_sub.nombre || ' agregado a tu equipo.',
    'subordinado', jsonb_build_object(
      'id', v_sub.id,
      'nombre', v_sub.nombre,
      'numero_empleado', v_sub.numero_empleado,
      'puesto', v_sub.puesto,
      'area', v_sub.area
    )
  );
end $$;

-- 4. RPC: Remover subordinado de la lista personal
create or replace function public.colab_remover_subordinado(
  p_token text,
  p_subordinado_id uuid
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id         uuid := app.portal_sesion_valida(p_token, 'activa');
  v_col        public.colaboradores%rowtype;
  v_sub        public.colaboradores%rowtype;
  v_borrados   int;
begin
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'sesion', 'mensaje', 'Tu sesión terminó. Vuelve a iniciar sesión.');
  end if;

  select * into v_col from public.colaboradores where id = v_id;
  select * into v_sub from public.colaboradores where id = p_subordinado_id;

  delete from app.lider_subordinado
   where lider_id = v_id and subordinado_id = p_subordinado_id;
  get diagnostics v_borrados = row_count;

  if v_borrados = 0 then
    return jsonb_build_object('ok', false, 'error', 'no_encontrado', 'mensaje', 'Ese colaborador no está en tu lista.');
  end if;

  perform app.log('lider_removio_subordinado', 'colaborador', p_subordinado_id::text,
    jsonb_build_object(
      'lider', v_col.nombre,
      'subordinado', v_sub.nombre
    ));

  return jsonb_build_object('ok', true, 'mensaje', 'Colaborador removido de tu lista de personal.');
end $$;

-- 5. RPC: Mi equipo (basado exclusivamente en app.lider_subordinado)
create or replace function public.colab_mi_equipo(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id         uuid := app.portal_sesion_valida(p_token, 'activa');
  v_col        public.colaboradores%rowtype;
  v_lider      app.portal_lider%rowtype;
  v_res        jsonb;
begin
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'sesion', 'mensaje', 'Tu sesión terminó. Vuelve a iniciar sesión.');
  end if;

  select * into v_col from public.colaboradores where id = v_id;
  select * into v_lider from app.portal_lider where colaborador_id = v_id and activo;
  
  if v_lider.colaborador_id is null or not v_col.puede_auditar then
    return jsonb_build_object('ok', false, 'error', 'no_autorizado', 'mensaje', 'No tienes facultades asignadas de auditoría o personal a cargo.');
  end if;

  update app.portal_lider set ultimo_acceso_auditoria = now() where colaborador_id = v_id;

  with subordinados as (
    select c.id, c.nombre, c.numero_empleado, c.puesto, c.area, c.localidad, ls.agregado_en
      from public.colaboradores c
      join app.lider_subordinado ls on ls.subordinado_id = c.id
     where ls.lider_id = v_id
       and c.activo
  ),
  resguardos_agg as (
    select 
      r.colaborador_id,
      count(*) filter (where r.estado = 'activo') as total_activas,
      count(*) filter (where r.estado = 'activo' and (r.revision_en is null or r.revision_en < now() - interval '180 days')) as pendientes_revision,
      coalesce(sum(case when v_lider.puede_ver_costos then r.costo_unitario * r.cantidad else 0 end) filter (where r.estado = 'activo'), 0) as valor_resguardos,
      coalesce(jsonb_agg(
        jsonb_build_object(
          'id', r.id,
          'herramienta', r.herramienta,
          'cantidad', r.cantidad,
          'condicion', r.condicion,
          'fecha_prestamo', r.fecha_prestamo,
          'occ', r.occ,
          'id_articulo', r.id_articulo,
          'revision_en', r.revision_en,
          'revision_resultado', r.revision_resultado,
          'revision_nota', r.revision_nota,
          'costo_unitario', case when v_lider.puede_ver_costos then r.costo_unitario else null end
        ) order by r.fecha_prestamo desc
      ) filter (where r.estado = 'activo'), '[]'::jsonb) as items
    from public.resguardos r
    where r.colaborador_id in (select id from subordinados)
    group by r.colaborador_id
  )
  select jsonb_build_object(
    'ok', true,
    'lider', jsonb_build_object(
      'nombre', v_col.nombre,
      'puesto', v_col.puesto,
      'nivel', v_lider.nivel,
      'puede_ver_costos', v_lider.puede_ver_costos,
      'es_director', v_lider.nivel in ('director_general', 'director')
    ),
    'resumen', jsonb_build_object(
      'total_colaboradores', (select count(*) from subordinados),
      'con_herramienta', (select count(distinct colaborador_id) from resguardos_agg where total_activas > 0),
      'total_herramientas', (select coalesce(sum(total_activas), 0) from resguardos_agg),
      'pendientes_revision', (select coalesce(sum(pendientes_revision), 0) from resguardos_agg),
      'capital_total', (case when v_lider.puede_ver_costos then (select coalesce(sum(valor_resguardos), 0) from resguardos_agg) else null end)
    ),
    'equipo', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', s.id,
          'nombre', s.nombre,
          'numero_empleado', s.numero_empleado,
          'puesto', s.puesto,
          'area', s.area,
          'herramientas_activas', coalesce(ra.total_activas, 0),
          'pendientes_revision', coalesce(ra.pendientes_revision, 0),
          'valor_resguardos', case when v_lider.puede_ver_costos then coalesce(ra.valor_resguardos, 0) else null end,
          'items', coalesce(ra.items, '[]'::jsonb)
        ) order by coalesce(ra.total_activas, 0) desc, s.nombre asc
      ) from subordinados s
      left join resguardos_agg ra on ra.colaborador_id = s.id
    ), '[]'::jsonb)
  ) into v_res;

  return v_res;
end $$;

-- 6. RPC: Vista Global de Consulta de Resguardos (Exclusivo Directores y Director General)
-- Permite consultar toda la información de la empresa de solo lectura (como el admin pero sin modificación)
create or replace function public.colab_resguardos_globales(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id         uuid := app.portal_sesion_valida(p_token, 'activa');
  v_col        public.colaboradores%rowtype;
  v_lider      app.portal_lider%rowtype;
  v_res        jsonb;
begin
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'sesion', 'mensaje', 'Tu sesión terminó. Vuelve a iniciar sesión.');
  end if;

  select * into v_col from public.colaboradores where id = v_id;
  select * into v_lider from app.portal_lider where colaborador_id = v_id and activo;

  if v_lider.colaborador_id is null or v_lider.nivel not in ('director_general', 'director') then
    return jsonb_build_object('ok', false, 'error', 'no_autorizado', 'mensaje', 'La vista global de auditoría es exclusiva para Directores y Dirección General.');
  end if;

  with resguardos_full as (
    select 
      r.id,
      r.fecha_prestamo,
      r.herramienta,
      r.cantidad,
      r.condicion,
      r.occ,
      r.id_articulo,
      r.costo_unitario,
      (r.costo_unitario * r.cantidad) as costo_total,
      r.estado,
      r.fecha_devolucion,
      r.creado_por,
      r.notas,
      r.revision_en,
      r.revision_resultado,
      r.revision_por,
      c.nombre as colaborador_nombre,
      c.numero_empleado as colaborador_numero,
      c.puesto as colaborador_puesto,
      c.area as colaborador_area
    from public.resguardos r
    join public.colaboradores c on c.id = r.colaborador_id
    where r.estado = 'activo'
    order by r.fecha_prestamo desc
  )
  select jsonb_build_object(
    'ok', true,
    'lider', jsonb_build_object(
      'nombre', v_col.nombre,
      'puesto', v_col.puesto,
      'nivel', v_lider.nivel
    ),
    'resumen', jsonb_build_object(
      'total_resguardos_activos', (select count(*) from resguardos_full),
      'total_piezas', (select coalesce(sum(cantidad), 0) from resguardos_full),
      'colaboradores_con_herramienta', (select count(distinct colaborador_numero) from resguardos_full),
      'capital_total', (select coalesce(sum(costo_total), 0) from resguardos_full)
    ),
    'resguardos', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', rf.id,
          'fecha_prestamo', rf.fecha_prestamo,
          'colaborador', rf.colaborador_nombre,
          'numero_empleado', rf.colaborador_numero,
          'puesto', rf.colaborador_puesto,
          'area', rf.colaborador_area,
          'herramienta', rf.herramienta,
          'cantidad', rf.cantidad,
          'condicion', rf.condicion,
          'occ', rf.occ,
          'id_articulo', rf.id_articulo,
          'costo_unitario', rf.costo_unitario,
          'costo_total', rf.costo_total,
          'creado_por', rf.creado_por,
          'notas', rf.notas,
          'revision_en', rf.revision_en,
          'revision_resultado', rf.revision_resultado
        )
      ) from resguardos_full rf
    ), '[]'::jsonb)
  ) into v_res;

  return v_res;
end $$;

-- 7. RPC: Registrar revisión (permite a líderes auditar a su personal asignado, o a directores auditar a cualquiera)
create or replace function public.colab_registrar_revision(
  p_token text,
  p_resguardo_id uuid,
  p_resultado text,
  p_nota text default ''
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id         uuid := app.portal_sesion_valida(p_token, 'activa');
  v_col        public.colaboradores%rowtype;
  v_lider      app.portal_lider%rowtype;
  v_r          public.resguardos%rowtype;
  v_target_col public.colaboradores%rowtype;
  v_resultado  text := btrim(coalesce(p_resultado, ''));
  v_nota       text := btrim(coalesce(p_nota, ''));
begin
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'sesion', 'mensaje', 'Tu sesión terminó. Vuelve a iniciar sesión.');
  end if;

  select * into v_col from public.colaboradores where id = v_id;
  select * into v_lider from app.portal_lider where colaborador_id = v_id and activo;
  
  if v_lider.colaborador_id is null or not v_col.puede_auditar then
    return jsonb_build_object('ok', false, 'error', 'no_autorizado', 'mensaje', 'No tienes permisos de auditoría.');
  end if;

  if v_resultado not in ('bueno', 'danado', 'no_localizado') then
    raise exception using errcode = '22023', message = 'Elige un resultado válido: bueno, danado o no_localizado.';
  end if;

  select * into v_r from public.resguardos where id = p_resguardo_id for update;
  if not found or v_r.estado <> 'activo' then
    return jsonb_build_object('ok', false, 'error', 'resguardo_invalido', 'mensaje', 'Ese resguardo no está activo.');
  end if;

  select * into v_target_col from public.colaboradores where id = v_r.colaborador_id;

  -- Comprueba que pertenezca a su lista asignada (los Directores pueden auditar a cualquiera)
  if v_lider.nivel not in ('director_general', 'director') then
    if not exists (select 1 from app.lider_subordinado where lider_id = v_id and subordinado_id = v_target_col.id) then
      return jsonb_build_object('ok', false, 'error', 'fuera_de_jurisdiccion', 'mensaje', 'Ese colaborador no está en tu lista de personal asignado.');
    end if;
  end if;

  update public.resguardos
     set revision_en = now(),
         revision_resultado = v_resultado,
         revision_por = v_col.nombre || ' (' || v_col.puesto || ')',
         revision_nota = v_nota,
         actualizado_en = now()
   where id = p_resguardo_id
  returning * into v_r;

  perform app.log('revision_campo_lider', 'resguardo', v_r.id::text,
    jsonb_build_object(
      'lider', v_col.nombre,
      'puesto_lider', v_col.puesto,
      'colaborador', v_target_col.nombre,
      'herramienta', v_r.herramienta,
      'resultado', v_resultado,
      'nota', v_nota
    ));

  return jsonb_build_object('ok', true, 'mensaje', 'Auditoría registrada correctamente.', 'resguardo', app.resguardo_json(v_r));
end $$;

-- 8. Permisos
grant execute on function
  public.colab_agregar_subordinado(text, text),
  public.colab_remover_subordinado(text, uuid),
  public.colab_mi_equipo(text),
  public.colab_resguardos_globales(text),
  public.colab_registrar_revision(text, uuid, text, text)
to anon, authenticated;
