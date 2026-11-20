-- ===========================================================================
--  CONFERENCIA MAGISTRAL «Cómo se gana una partida normal»
--  Base de datos — PostgreSQL 15+ (Supabase)                     Versión 2
-- ---------------------------------------------------------------------------
--  Cómo usarlo:
--    1. supabase.com → proyecto nuevo → SQL Editor → pega TODO este archivo → Run.
--    2. Copia la URL del proyecto y la clave pública en js/config.js.
--    3. Entra a admin.html con  usuario: admin   clave: Conferencia2026!
--       y CÁMBIALA (ver «Cambiar la clave» al final de este archivo).
--
--  ¡OJO! Volver a ejecutar el script BORRA todos los registros.
--
--  Modelo:
--    • Un ASISTENTE es la persona que reserva (nombre, correo Gmail, WhatsApp
--      y, si pide lugar accesible, el tipo de discapacidad).
--    • Cada asistente tiene de 1 a 5 BOLETOS: uno por lugar (ella y sus
--      acompañantes), cada uno con su asiento y su propio código QR.
--    • Los asientos marcados como ACCESIBLES (♿) solo pueden asignarse a
--      registros que indicaron una discapacidad (lo vigila un trigger).
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
--  Limpieza (permite volver a ejecutar el script, también sobre la versión 1)
-- ---------------------------------------------------------------------------
drop view if exists public.vista_asistentes, public.vista_boletos cascade;
drop table if exists public.accesos, public.sesiones_admin, public.administradores,
                     public.boletos, public.asistentes, public.asientos, public.mesas, public.evento cascade;
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as firma
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in (
             'asientos_ocupados', 'reservar_asiento', 'reservar_lugares', 'consultar_registro', 'cancelar_registro',
             'admin_iniciar_sesion', 'admin_cerrar_sesion', 'admin_resumen', 'admin_listar', 'admin_registrar',
             'admin_actualizar', 'admin_eliminar', 'admin_validar_qr', 'admin_accesos',
             '_normalizar', '_insertar_asistente', '_asignar', '_admin_de_sesion', '_ficha', '_boleto', '_revisar_boleto')
  loop
    execute 'drop function ' || f.firma || ' cascade';
  end loop;
end;
$$;

-- ===========================================================================
--  1. TABLAS
-- ===========================================================================

-- Datos generales del evento (una sola fila)
create table public.evento (
  id                       smallint primary key default 1 check (id = 1),
  nombre                   text     not null,
  tema                     text     not null,
  fecha                    date     not null,
  hora_inicio              time     not null,
  hora_fin                 time     not null,
  lugar                    text     not null,
  ponente                  text     not null,
  cupo                     smallint not null check (cupo > 0),
  max_lugares_registro     smallint not null default 5 check (max_lugares_registro between 1 and 20),
  max_accesibles_registro  smallint not null default 1 check (max_accesibles_registro between 0 and 20)
);

-- Mesas del recinto
create table public.mesas (
  id         smallint primary key check (id between 1 and 99),   -- número de mesa
  evento_id  smallint not null references public.evento(id) on delete cascade,
  capacidad  smallint not null check (capacidad between 1 and 20)
);

-- Asientos de cada mesa
create table public.asientos (
  id         text     primary key,                                -- 'M03-A05'
  mesa_id    smallint not null references public.mesas(id) on delete cascade,
  numero     smallint not null check (numero between 1 and 20),
  accesible  boolean  not null default false,                     -- ♿ reservado para personas con discapacidad
  constraint asientos_mesa_numero_unico unique (mesa_id, numero)
);

-- Personas que reservan (titular del registro)
create table public.asistentes (
  id                    integer generated always as identity primary key,
  folio                 text        not null,                     -- 'LOL-1A2B3C4D' (lo ve el asistente)
  nombre                text        not null check (char_length(nombre) between 3 and 80),
  correo                text        not null check (char_length(correo) <= 120 and correo ~ '^[a-z0-9._%+-]+@gmail\.com$'),
  telefono              text        not null check (telefono ~ '^[0-9]{10}$'),
  discapacidad          text        check (discapacidad in ('silla_ruedas', 'motriz', 'visual', 'auditiva', 'otra')),
  discapacidad_detalle  text        check (char_length(discapacidad_detalle) <= 200),
  modo                  text        not null check (modo in ('auto', 'manual', 'admin')),
  confirmado_whatsapp   boolean     not null default false,
  creado_en             timestamptz not null default now(),
  actualizado_en        timestamptz not null default now(),
  constraint asistentes_folio_unico     unique (folio),
  constraint asistentes_correo_unico    unique (correo),          -- una persona, un registro
  constraint asistentes_telefono_unico  unique (telefono),
  -- el detalle solo existe si hay discapacidad, y es obligatorio si el tipo es «otra»
  constraint asistentes_detalle_valido  check (discapacidad is not null or discapacidad_detalle is null),
  constraint asistentes_otra_descrita   check (discapacidad is distinct from 'otra' or char_length(coalesce(discapacidad_detalle, '')) >= 3)
);

-- Boletos: uno por lugar reservado, cada uno con su asiento y su QR
create table public.boletos (
  id            integer generated always as identity primary key,
  asistente_id  integer     not null references public.asistentes(id) on delete cascade,
  numero        smallint    not null check (numero between 1 and 20),   -- boleto 1 de N, 2 de N…
  asiento_id    text        not null references public.asientos(id),
  codigo_qr     text        not null,                                  -- 'CMLOL-…' (va dentro del QR)
  asistio_en    timestamptz,                                           -- se llena al validar el QR
  creado_en     timestamptz not null default now(),
  constraint boletos_asistente_numero_unico unique (asistente_id, numero),
  constraint boletos_qr_unico      unique (codigo_qr),                  -- cada QR es único
  -- un asiento, un boleto (diferible para poder intercambiar asientos en una edición)
  constraint boletos_asiento_unico unique (asiento_id) deferrable initially immediate
);
create index boletos_asistente_idx on public.boletos (asistente_id);

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
  boleto_id     integer     references public.boletos(id) on delete set null,
  admin_id      smallint    not null references public.administradores(id),
  codigo_leido  text        not null,
  resultado     text        not null check (resultado in ('VALIDO', 'YA_INGRESO', 'NO_VALIDO')),
  fecha         timestamptz not null default now()
);
create index accesos_fecha_idx on public.accesos (fecha desc);

-- Regla de negocio en la propia base: un lugar accesible solo para quien
-- indicó una discapacidad (aunque alguien intente saltarse la página).
create function public._revisar_boleto()
returns trigger language plpgsql set search_path = public as $$
begin
  if (select accesible from asientos where id = new.asiento_id)
     and (select discapacidad from asistentes where id = new.asistente_id) is null then
    raise exception 'ACCESIBLE_NO_PERMITIDO';
  end if;
  return new;
end;
$$;
create trigger boletos_accesible
  before insert or update of asiento_id, asistente_id on public.boletos
  for each row execute function public._revisar_boleto();

-- ===========================================================================
--  2. DATOS INICIALES   (si cambias algo aquí, cambia también js/config.js → sala)
-- ===========================================================================
insert into public.evento (nombre, tema, fecha, hora_inicio, hora_fin, lugar, ponente, cupo,
                           max_lugares_registro, max_accesibles_registro)
values ('Cómo se gana una partida normal', 'Mecánicas de League of Legends',
        '2026-12-04', '17:00', '20:30', 'Auditorio principal', 'Ponente invitado', 100, 5, 1);

insert into public.mesas (id, evento_id, capacidad)
select m, 1, 10 from generate_series(1, 10) as m;

insert into public.asientos (id, mesa_id, numero)
select 'M' || lpad(m.id::text, 2, '0') || '-A' || lpad(n::text, 2, '0'), m.id, n
from public.mesas m, generate_series(1, m.capacidad) as n;

-- Lugares accesibles ♿: asientos 1 y 2 de las mesas 1 a 4 (cerca del escenario)
update public.asientos set accesible = true
where id in ('M01-A01', 'M01-A02', 'M02-A01', 'M02-A02', 'M03-A01', 'M03-A02', 'M04-A01', 'M04-A02');

insert into public.administradores (usuario, nombre, clave_hash)
values ('admin', 'Organización', extensions.crypt('Conferencia2026!', extensions.gen_salt('bf')));

-- ===========================================================================
--  3. VISTAS PARA EL ORGANIZADOR (panel de Supabase → Table Editor)
-- ===========================================================================
create view public.vista_boletos with (security_invoker = true) as
select b.id as boleto_id, a.folio, b.numero || ' de ' || (select count(*) from public.boletos x where x.asistente_id = a.id) as boleto,
       s.mesa_id as mesa, s.numero as lugar, s.accesible, a.nombre, a.correo, a.telefono,
       a.discapacidad, a.discapacidad_detalle, a.modo, a.confirmado_whatsapp, b.asistio_en, a.creado_en
from public.boletos b
join public.asistentes a on a.id = b.asistente_id
join public.asientos s on s.id = b.asiento_id
order by s.mesa_id, s.numero;

-- ===========================================================================
--  4. FUNCIONES INTERNAS (no se pueden llamar desde la página)
-- ===========================================================================

-- Valida y normaliza los datos de una persona (misma regla que js/datos.js)
create function public._normalizar(p_nombre text, p_correo text, p_telefono text, p_discapacidad text, p_detalle text,
  out nombre text, out correo text, out telefono text, out discapacidad text, out detalle text)
language plpgsql immutable as $$
begin
  nombre       := btrim(regexp_replace(coalesce(p_nombre, ''), '\s+', ' ', 'g'));
  correo       := lower(btrim(coalesce(p_correo, '')));
  telefono     := regexp_replace(coalesce(p_telefono, ''), '\D', '', 'g');
  discapacidad := nullif(btrim(coalesce(p_discapacidad, '')), '');
  detalle      := case when discapacidad is null then null
                       else nullif(btrim(regexp_replace(coalesce(p_detalle, ''), '\s+', ' ', 'g')), '') end;
  if nombre !~ '^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ'' .-]{3,80}$'
     or char_length(correo) > 120
     or correo !~ '^[a-z0-9._%+-]+@gmail\.com$'   -- solo cuentas Gmail
     or telefono !~ '^[0-9]{10}$'
     or (discapacidad is not null and discapacidad not in ('silla_ruedas', 'motriz', 'visual', 'auditiva', 'otra'))
     or (discapacidad = 'otra' and char_length(coalesce(detalle, '')) < 3)
     or char_length(coalesce(detalle, '')) > 200 then
    raise exception 'DATOS_INVALIDOS';
  end if;
end;
$$;

-- Un boleto en JSON
create function public._boleto(p_id integer)
returns json language sql stable set search_path = public as $$
  select json_build_object('id', b.id, 'numero', b.numero, 'codigo_qr', b.codigo_qr, 'asiento', b.asiento_id,
                           'mesa', s.mesa_id, 'lugar', s.numero, 'accesible', s.accesible, 'asistio_en', b.asistio_en)
  from boletos b join asientos s on s.id = b.asiento_id
  where b.id = p_id;
$$;

-- Ficha de un registro con todos sus boletos (lo que ven la página y el panel)
create function public._ficha(p_id integer)
returns json language sql stable set search_path = public as $$
  select json_build_object(
    'id', a.id, 'folio', a.folio, 'nombre', a.nombre, 'correo', a.correo, 'telefono', a.telefono,
    'discapacidad', a.discapacidad, 'discapacidad_detalle', a.discapacidad_detalle, 'modo', a.modo,
    'confirmado_whatsapp', a.confirmado_whatsapp, 'creado_en', a.creado_en,
    'boletos', (select coalesce(json_agg(_boleto(b.id) order by b.numero), '[]'::json)
                from boletos b where b.asistente_id = a.id))
  from asistentes a
  where a.id = p_id;
$$;

-- Asignación de lugares (misma lógica que asignar() en js/datos.js):
--   1. Se respetan los asientos elegidos (deben existir y estar libres).
--   2. Si la persona pidió lugar accesible y no eligió uno, se le da el
--      primer accesible libre (si no queda ninguno, recibe uno normal).
--   3. El resto se completa con asientos normales lo más cerca posible:
--      misma mesa y asientos contiguos; si no hay ancla, la primera mesa
--      donde quepa todo el grupo.
--   FOR UPDATE + SKIP LOCKED: dos reservas simultáneas toman asientos distintos.
create function public._asignar(p_elegidos text[], p_cantidad integer, p_accesible boolean)
returns text[] language plpgsql volatile set search_path = public as $$
declare
  v_res      text[] := coalesce(p_elegidos, '{}');
  v_max      smallint;
  v_max_acc  smallint;
  v_n_acc    integer;
  v_mesa     smallint;
  v_num      smallint;
  v_cap      smallint;
  v_acc      record;
  v_faltan   integer;
  v_resto    text[];
begin
  select max_lugares_registro, max_accesibles_registro into v_max, v_max_acc from evento where id = 1;
  if p_cantidad is null or p_cantidad < 1 or p_cantidad > v_max
     or cardinality(v_res) > p_cantidad
     or (select count(distinct x) from unnest(v_res) x) <> cardinality(v_res)
     or (select count(*) from asientos where id = any(v_res)) <> cardinality(v_res) then
    raise exception 'DATOS_INVALIDOS';
  end if;

  v_n_acc := (select count(*) from asientos where id = any(v_res) and accesible);
  if v_n_acc > 0 and not p_accesible then raise exception 'ACCESIBLE_NO_PERMITIDO'; end if;
  if v_n_acc > v_max_acc then raise exception 'ACCESIBLES_EXCEDIDOS'; end if;

  perform 1 from asientos where id = any(v_res) order by id for update;
  if exists (select 1 from boletos where asiento_id = any(v_res)) then raise exception 'ASIENTO_OCUPADO'; end if;

  if cardinality(v_res) > 0 then
    select mesa_id, numero into v_mesa, v_num from asientos where id = v_res[1];
  end if;

  if p_accesible and v_n_acc = 0 and v_max_acc > 0 and cardinality(v_res) < p_cantidad then
    select s.id, s.mesa_id, s.numero into v_acc
    from asientos s
    where s.accesible and not exists (select 1 from boletos b where b.asiento_id = s.id)
    order by (s.mesa_id is distinct from v_mesa), s.mesa_id, s.numero
    limit 1 for update skip locked;
    if v_acc.id is not null then
      v_res := v_res || v_acc.id;
      if v_mesa is null then v_mesa := v_acc.mesa_id; v_num := v_acc.numero; end if;
    end if;
  end if;

  v_faltan := p_cantidad - cardinality(v_res);
  if v_faltan <= 0 then return v_res; end if;

  if v_mesa is null then   -- sin ancla: primera mesa donde quepa todo el grupo
    select s.mesa_id, min(s.numero) into v_mesa, v_num
    from asientos s
    where not s.accesible and not exists (select 1 from boletos b where b.asiento_id = s.id)
    group by s.mesa_id having count(*) >= v_faltan
    order by s.mesa_id limit 1;
  end if;
  select capacidad into v_cap from mesas where id = v_mesa;

  select array_agg(x.id) into v_resto from (
    select s.id from asientos s
    where not s.accesible and s.id <> all(v_res)
      and not exists (select 1 from boletos b where b.asiento_id = s.id)
    order by (s.mesa_id is distinct from v_mesa),
             abs(s.mesa_id - coalesce(v_mesa, 0)),
             case when s.mesa_id = v_mesa then least(abs(s.numero - v_num), v_cap - abs(s.numero - v_num)) else s.numero end,
             s.mesa_id, s.numero
    limit v_faltan
    for update of s skip locked) x;

  if coalesce(cardinality(v_resto), 0) < v_faltan then
    raise exception '%', case when (select count(*) from boletos) >= (select count(*) from asientos)
                              then 'CUPO_LLENO' else 'LUGARES_INSUFICIENTES' end;
  end if;
  return v_res || v_resto;
end;
$$;

-- Registra a la persona con sus boletos. Si otra reserva simultánea gana un
-- asiento automático, se reintenta (corrección del BUG-04 de la versión 1).
create function public._insertar_asistente(p_nombre text, p_correo text, p_telefono text, p_cantidad integer,
                                           p_asientos text[], p_discapacidad text, p_detalle text, p_modo text)
returns json language plpgsql volatile set search_path = public, extensions as $$
declare
  d          record;
  v_pedidos  text[] := array(select btrim(x) from unnest(coalesce(p_asientos, '{}')) with ordinality t(x, n)
                             where nullif(btrim(x), '') is not null order by n);
  v_asientos text[];
  v_id       integer;
  v_regla    text;
begin
  select * into d from _normalizar(p_nombre, p_correo, p_telefono, p_discapacidad, p_detalle);
  if exists (select 1 from asistentes where correo = d.correo) then raise exception 'CORREO_DUPLICADO'; end if;
  if exists (select 1 from asistentes where telefono = d.telefono) then raise exception 'TELEFONO_DUPLICADO'; end if;

  for intento in 1..25 loop
    begin
      v_asientos := _asignar(v_pedidos, p_cantidad, d.discapacidad is not null);
      insert into asistentes (folio, nombre, correo, telefono, discapacidad, discapacidad_detalle, modo)
      values ('LOL-' || upper(encode(gen_random_bytes(4), 'hex')), d.nombre, d.correo, d.telefono,
              d.discapacidad, d.detalle,
              case when p_modo = 'admin' then 'admin' when cardinality(v_pedidos) = 0 then 'auto' else 'manual' end)
      returning id into v_id;
      insert into boletos (asistente_id, numero, asiento_id, codigo_qr)
      select v_id, t.n, t.a, 'CMLOL-' || upper(encode(gen_random_bytes(12), 'hex'))
      from unnest(v_asientos) with ordinality t(a, n);
      return _ficha(v_id);
    exception when unique_violation then
      get stacked diagnostics v_regla = constraint_name;
      if v_regla = 'boletos_asiento_unico'
         and not exists (select 1 from boletos where asiento_id = any(v_pedidos)) then
        continue;                                   -- otro ganó un asiento automático: probar otra vez
      elsif v_regla in ('asistentes_folio_unico', 'boletos_qr_unico') then
        continue;                                   -- folio o QR repetido (muy improbable): generar otro
      end if;
      raise exception '%', case v_regla
        when 'boletos_asiento_unico'     then 'ASIENTO_OCUPADO'
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
  select coalesce(json_agg(asiento_id order by asiento_id), '[]'::json) from boletos;
$$;

-- Registro de una persona con 1 a 5 lugares
--   p_asientos vacío = asignación automática de p_cantidad lugares
--   p_discapacidad   = null o 'silla_ruedas' | 'motriz' | 'visual' | 'auditiva' | 'otra'
create function public.reservar_lugares(p_nombre text, p_correo text, p_telefono text, p_cantidad integer default 1,
                                        p_asientos text[] default '{}', p_discapacidad text default null,
                                        p_detalle text default null)
returns json language plpgsql volatile security definer set search_path = public, extensions as $$
begin
  return _insertar_asistente(p_nombre, p_correo, p_telefono, p_cantidad, p_asientos, p_discapacidad, p_detalle, 'publico');
end;
$$;

-- Recuperar los boletos: requiere folio Y correo
create function public.consultar_registro(p_folio text, p_correo text)
returns json language sql stable security definer set search_path = public as $$
  select _ficha(id) from asistentes
  where folio = upper(btrim(coalesce(p_folio, ''))) and correo = lower(btrim(coalesce(p_correo, '')));
$$;

-- Cancelar el propio registro (libera todos sus lugares): requiere folio Y correo
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
    'cupo',              (select count(*) from asientos),
    'ocupados',          (select count(*) from boletos),
    'registros',         (select count(*) from asistentes),
    'asistieron',        (select count(*) from boletos where asistio_en is not null),
    'confirmados',       (select count(*) from asistentes where confirmado_whatsapp),
    'accesibles_libres', (select count(*) from asientos s where s.accesible
                            and not exists (select 1 from boletos b where b.asiento_id = s.id))));
end;
$$;

-- Lista de registros, con búsqueda opcional por nombre, correo, folio o teléfono
create function public.admin_listar(p_token text, p_buscar text default null)
returns json language plpgsql stable security definer set search_path = public as $$
declare v text := '%' || lower(btrim(coalesce(p_buscar, ''))) || '%';
begin
  perform _admin_de_sesion(p_token);
  return (select coalesce(json_agg(_ficha(a.id) order by b1.asiento_id), '[]'::json)
          from asistentes a
          join boletos b1 on b1.asistente_id = a.id and b1.numero = 1
          where lower(a.nombre) like v or a.correo like v or lower(a.folio) like v or a.telefono like v);
end;
$$;

-- Alta manual desde el panel (los asientos que no se elijan se asignan solos)
create function public.admin_registrar(p_token text, p_nombre text, p_correo text, p_telefono text, p_cantidad integer default 1,
                                       p_asientos text[] default '{}', p_discapacidad text default null,
                                       p_detalle text default null)
returns json language plpgsql volatile security definer set search_path = public, extensions as $$
begin
  perform _admin_de_sesion(p_token);
  return _insertar_asistente(p_nombre, p_correo, p_telefono, p_cantidad, p_asientos, p_discapacidad, p_detalle, 'admin');
end;
$$;

-- Modificar datos, reasignar los asientos de cada boleto o marcar la confirmación por WhatsApp.
--   p_asientos trae un asiento por boleto, en orden (boleto 1, boleto 2, …).
create function public.admin_actualizar(p_token text, p_id integer, p_nombre text, p_correo text, p_telefono text,
                                        p_asientos text[], p_discapacidad text, p_detalle text, p_confirmado boolean)
returns json language plpgsql volatile security definer set search_path = public as $$
declare d record; v_n integer; v_n_acc integer; v_max_acc smallint; v_regla text;
begin
  perform _admin_de_sesion(p_token);
  select * into d from _normalizar(p_nombre, p_correo, p_telefono, p_discapacidad, p_detalle);
  if not exists (select 1 from asistentes where id = p_id) then raise exception 'NO_ENCONTRADO'; end if;
  v_n := (select count(*) from boletos where asistente_id = p_id);
  if coalesce(cardinality(p_asientos), 0) <> v_n
     or (select count(distinct x) from unnest(p_asientos) x) <> v_n
     or (select count(*) from asientos where id = any(p_asientos)) <> v_n then
    raise exception 'DATOS_INVALIDOS';
  end if;
  select max_accesibles_registro into v_max_acc from evento where id = 1;
  v_n_acc := (select count(*) from asientos where id = any(p_asientos) and accesible);
  if v_n_acc > 0 and d.discapacidad is null then raise exception 'ACCESIBLE_NO_PERMITIDO'; end if;
  if v_n_acc > v_max_acc then raise exception 'ACCESIBLES_EXCEDIDOS'; end if;
  perform 1 from asientos where id = any(p_asientos) order by id for update;
  if exists (select 1 from boletos where asiento_id = any(p_asientos) and asistente_id <> p_id) then
    raise exception 'ASIENTO_OCUPADO';
  end if;

  update asistentes
     set nombre = d.nombre, correo = d.correo, telefono = d.telefono,
         discapacidad = d.discapacidad, discapacidad_detalle = d.detalle,
         confirmado_whatsapp = coalesce(p_confirmado, false), actualizado_en = now()
   where id = p_id;
  set constraints public.boletos_asiento_unico deferred;     -- permite intercambiar asientos entre sus boletos
  update boletos b set asiento_id = x.a
    from unnest(p_asientos) with ordinality x(a, n)
   where b.asistente_id = p_id and b.numero = x.n;
  set constraints public.boletos_asiento_unico immediate;
  return _ficha(p_id);
exception when unique_violation then
  get stacked diagnostics v_regla = constraint_name;
  raise exception '%', case v_regla
    when 'boletos_asiento_unico'     then 'ASIENTO_OCUPADO'
    when 'asistentes_correo_unico'   then 'CORREO_DUPLICADO'
    when 'asistentes_telefono_unico' then 'TELEFONO_DUPLICADO'
    else 'ERROR_SERVIDOR' end;
end;
$$;

create function public.admin_eliminar(p_token text, p_id integer)
returns boolean language plpgsql volatile security definer set search_path = public as $$
begin
  perform _admin_de_sesion(p_token);
  delete from asistentes where id = p_id;            -- sus boletos se borran en cascada
  if not found then raise exception 'NO_ENCONTRADO'; end if;
  return true;
end;
$$;

-- Validar un QR en la entrada: VALIDO (primera vez), YA_INGRESO o NO_VALIDO
create function public.admin_validar_qr(p_token text, p_codigo text)
returns json language plpgsql volatile security definer set search_path = public as $$
declare
  v_admin smallint := _admin_de_sesion(p_token);
  v_codigo text := upper(btrim(coalesce(p_codigo, '')));
  b record;
  v_resultado text;
begin
  select * into b from boletos where codigo_qr = v_codigo for update;
  if b.id is null then
    v_resultado := 'NO_VALIDO';
  elsif b.asistio_en is not null then
    v_resultado := 'YA_INGRESO';
  else
    v_resultado := 'VALIDO';
    update boletos set asistio_en = now() where id = b.id;
  end if;
  insert into accesos (boleto_id, admin_id, codigo_leido, resultado)
  values (b.id, v_admin, left(v_codigo, 120), v_resultado);
  return json_build_object('resultado', v_resultado,
                           'asistente', case when b.id is null then null else _ficha(b.asistente_id) end,
                           'boleto',    case when b.id is null then null else _boleto(b.id) end);
end;
$$;

-- Últimas lecturas de QR
create function public.admin_accesos(p_token text, p_limite integer default 20)
returns json language plpgsql stable security definer set search_path = public as $$
begin
  perform _admin_de_sesion(p_token);
  return (select coalesce(json_agg(x order by x.fecha desc), '[]'::json) from (
    select c.fecha, c.resultado, c.codigo_leido, a.nombre, s.mesa_id as mesa, s.numero as lugar, b.numero,
           case when a.id is null then null else (select count(*) from boletos z where z.asistente_id = a.id) end as total
    from accesos c
    left join boletos b on b.id = c.boleto_id
    left join asistentes a on a.id = b.asistente_id
    left join asientos s on s.id = b.asiento_id
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
alter table public.boletos         enable row level security;
alter table public.administradores enable row level security;
alter table public.sesiones_admin  enable row level security;
alter table public.accesos         enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function
  public.asientos_ocupados(),
  public.reservar_lugares(text, text, text, integer, text[], text, text),
  public.consultar_registro(text, text),
  public.cancelar_registro(text, text),
  public.admin_iniciar_sesion(text, text),
  public.admin_cerrar_sesion(text),
  public.admin_resumen(text),
  public.admin_listar(text, text),
  public.admin_registrar(text, text, text, text, integer, text[], text, text),
  public.admin_actualizar(text, integer, text, text, text, text[], text, text, boolean),
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
