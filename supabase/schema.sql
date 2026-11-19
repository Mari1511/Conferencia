-- ===========================================================================
--  CONFERENCIA MAGISTRAL «Cómo se gana una partida normal»
--  Base de datos — PostgreSQL 15+ (Supabase)
-- ---------------------------------------------------------------------------
--  Cómo usarlo:
--    1. supabase.com → proyecto nuevo → SQL Editor → pega TODO este archivo → Run.
--    2. Copia la URL del proyecto y la clave pública en js/config.js.
--    3. Entra a admin.html con  usuario: admin   clave: Conferencia2026!
--       y CÁMBIALA (ver «Cambiar la clave» al final de este archivo).
--
--  ¡OJO! Volver a ejecutar el script BORRA todos los registros.
--
--  Seguridad:
--    • Todas las tablas tienen RLS activado y ninguna política: la clave
--      pública NO puede leer ni escribir tablas directamente.
--    • La página solo ejecuta funciones SECURITY DEFINER. Las del panel
--      administrativo exigen un token de sesión que se obtiene con usuario y
--      contraseña (guardada con bcrypt, nunca en texto plano).
-- ===========================================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
--  Limpieza (permite volver a ejecutar el script)
-- ---------------------------------------------------------------------------
drop view if exists public.vista_asistentes cascade;
drop table if exists public.accesos, public.sesiones_admin, public.administradores,
                     public.asistentes, public.asientos, public.mesas, public.evento cascade;
drop function if exists public.asientos_ocupados(), public.reservar_asiento(text, text, text, text),
  public.consultar_registro(text, text), public.consultar_registro(text), public.cancelar_registro(text, text),
  public.admin_iniciar_sesion(text, text), public.admin_cerrar_sesion(text),
  public.admin_resumen(text), public.admin_listar(text, text),
  public.admin_registrar(text, text, text, text, text),
  public.admin_actualizar(text, integer, text, text, text, text, boolean),
  public.admin_eliminar(text, integer), public.admin_validar_qr(text, text),
  public.admin_accesos(text, integer),
  public._normalizar(text, text, text), public._insertar_asistente(text, text, text, text, text),
  public._admin_de_sesion(text), public._ficha(integer) cascade;

-- ===========================================================================
--  1. TABLAS
-- ===========================================================================

-- Datos generales del evento (una sola fila)
create table public.evento (
  id          smallint primary key default 1 check (id = 1),
  nombre      text     not null,
  tema        text     not null,
  fecha       date     not null,
  hora_inicio time     not null,
  hora_fin    time     not null,
  lugar       text     not null,
  ponente     text     not null,
  cupo        smallint not null check (cupo > 0)
);

-- Mesas del recinto
create table public.mesas (
  id         smallint primary key check (id between 1 and 99),   -- número de mesa
  evento_id  smallint not null references public.evento(id) on delete cascade,
  capacidad  smallint not null check (capacidad between 1 and 20)
);

-- Asientos de cada mesa
create table public.asientos (
  id       text     primary key,                                  -- 'M03-A05'
  mesa_id  smallint not null references public.mesas(id) on delete cascade,
  numero   smallint not null check (numero between 1 and 20),
  constraint asientos_mesa_numero_unico unique (mesa_id, numero)
);

-- Asistentes registrados
create table public.asistentes (
  id                  integer generated always as identity primary key,
  folio               text        not null,                       -- 'LOL-1A2B3C4D' (lo ve el asistente)
  codigo_qr           text        not null,                       -- 'CMLOL-…' (va dentro del QR de acceso)
  nombre              text        not null check (char_length(nombre) between 3 and 80),
  correo              text        not null check (char_length(correo) <= 120),
  telefono            text        not null check (telefono ~ '^[0-9]{10}$'),
  asiento_id          text        not null references public.asientos(id),
  modo                text        not null check (modo in ('auto', 'manual', 'admin')),
  confirmado_whatsapp boolean     not null default false,
  asistio_en          timestamptz,                                -- se llena al validar el QR en la entrada
  creado_en           timestamptz not null default now(),
  actualizado_en      timestamptz not null default now(),
  constraint asistentes_folio_unico     unique (folio),
  constraint asistentes_qr_unico        unique (codigo_qr),
  constraint asistentes_asiento_unico   unique (asiento_id),      -- un asiento, una persona
  constraint asistentes_correo_unico    unique (correo),          -- una persona, un lugar
  constraint asistentes_telefono_unico  unique (telefono)
);

-- Personal que administra el evento
create table public.administradores (
  id          smallint generated always as identity primary key,
  usuario     text not null,
  nombre      text not null,
  clave_hash  text not null,                                      -- bcrypt
  creado_en   timestamptz not null default now(),
  constraint administradores_usuario_unico unique (usuario)
);

-- Sesiones abiertas del panel administrativo
create table public.sesiones_admin (
  token      text        primary key,
  admin_id   smallint    not null references public.administradores(id) on delete cascade,
  creada_en  timestamptz not null default now(),
  expira_en  timestamptz not null
);

-- Bitácora de lecturas de QR en la entrada
create table public.accesos (
  id            integer generated always as identity primary key,
  asistente_id  integer     references public.asistentes(id) on delete set null,
  admin_id      smallint    not null references public.administradores(id),
  codigo_leido  text        not null,
  resultado     text        not null check (resultado in ('VALIDO', 'YA_INGRESO', 'NO_VALIDO')),
  fecha         timestamptz not null default now()
);
create index accesos_fecha_idx on public.accesos (fecha desc);

-- ===========================================================================
--  2. DATOS INICIALES
-- ===========================================================================
insert into public.evento (nombre, tema, fecha, hora_inicio, hora_fin, lugar, ponente, cupo)
values ('Cómo se gana una partida normal', 'Mecánicas de League of Legends',
        '2026-12-04', '17:00', '20:30', 'Auditorio principal', 'Ponente invitado', 100);

insert into public.mesas (id, evento_id, capacidad)
select m, 1, 10 from generate_series(1, 10) as m;

insert into public.asientos (id, mesa_id, numero)
select 'M' || lpad(m.id::text, 2, '0') || '-A' || lpad(n::text, 2, '0'), m.id, n
from public.mesas m, generate_series(1, m.capacidad) as n;

insert into public.administradores (usuario, nombre, clave_hash)
values ('admin', 'Organización', extensions.crypt('Conferencia2026!', extensions.gen_salt('bf')));

-- ===========================================================================
--  3. VISTA PARA EL ORGANIZADOR (panel de Supabase → Table Editor)
-- ===========================================================================
create view public.vista_asistentes with (security_invoker = true) as
select a.id, s.mesa_id as mesa, s.numero as lugar, a.folio, a.nombre, a.correo, a.telefono,
       a.modo, a.confirmado_whatsapp, a.asistio_en, a.creado_en
from public.asistentes a
join public.asientos s on s.id = a.asiento_id
order by s.mesa_id, s.numero;

-- ===========================================================================
--  4. FUNCIONES INTERNAS (no se pueden llamar desde la página)
-- ===========================================================================

-- Valida y normaliza los datos de una persona (misma regla que js/datos.js)
create function public._normalizar(p_nombre text, p_correo text, p_telefono text,
  out nombre text, out correo text, out telefono text)
language plpgsql immutable as $$
begin
  nombre   := btrim(regexp_replace(coalesce(p_nombre, ''), '\s+', ' ', 'g'));
  correo   := lower(btrim(coalesce(p_correo, '')));
  telefono := regexp_replace(coalesce(p_telefono, ''), '\D', '', 'g');
  if nombre !~ '^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ'' .-]{3,80}$'
     or char_length(correo) > 120
     or correo !~ '^[a-z0-9._%+-]+@gmail\.com$'   -- solo cuentas Gmail
     or telefono !~ '^[0-9]{10}$' then
    raise exception 'DATOS_INVALIDOS';
  end if;
end;
$$;

-- Ficha de un asistente en JSON (lo que ven la página y el panel)
create function public._ficha(p_id integer)
returns json language sql stable set search_path = public as $$
  select json_build_object(
    'id', a.id, 'folio', a.folio, 'codigo_qr', a.codigo_qr, 'nombre', a.nombre,
    'correo', a.correo, 'telefono', a.telefono, 'asiento', a.asiento_id,
    'mesa', s.mesa_id, 'lugar', s.numero, 'modo', a.modo,
    'confirmado_whatsapp', a.confirmado_whatsapp, 'asistio_en', a.asistio_en,
    'creado_en', a.creado_en)
  from asistentes a join asientos s on s.id = a.asiento_id
  where a.id = p_id;
$$;

-- Asigna asiento (el pedido o el primero libre) y registra a la persona.
--   FOR UPDATE + SKIP LOCKED: dos reservas automáticas simultáneas toman
--   asientos distintos. Si aun así chocan, se reintenta con el siguiente
--   lugar (corrección del BUG-04 de la versión 1).
create function public._insertar_asistente(p_nombre text, p_correo text, p_telefono text,
                                           p_asiento text, p_modo text)
returns json language plpgsql volatile set search_path = public, extensions as $$
declare
  d record;
  v_pedido  text := nullif(btrim(coalesce(p_asiento, '')), '');
  v_asiento text;
  v_id      integer;
  v_regla   text;
begin
  select * into d from _normalizar(p_nombre, p_correo, p_telefono);
  if exists (select 1 from asistentes where correo = d.correo) then raise exception 'CORREO_DUPLICADO'; end if;
  if exists (select 1 from asistentes where telefono = d.telefono) then raise exception 'TELEFONO_DUPLICADO'; end if;

  for intento in 1..25 loop
    if v_pedido is null then
      select s.id into v_asiento from asientos s
      where not exists (select 1 from asistentes a where a.asiento_id = s.id)
      order by s.mesa_id, s.numero
      limit 1 for update skip locked;
      if v_asiento is null then raise exception 'CUPO_LLENO'; end if;
    else
      select s.id into v_asiento from asientos s where s.id = v_pedido for update;
      if v_asiento is null then raise exception 'DATOS_INVALIDOS'; end if;
      if exists (select 1 from asistentes where asiento_id = v_asiento) then raise exception 'ASIENTO_OCUPADO'; end if;
    end if;

    begin
      insert into asistentes (folio, codigo_qr, nombre, correo, telefono, asiento_id, modo)
      values ('LOL-' || upper(encode(gen_random_bytes(4), 'hex')),
              'CMLOL-' || upper(encode(gen_random_bytes(12), 'hex')),
              d.nombre, d.correo, d.telefono, v_asiento,
              case when p_modo = 'admin' then 'admin' when v_pedido is null then 'auto' else 'manual' end)
      returning id into v_id;
      return _ficha(v_id);
    exception when unique_violation then
      get stacked diagnostics v_regla = constraint_name;
      if v_regla = 'asistentes_asiento_unico' and v_pedido is null then
        v_asiento := null;
        continue;                                   -- otro ganó ese lugar: probar el siguiente
      elsif v_regla in ('asistentes_folio_unico', 'asistentes_qr_unico') then
        continue;                                   -- folio o QR repetido (muy improbable): generar otro
      end if;
      raise exception '%', case v_regla
        when 'asistentes_asiento_unico'  then 'ASIENTO_OCUPADO'
        when 'asistentes_correo_unico'   then 'CORREO_DUPLICADO'
        when 'asistentes_telefono_unico' then 'TELEFONO_DUPLICADO'
        else 'ERROR_SERVIDOR' end;
    end;
  end loop;
  raise exception 'ERROR_SERVIDOR';
end;
$$;

-- Devuelve el id del administrador dueño del token o lanza SESION_INVALIDA
create function public._admin_de_sesion(p_token text)
returns smallint language plpgsql stable set search_path = public as $$
declare v_admin smallint;
begin
  select admin_id into v_admin from sesiones_admin
  where token = coalesce(p_token, '') and expira_en > now();
  if v_admin is null then raise exception 'SESION_INVALIDA'; end if;
  return v_admin;
end;
$$;

-- ===========================================================================
--  5. FUNCIONES PÚBLICAS (página del evento)
-- ===========================================================================

-- Asientos ocupados: solo ids, sin datos personales
create function public.asientos_ocupados()
returns json language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(asiento_id order by asiento_id), '[]'::json) from asistentes;
$$;

-- Registro de un asistente (p_asiento null = asignación automática)
create function public.reservar_asiento(p_nombre text, p_correo text, p_telefono text, p_asiento text default null)
returns json language plpgsql volatile security definer set search_path = public, extensions as $$
begin
  return _insertar_asistente(p_nombre, p_correo, p_telefono, p_asiento, 'publico');
end;
$$;

-- Recuperar el boleto: requiere folio Y correo
create function public.consultar_registro(p_folio text, p_correo text)
returns json language sql stable security definer set search_path = public as $$
  select _ficha(id) from asistentes
  where folio = upper(btrim(coalesce(p_folio, ''))) and correo = lower(btrim(coalesce(p_correo, '')));
$$;

-- Cancelar el propio registro: requiere folio Y correo
create function public.cancelar_registro(p_folio text, p_correo text)
returns boolean language plpgsql volatile security definer set search_path = public as $$
begin
  delete from asistentes
  where folio = upper(btrim(coalesce(p_folio, ''))) and correo = lower(btrim(coalesce(p_correo, '')));
  if not found then raise exception 'NO_ENCONTRADO'; end if;
  return true;
end;
$$;

-- ===========================================================================
--  6. FUNCIONES DEL PANEL ADMINISTRATIVO (requieren token de sesión)
-- ===========================================================================

create function public.admin_iniciar_sesion(p_usuario text, p_clave text)
returns json language plpgsql volatile security definer set search_path = public, extensions as $$
declare a record; v_token text;
begin
  delete from sesiones_admin where expira_en < now();
  select * into a from administradores where usuario = lower(btrim(coalesce(p_usuario, '')));
  if a.id is null or a.clave_hash <> crypt(coalesce(p_clave, ''), a.clave_hash) then
    perform pg_sleep(0.5);                         -- frena intentos de adivinar la clave
    raise exception 'CREDENCIALES_INVALIDAS';
  end if;
  v_token := encode(gen_random_bytes(24), 'hex');
  insert into sesiones_admin (token, admin_id, expira_en) values (v_token, a.id, now() + interval '8 hours');
  return json_build_object('token', v_token, 'nombre', a.nombre, 'expira_en', now() + interval '8 hours');
end;
$$;

create function public.admin_cerrar_sesion(p_token text)
returns boolean language sql volatile security definer set search_path = public as $$
  delete from sesiones_admin where token = coalesce(p_token, '') returning true;
$$;

create function public.admin_resumen(p_token text)
returns json language plpgsql stable security definer set search_path = public as $$
begin
  perform _admin_de_sesion(p_token);
  return (select json_build_object(
    'cupo',        (select count(*) from asientos),
    'registrados', (select count(*) from asistentes),
    'asistieron',  (select count(*) from asistentes where asistio_en is not null),
    'confirmados', (select count(*) from asistentes where confirmado_whatsapp)));
end;
$$;

-- Lista de asistentes, con búsqueda opcional por nombre, correo, folio o teléfono
create function public.admin_listar(p_token text, p_buscar text default null)
returns json language plpgsql stable security definer set search_path = public as $$
declare v text := '%' || lower(btrim(coalesce(p_buscar, ''))) || '%';
begin
  perform _admin_de_sesion(p_token);
  return (select coalesce(json_agg(_ficha(a.id) order by s.mesa_id, s.numero), '[]'::json)
          from asistentes a join asientos s on s.id = a.asiento_id
          where lower(a.nombre) like v or a.correo like v or lower(a.folio) like v or a.telefono like v);
end;
$$;

-- Alta manual desde el panel
create function public.admin_registrar(p_token text, p_nombre text, p_correo text, p_telefono text, p_asiento text default null)
returns json language plpgsql volatile security definer set search_path = public, extensions as $$
begin
  perform _admin_de_sesion(p_token);
  return _insertar_asistente(p_nombre, p_correo, p_telefono, p_asiento, 'admin');
end;
$$;

-- Modificar datos, cambiar de asiento o marcar la confirmación por WhatsApp
create function public.admin_actualizar(p_token text, p_id integer, p_nombre text, p_correo text,
                                        p_telefono text, p_asiento text, p_confirmado boolean)
returns json language plpgsql volatile security definer set search_path = public as $$
declare d record; v_regla text;
begin
  perform _admin_de_sesion(p_token);
  select * into d from _normalizar(p_nombre, p_correo, p_telefono);
  if not exists (select 1 from asistentes where id = p_id) then raise exception 'NO_ENCONTRADO'; end if;
  if not exists (select 1 from asientos where id = p_asiento) then raise exception 'DATOS_INVALIDOS'; end if;
  update asistentes
     set nombre = d.nombre, correo = d.correo, telefono = d.telefono, asiento_id = p_asiento,
         confirmado_whatsapp = coalesce(p_confirmado, false), actualizado_en = now()
   where id = p_id;
  return _ficha(p_id);
exception when unique_violation then
  get stacked diagnostics v_regla = constraint_name;
  raise exception '%', case v_regla
    when 'asistentes_asiento_unico'  then 'ASIENTO_OCUPADO'
    when 'asistentes_correo_unico'   then 'CORREO_DUPLICADO'
    when 'asistentes_telefono_unico' then 'TELEFONO_DUPLICADO'
    else 'ERROR_SERVIDOR' end;
end;
$$;

create function public.admin_eliminar(p_token text, p_id integer)
returns boolean language plpgsql volatile security definer set search_path = public as $$
begin
  perform _admin_de_sesion(p_token);
  delete from asistentes where id = p_id;
  if not found then raise exception 'NO_ENCONTRADO'; end if;
  return true;
end;
$$;

-- Validar el QR en la entrada: VALIDO (primera vez), YA_INGRESO o NO_VALIDO
create function public.admin_validar_qr(p_token text, p_codigo text)
returns json language plpgsql volatile security definer set search_path = public as $$
declare
  v_admin smallint := _admin_de_sesion(p_token);
  v_codigo text := upper(btrim(coalesce(p_codigo, '')));
  a record;
  v_resultado text;
begin
  select * into a from asistentes where codigo_qr = v_codigo for update;
  if a.id is null then
    v_resultado := 'NO_VALIDO';
  elsif a.asistio_en is not null then
    v_resultado := 'YA_INGRESO';
  else
    v_resultado := 'VALIDO';
    update asistentes set asistio_en = now(), actualizado_en = now() where id = a.id;
  end if;
  insert into accesos (asistente_id, admin_id, codigo_leido, resultado)
  values (a.id, v_admin, left(v_codigo, 120), v_resultado);
  return json_build_object('resultado', v_resultado,
                           'asistente', case when a.id is null then null else _ficha(a.id) end);
end;
$$;

-- Últimas lecturas de QR
create function public.admin_accesos(p_token text, p_limite integer default 20)
returns json language plpgsql stable security definer set search_path = public as $$
begin
  perform _admin_de_sesion(p_token);
  return (select coalesce(json_agg(x order by x.fecha desc), '[]'::json) from (
    select c.fecha, c.resultado, c.codigo_leido, a.nombre, s.mesa_id as mesa, s.numero as lugar
    from accesos c
    left join asistentes a on a.id = c.asistente_id
    left join asientos s on s.id = a.asiento_id
    order by c.fecha desc limit least(greatest(coalesce(p_limite, 20), 1), 100)) x);
end;
$$;

-- ===========================================================================
--  7. PERMISOS
-- ===========================================================================
alter table public.evento          enable row level security;
alter table public.mesas           enable row level security;
alter table public.asientos        enable row level security;
alter table public.asistentes      enable row level security;
alter table public.administradores enable row level security;
alter table public.sesiones_admin  enable row level security;
alter table public.accesos         enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function
  public.asientos_ocupados(),
  public.reservar_asiento(text, text, text, text),
  public.consultar_registro(text, text),
  public.cancelar_registro(text, text),
  public.admin_iniciar_sesion(text, text),
  public.admin_cerrar_sesion(text),
  public.admin_resumen(text),
  public.admin_listar(text, text),
  public.admin_registrar(text, text, text, text, text),
  public.admin_actualizar(text, integer, text, text, text, text, boolean),
  public.admin_eliminar(text, integer),
  public.admin_validar_qr(text, text),
  public.admin_accesos(text, integer)
to anon, authenticated;

-- ===========================================================================
--  Cambiar la clave del administrador (ejecútalo aparte, con tu clave):
--    update public.administradores
--       set clave_hash = extensions.crypt('TuClaveNueva', extensions.gen_salt('bf'))
--     where usuario = 'admin';
--  Agregar otro administrador:
--    insert into public.administradores (usuario, nombre, clave_hash)
--    values ('acceso1', 'Puerta 1', extensions.crypt('OtraClave', extensions.gen_salt('bf')));
-- ===========================================================================
