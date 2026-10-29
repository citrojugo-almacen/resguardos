-- =====================================================================
-- MIGRACIÓN: Jerarquía Piramidal y Portal de Auditoría para Líderes
-- Director General -> Directores -> Gerentes -> Supervisores -> Operativos
-- =====================================================================

-- 1. Campos en public.colaboradores
alter table public.colaboradores add column if not exists nivel_jerarquico text not null default 'operativo';
alter table public.colaboradores add column if not exists puede_auditar boolean not null default false;
alter table public.colaboradores add column if not exists supervisor_id uuid references public.colaboradores(id);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'colaboradores_nivel_jerarquico_check') then
    alter table public.colaboradores add constraint colaboradores_nivel_jerarquico_check
      check (nivel_jerarquico in ('director_general', 'director', 'gerente', 'supervisor', 'operativo'));
  end if;
end $$;

-- 2. Tabla privada de líderes y configuración de alcance (esquema app)
create table if not exists app.portal_lider (
  colaborador_id            uuid primary key references public.colaboradores (id) on delete cascade,
  nivel                     text not null check (nivel in ('director_general', 'director', 'gerente', 'supervisor')),
  alcance_tipo              text not null default 'automatico' check (alcance_tipo in ('automatico', 'areas', 'personalizado')),
  areas                     text[] not null default '{}',
  puede_ver_costos          boolean not null default false,
  activo                    boolean not null default true,
  invitado_en               timestamptz not null default now(),
  invitado_por              uuid references auth.users(id),
  ultimo_acceso_auditoria   timestamptz
);
alter table app.portal_lider enable row level security;

-- 3. Clasificación inicial piramidal basada en el organigrama oficial
-- Nivel 1: Director General (Sigifredo Gudiño Ochoa)
update public.colaboradores
   set nivel_jerarquico = 'director_general', puede_auditar = true
 where puesto ilike '%director general%' or numero_empleado = '0238';

insert into app.portal_lider (colaborador_id, nivel, alcance_tipo, puede_ver_costos, activo)
select id, 'director_general', 'automatico', true, true
  from public.colaboradores
 where nivel_jerarquico = 'director_general'
on conflict (colaborador_id) do update
set nivel = 'director_general', puede_ver_costos = true, activo = true;

-- Nivel 2: Directores de Área (Moisés Alfaro, Alma Patricia Díaz, Gabriel Vargas, etc.)
update public.colaboradores
   set nivel_jerarquico = 'director', puede_auditar = true
 where puesto ilike '%director%' and nivel_jerarquico <> 'director_general';

insert into app.portal_lider (colaborador_id, nivel, alcance_tipo, puede_ver_costos, activo)
select id, 'director', 'automatico', true, true
  from public.colaboradores
 where nivel_jerarquico = 'director'
on conflict (colaborador_id) do update
set nivel = 'director', puede_ver_costos = true, activo = true;

-- Nivel 3: Gerentes
update public.colaboradores
   set nivel_jerarquico = 'gerente', puede_auditar = true
 where puesto ilike '%gerente%' and nivel_jerarquico not in ('director_general', 'director');

insert into app.portal_lider (colaborador_id, nivel, alcance_tipo, puede_ver_costos, activo)
select id, 'gerente', 'automatico', false, true
  from public.colaboradores
 where nivel_jerarquico = 'gerente'
on conflict (colaborador_id) do update
set nivel = 'gerente', puede_ver_costos = false, activo = true;

-- Nivel 4: Supervisores, Coordinadores y Jefes
update public.colaboradores
   set nivel_jerarquico = 'supervisor', puede_auditar = true
 where (puesto ilike '%supervisor%' or puesto ilike '%coordinador%' or puesto ilike '%jefe%')
   and nivel_jerarquico not in ('director_general', 'director', 'gerente');

insert into app.portal_lider (colaborador_id, nivel, alcance_tipo, puede_ver_costos, activo)
select id, 'supervisor', 'automatico', false, true
  from public.colaboradores
 where nivel_jerarquico = 'supervisor'
on conflict (colaborador_id) do update
set nivel = 'supervisor', puede_ver_costos = false, activo = true;

-- 4. Asignación de áreas a Directores según organigrama
-- Dirección de Operaciones (Moisés Alfaro): Producción, Mantenimiento, Deshidratadora
update app.portal_lider
   set areas = array['PRODUCCION DIRECTA', 'PRODUCCION INDIRECTA', 'MANTENIMIENTO DIRECTA', 'MANTENIMIENTO INDIRECTA', 'DET PRODUCCION DIRECTA', 'APTZ PRODUCCION DIRECTA', 'DET MANTENIMIENTO DIRECTA', 'APTZ MANTENIMIENTO DIRECTA', 'PB PRODUCCION DIRECTA', 'APTZ MANTENIMIENTO INDIRECTA', 'DET PRODUCCION INDIRECTA', 'ASEGURAMIENTO DE CALIDAD DIRECTO', 'ASEGURAMIENTO DE CALIDAD INDIRECTO'],
       alcance_tipo = 'areas'
 where colaborador_id in (select id from public.colaboradores where puesto ilike '%director de operaciones%');

-- Dirección de Administración (Alma Patricia Díaz)
update app.portal_lider
   set areas = array['ADMINISTRACION', 'APTZ ADMINISTRACION'],
       alcance_tipo = 'areas'
 where colaborador_id in (select id from public.colaboradores where puesto ilike '%director de administracion%');

-- Dirección de Compras (Gabriel Vargas)
update app.portal_lider
   set areas = array['ADMINISTRACION', 'PRODUCCION INDIRECTA'],
       alcance_tipo = 'areas'
 where colaborador_id in (select id from public.colaboradores where puesto ilike '%compras%');

-- 5. RPC para el Portal del Colaborador: colab_mi_equipo
-- Obtiene el personal subordinado según la pirámide
create or replace function public.colab_mi_equipo(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id         uuid := app.portal_sesion_valida(p_token, 'activa');
  v_col        public.colaboradores%rowtype;
  v_lider      app.portal_lider%rowtype;
  v_sub_filtro text;
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

  -- Actualiza último acceso a auditoría
  update app.portal_lider set ultimo_acceso_auditoria = now() where colaborador_id = v_id;

  -- Construye listado subordinado según nivel
  -- Director General: Toda la empresa
  -- Director: Su conjunto de áreas
  -- Gerente / Supervisor: Su misma área o asignación
  with subordinados as (
    select c.id, c.nombre, c.numero_empleado, c.puesto, c.area, c.localidad
      from public.colaboradores c
     where c.activo
       and c.id <> v_id
       and (
         v_lider.nivel = 'director_general'
         or (v_lider.alcance_tipo = 'areas' and c.area = any(v_lider.areas))
         or (v_lider.alcance_tipo = 'automatico' and c.area = v_col.area)
         or c.supervisor_id = v_id
       )
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
      'alcance', v_lider.alcance_tipo
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

-- 6. RPC para registrar auditoría de campo por el líder
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

  -- Comprueba que el resguardo pertenezca a su jurisdicción
  if v_lider.nivel <> 'director_general' then
    if v_lider.alcance_tipo = 'areas' and not (v_target_col.area = any(v_lider.areas)) then
      return jsonb_build_object('ok', false, 'error', 'fuera_de_jurisdiccion', 'mensaje', 'Ese colaborador no pertenece a tus áreas asignadas.');
    elsif v_lider.alcance_tipo = 'automatico' and v_target_col.area <> v_col.area and v_target_col.supervisor_id is distinct from v_id then
      return jsonb_build_object('ok', false, 'error', 'fuera_de_jurisdiccion', 'mensaje', 'Ese colaborador no pertenece a tu equipo.');
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

-- 7. RPC de Almacén para administrar líderes (exclusivo admin)
create or replace function public.admin_listar_lideres()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  perform app.exigir(array['admin', 'supervisor']);
  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'id', c.id,
        'nombre', c.nombre,
        'numero_empleado', c.numero_empleado,
        'puesto', c.puesto,
        'area', c.area,
        'nivel', coalesce(pl.nivel, c.nivel_jerarquico),
        'puede_ver_costos', coalesce(pl.puede_ver_costos, false),
        'activo', coalesce(pl.activo, false),
        'alcance_tipo', coalesce(pl.alcance_tipo, 'automatico'),
        'areas', coalesce(pl.areas, '{}'::text[]),
        'invitado_en', pl.invitado_en,
        'ultimo_acceso_auditoria', pl.ultimo_acceso_auditoria
      ) order by 
        case coalesce(pl.nivel, c.nivel_jerarquico)
          when 'director_general' then 1
          when 'director' then 2
          when 'gerente' then 3
          when 'supervisor' then 4
          else 5
        end, c.nombre asc
    )
    from public.colaboradores c
    left join app.portal_lider pl on pl.colaborador_id = c.id
    where c.activo and (c.puede_auditar or pl.colaborador_id is not null)
  ), '[]'::jsonb);
end $$;

create or replace function public.admin_actualizar_lider(
  p_colaborador_id uuid,
  p_nivel text,
  p_activo boolean,
  p_puede_ver_costos boolean default false,
  p_alcance_tipo text default 'automatico',
  p_areas text[] default '{}'
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_col public.colaboradores%rowtype;
  v_pl  app.portal_lider%rowtype;
begin
  perform app.exigir(array['admin']);
  
  if p_nivel not in ('director_general', 'director', 'gerente', 'supervisor') then
    raise exception using errcode = '22023', message = 'Nivel jerárquico no válido.';
  end if;

  select * into v_col from public.colaboradores where id = p_colaborador_id and activo;
  if not found then
    raise exception using errcode = 'P0002', message = 'Colaborador no encontrado o inactivo.';
  end if;

  update public.colaboradores
     set nivel_jerarquico = p_nivel,
         puede_auditar = p_activo
   where id = p_colaborador_id;

  insert into app.portal_lider (colaborador_id, nivel, alcance_tipo, areas, puede_ver_costos, activo, invitado_por)
  values (p_colaborador_id, p_nivel, p_alcance_tipo, p_areas, p_puede_ver_costos, p_activo, auth.uid())
  on conflict (colaborador_id) do update
  set nivel = p_nivel,
      alcance_tipo = p_alcance_tipo,
      areas = p_areas,
      puede_ver_costos = p_puede_ver_costos,
      activo = p_activo;

  perform app.log('lider_actualizado', 'colaborador', p_colaborador_id::text,
    jsonb_build_object(
      'colaborador', v_col.nombre,
      'nivel', p_nivel,
      'activo', p_activo,
      'puede_ver_costos', p_puede_ver_costos,
      'alcance_tipo', p_alcance_tipo
    ));

  return jsonb_build_object('ok', true, 'mensaje', 'Líder configurado exitosamente.');
end $$;

-- 8. Concesión de permisos
grant execute on function
  public.colab_mi_equipo(text),
  public.colab_registrar_revision(text, uuid, text, text)
to anon, authenticated;

grant execute on function
  public.admin_listar_lideres(),
  public.admin_actualizar_lider(uuid, text, boolean, boolean, text, text[])
to authenticated;
