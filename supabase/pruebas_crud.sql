-- ===========================================================================
--  pruebas_crud.sql — Evidencias de operaciones CRUD y restricciones (v2)
--  Ejecutar DESPUÉS de schema.sql en una base de PRUEBA (modifica datos).
--  Todo corre con el rol público «anon», igual que la página web.
--  Es SQL puro: funciona en psql y en el SQL Editor de Supabase.
--  Las sentencias que «deben fallar» muestran el error esperado.
-- ===========================================================================
set role anon;
create temporary table prueba (clave text primary key, valor text);

select '=== C1. CREATE: 1 lugar, asignación automática ===' as paso;
select r->>'folio' as folio, r->'boletos'->0->>'asiento' as asiento
from reservar_lugares('Ana López', 'ana@gmail.com', '5511111111') as r;

select '=== C2. CREATE: 3 lugares elegidos en el plano (como en el cine) ===' as paso;
select b->>'numero' as boleto, b->>'asiento' as asiento, b->>'codigo_qr' as qr
from reservar_lugares('Grupo Ruiz', 'ruiz@gmail.com', '5522222222', 3, array['M06-A01', 'M06-A02', 'M06-A03']) as r,
     json_array_elements(r->'boletos') as b;

select '=== C3. CREATE: persona en silla de ruedas + 1 acompañante (automático) ===' as paso;
select r->>'discapacidad' as discapacidad, b->>'asiento' as asiento, b->>'accesible' as accesible
from reservar_lugares('Lucía Mendoza', 'lucia@gmail.com', '5533333333', 2, '{}', 'silla_ruedas', 'Necesito rampa') as r,
     json_array_elements(r->'boletos') as b;

select '=== R1. READ: asientos ocupados (sin datos personales) ===' as paso;
select asientos_ocupados();

select '=== R2. READ directo a las tablas con la clave pública (debe fallar) ===' as paso;
select nombre, correo from asistentes;
select codigo_qr from boletos;

select '=== X1. RESTRICCIÓN: lugar accesible sin indicar discapacidad (debe fallar) ===' as paso;
select reservar_lugares('Otra Persona', 'otra@gmail.com', '5544444444', 1, array['M02-A01']);
select '=== X2. RESTRICCIÓN: más de un lugar accesible por registro (debe fallar) ===' as paso;
select reservar_lugares('Otra Persona', 'otra@gmail.com', '5544444444', 2, array['M02-A01', 'M02-A02'], 'visual');
select '=== X3. RESTRICCIÓN: discapacidad «otra» sin describir (debe fallar) ===' as paso;
select reservar_lugares('Otra Persona', 'otra@gmail.com', '5544444444', 1, '{}', 'otra', '');
select '=== X4. RESTRICCIÓN: más de 5 lugares (debe fallar) ===' as paso;
select reservar_lugares('Otra Persona', 'otra@gmail.com', '5544444444', 6);
select '=== X5. RESTRICCIÓN: asiento ocupado (debe fallar) ===' as paso;
select reservar_lugares('Otra Persona', 'otra@gmail.com', '5544444444', 2, array['M06-A04', 'M06-A01']);
select '=== X6. RESTRICCIÓN: correo duplicado (debe fallar) ===' as paso;
select reservar_lugares('Otra Persona', 'ANA@gmail.com', '5544444444');
select '=== X7. RESTRICCIÓN: teléfono duplicado (debe fallar) ===' as paso;
select reservar_lugares('Otra Persona', 'otra@gmail.com', '5511111111');
select '=== X8. RESTRICCIÓN: correo que no es Gmail y datos inválidos (debe fallar) ===' as paso;
select reservar_lugares('A1', 'otra@hotmail.com', '123');

select '=== A1. Panel: clave incorrecta (debe fallar) ===' as paso;
select admin_iniciar_sesion('admin', 'equivocada');
select '=== A2. Panel: sin sesión (debe fallar) ===' as paso;
select admin_listar('token-falso');

select '=== A3. Panel: inicio de sesión correcto ===' as paso;
insert into prueba select 'token', admin_iniciar_sesion('admin', 'Conferencia2026!') ->> 'token';
select length(valor) as largo_token from prueba where clave = 'token';

select '=== R3. READ (panel): registros con sus lugares ===' as paso;
select x->>'id' as id, x->>'folio' as folio, x->>'nombre' as nombre, x->>'discapacidad' as discapacidad,
       (select string_agg(b->>'asiento', ', ') from json_array_elements(x->'boletos') b) as lugares
from prueba t, json_array_elements(admin_listar(t.valor)) as x where t.clave = 'token';

select '=== U1. UPDATE (panel): mover el boleto 3 del Grupo Ruiz a M02-A05 y marcar WhatsApp ===' as paso;
select x->>'nombre' as nombre, x->>'confirmado_whatsapp' as whatsapp,
       (select string_agg(b->>'asiento', ', ' order by (b->>'numero')::int) from json_array_elements(x->'boletos') b) as lugares
from prueba t, admin_actualizar(t.valor, 2, 'Grupo Ruiz', 'ruiz@gmail.com', '5522222222',
                                array['M06-A01', 'M06-A02', 'M02-A05'], null, null, true) as x
where t.clave = 'token';

select '=== U2. UPDATE (panel): mover a un asiento ocupado (debe fallar) ===' as paso;
select admin_actualizar(valor, 2, 'Grupo Ruiz', 'ruiz@gmail.com', '5522222222',
                        array['M06-A01', 'M06-A02', 'M01-A03'], null, null, true) from prueba where clave = 'token';
select '=== U3. UPDATE (panel): quitar la discapacidad conservando el lugar accesible (debe fallar) ===' as paso;
select admin_actualizar(valor, 3, 'Lucía Mendoza', 'lucia@gmail.com', '5533333333',
                        array['M01-A01', 'M01-A10'], null, null, false) from prueba where clave = 'token';

select '=== Q1. QR único por boleto: validar en la entrada ===' as paso;
insert into prueba select 'qr', admin_listar(valor, 'ruiz') -> 0 -> 'boletos' -> 1 ->> 'codigo_qr' from prueba where clave = 'token';
select admin_validar_qr(t.valor, q.valor) ->> 'resultado' as primera_lectura
from prueba t, prueba q where t.clave = 'token' and q.clave = 'qr';
select admin_validar_qr(t.valor, q.valor) ->> 'resultado' as segunda_lectura
from prueba t, prueba q where t.clave = 'token' and q.clave = 'qr';
select admin_validar_qr(valor, 'CMLOL-FALSO') ->> 'resultado' as qr_inventado from prueba where clave = 'token';

select '=== R4. READ (panel): resumen ===' as paso;
select admin_resumen(valor) from prueba where clave = 'token';

select '=== R5. READ (panel): bitácora de accesos ===' as paso;
select x->>'resultado' as resultado, x->>'nombre' as nombre, x->>'numero' as boleto, x->>'total' as de
from prueba t, json_array_elements(admin_accesos(t.valor)) as x where t.clave = 'token';

select '=== D1. DELETE (asistente): cancelar con folio y correo equivocado (debe fallar) ===' as paso;
insert into prueba select 'folio', admin_listar(valor, 'ana') -> 0 ->> 'folio' from prueba where clave = 'token';
select cancelar_registro(valor, 'intruso@gmail.com') from prueba where clave = 'folio';

select '=== D2. DELETE (panel): eliminar al Grupo Ruiz (libera sus 3 lugares) ===' as paso;
select admin_eliminar(valor, 2) as eliminado from prueba where clave = 'token';
select admin_resumen(valor) ->> 'ocupados' as ocupados_despues from prueba where clave = 'token';

select '=== A4. Cerrar sesión y volver a usar el token (debe fallar) ===' as paso;
select admin_cerrar_sesion(valor) from prueba where clave = 'token';
select admin_resumen(valor) from prueba where clave = 'token';
reset role;
