-- ===========================================================================
--  pruebas_crud.sql — Evidencias de operaciones CRUD y restricciones
--  Ejecutar DESPUÉS de schema.sql en una base de PRUEBA (modifica datos).
--  Todo corre con el rol público «anon», igual que la página web.
-- ===========================================================================
\pset pager off
\set ON_ERROR_STOP 0
set role anon;

\echo '=== C1. CREATE: registro con asignación automática ==='
select reservar_asiento('Ana López', 'ana@correo.com', '5511111111') ->> 'folio' is not null as registrado;

\echo '=== C2. CREATE: registro eligiendo asiento (mesa 5, asiento 7) ==='
select r->>'nombre' as nombre, r->>'mesa' as mesa, r->>'lugar' as lugar
from reservar_asiento('Luis Gómez', 'luis@correo.com', '5522222222', 'M05-A07') as r;

\echo '=== R1. READ: lista de ocupados (sin datos personales) ==='
select asientos_ocupados();

\echo '=== R2. READ directo a la tabla con la clave pública (debe fallar) ==='
select nombre, correo from asistentes;

\echo '=== X1. RESTRICCIÓN: correo duplicado ==='
select reservar_asiento('Otra Persona', 'ANA@correo.com', '5533333333');
\echo '=== X2. RESTRICCIÓN: teléfono duplicado ==='
select reservar_asiento('Otra Persona', 'otra@correo.com', '5511111111');
\echo '=== X3. RESTRICCIÓN: asiento ocupado ==='
select reservar_asiento('Otra Persona', 'otra@correo.com', '5544444444', 'M05-A07');
\echo '=== X4. RESTRICCIÓN: datos inválidos ==='
select reservar_asiento('A1', 'sin-arroba', '123');

\echo '=== A1. Panel: clave incorrecta ==='
select admin_iniciar_sesion('admin', 'equivocada');
\echo '=== A2. Panel: sin sesión ==='
select admin_listar('token-falso');

\echo '=== A3. Panel: inicio de sesión correcto ==='
select (admin_iniciar_sesion('admin', 'Conferencia2026!') ->> 'token') as token \gset
select length(:'token') as largo_token;

\echo '=== R3. READ (panel): asistentes registrados ==='
select x->>'id' as id, x->>'folio' as folio, x->>'nombre' as nombre, x->>'mesa' as mesa, x->>'lugar' as lugar
from json_array_elements(admin_listar(:'token')) as x;

\echo '=== U1. UPDATE (panel): cambiar a Luis a la mesa 2, asiento 3 y marcar WhatsApp ==='
select x->>'nombre' as nombre, x->>'asiento' as asiento, x->>'confirmado_whatsapp' as whatsapp
from admin_actualizar(:'token', 2, 'Luis Gómez Ruiz', 'luis@correo.com', '5522222222', 'M02-A03', true) as x;

\echo '=== U2. UPDATE (panel): mover a un asiento ocupado (debe fallar) ==='
select admin_actualizar(:'token', 2, 'Luis Gómez Ruiz', 'luis@correo.com', '5522222222', 'M01-A01', true);

\echo '=== Q1. QR único por asistente: validar en la entrada ==='
select (admin_listar(:'token', 'ana') -> 0 ->> 'codigo_qr') as qr \gset
select admin_validar_qr(:'token', :'qr') ->> 'resultado' as primera_lectura;
select admin_validar_qr(:'token', :'qr') ->> 'resultado' as segunda_lectura;
select admin_validar_qr(:'token', 'CMLOL-FALSO') ->> 'resultado' as qr_inventado;

\echo '=== R4. READ (panel): resumen ==='
select admin_resumen(:'token');

\echo '=== D1. DELETE (panel): eliminar a Luis ==='
select admin_eliminar(:'token', 2) as eliminado;
select admin_resumen(:'token') ->> 'registrados' as registrados_despues;

\echo '=== D2. DELETE (asistente): cancelar con folio y correo equivocado (debe fallar) ==='
select (admin_listar(:'token', 'ana') -> 0 ->> 'folio') as folio \gset
select cancelar_registro(:'folio', 'intruso@correo.com');

\echo '=== R5. READ (panel): bitácora de accesos ==='
select x->>'resultado' as resultado, x->>'nombre' as nombre from json_array_elements(admin_accesos(:'token')) as x;

\echo '=== A4. Cerrar sesión y volver a usar el token (debe fallar) ==='
select admin_cerrar_sesion(:'token');
select admin_resumen(:'token');
reset role;
