"""
pruebas_e2e.py — Plan de pruebas automatizado (Etapa 5)
=======================================================

Cubre las 9 actividades de la etapa 5: registros de prueba, almacenamiento,
duplicados, asignación de asientos, QR único, lectura y validación del QR
(con cámara simulada), WhatsApp, navegación en computadora y celular, e
interrupciones. Toma capturas de evidencia y guarda pruebas/resultados.json.

Requisitos:
    pip install playwright opencv-python psycopg2-binary
    python -m playwright install chromium
    (ffmpeg en el sistema para la prueba de cámara)

Uso:
    python pruebas/pruebas_e2e.py                    # modo demo
    python pruebas/pruebas_e2e.py --pg "host=... dbname=..."
        # además prueba contra las funciones SQL reales de supabase/schema.sql
        # en un PostgreSQL de PRUEBA (se borran sus tablas). La API REST de
        # Supabase se simula interceptando las peticiones de la página.
"""
import argparse, concurrent.futures, functools, http.server, json, pathlib, re
import socketserver, subprocess, tempfile, threading, time

from playwright.sync_api import sync_playwright

RAIZ = pathlib.Path(__file__).resolve().parent.parent
EVID = RAIZ / "pruebas" / "evidencias"
EVID.mkdir(parents=True, exist_ok=True)
URL_SUPA = "https://prueba.supabase.co"
ADMIN = ("admin", "Conferencia2026!")
MOVIL = dict(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, device_scale_factor=2)
PC = dict(viewport={"width": 1366, "height": 820}, device_scale_factor=1)
resultados, consola = [], []


# ---------------------------------------------------------------- utilidades
class Silencioso(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


class Servidor(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


def iniciar_servidor():
    srv = Servidor(("127.0.0.1", 0), functools.partial(Silencioso, directory=str(RAIZ)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://localhost:{srv.server_address[1]}/"


def registrar(id_, actividad, nombre, esperado, obtenido, ok, evidencia=None):
    resultados.append(dict(id=id_, actividad=actividad, nombre=nombre, esperado=esperado,
                           obtenido=obtenido, ok=bool(ok), evidencia=[e for e in (evidencia or []) if e]))
    print(f"[{'OK ' if ok else 'FALLA'}] {id_} {nombre}: {obtenido}")


def caso(id_, actividad, nombre, esperado):
    def deco(fn):
        def correr(*a, **k):
            try:
                fn(*a, **k)
            except Exception as e:  # noqa: BLE001
                registrar(id_, actividad, nombre, esperado, f"Error en la prueba: {str(e)[:300]}", False)
        return correr
    return deco


def abrir(ctx, url):
    pg = ctx.new_page()
    pg.on("console", lambda m: consola.append(f"{time.strftime('%H:%M:%S')} {m.type.upper():5} {m.text}"))
    pg.on("pageerror", lambda e: consola.append(f"{time.strftime('%H:%M:%S')} PAGEERROR {e}"))
    pg.goto(url)
    pg.wait_for_load_state("load")
    return pg


def ir(pg, vista):
    pg.evaluate("v => { location.hash = v; }", vista)
    pg.wait_for_selector(f"[data-vista='{vista}']:not([hidden])")
    if vista == "registro":
        pg.wait_for_selector("#sala-cargando", state="hidden")


def foto(pg, nombre, selector=None, completa=False):
    pg.wait_for_timeout(450)
    ruta = EVID / f"{nombre}.png"
    if selector:
        pg.locator(selector).screenshot(path=str(ruta))
    else:
        pg.screenshot(path=str(ruta), full_page=completa)
    return ruta.name


def centrar(pg, sel):
    pg.eval_on_selector(sel, "e => e.scrollIntoView({block: 'center', behavior: 'instant'})")


def llenar(pg, nombre, correo, tel, acepto=True):
    pg.fill("#nombre", nombre); pg.fill("#correo", correo); pg.fill("#telefono", tel)
    if acepto:
        pg.check("#acepto")


def registrar_ui(pg, nombre, correo, tel, asiento=None):
    ir(pg, "registro")
    llenar(pg, nombre, correo, tel)
    if asiento:
        pg.check("input[name=modo][value=manual]")
        pg.click(f"#asiento-{asiento}")
    pg.click("#btn-reservar")
    pg.wait_for_selector("[data-vista='boleto']:not([hidden])")
    pg.wait_for_selector("#qr-acceso svg")
    return pg.evaluate("JSON.parse(localStorage.getItem('cm:mi-registro'))")


def entrar_admin(pg, base):
    pg.goto(base + "admin.html")
    pg.wait_for_selector("[data-vista='login']:not([hidden])")
    pg.fill("#usuario", ADMIN[0]); pg.fill("#clave", ADMIN[1]); pg.click("#btn-entrar")
    pg.wait_for_selector("[data-vista='asistentes']:not([hidden])")
    pg.wait_for_function("document.querySelector('#tabla-cuerpo').children.length > 0")


def decodificar(png):
    import cv2
    texto, _, _ = cv2.QRCodeDetector().detectAndDecode(cv2.imread(str(EVID / png)))
    return texto


def sembrar(pg, n):
    regs = []
    for i in range(n):
        m, l = divmod(i, 10)
        regs.append(dict(id=i + 1, folio=f"LOL-{i:08X}", codigo_qr=f"CMLOL-{i:024X}", nombre="Persona Prueba",
                         correo=f"p{i}@correo.com", telefono=f"55{i:08d}", asiento=f"M{m + 1:02d}-A{l + 1:02d}",
                         modo="auto", confirmado_whatsapp=False, asistio_en=None, creado_en="2026-11-18T10:00:00Z"))
    pg.evaluate("l => { localStorage.setItem('cm:registros', JSON.stringify(l)); localStorage.setItem('cm:secuencia', JSON.stringify(l.length)); }", regs)
    pg.reload(); pg.wait_for_load_state("load")


def sin_desborde(pg):
    return pg.evaluate("document.documentElement.scrollWidth - window.innerWidth") <= 0


# ============================================================ 1-2. Registro
def pruebas_registro(nav, url):
    ctx = nav.new_context(**MOVIL)
    pg = abrir(ctx, url + "#inicio")

    @caso("P-01", "Registros de prueba", "Registro con asignación automática", "Guarda, asigna el primer lugar libre y muestra boleto con QR")
    def p01():
        foto(pg, "P01_inicio_movil")
        ir(pg, "registro"); llenar(pg, "Ana López", "ana@correo.com", "5511111111")
        ev0 = foto(pg, "P01_formulario")
        pg.click("#btn-reservar"); pg.wait_for_selector("[data-vista='boleto']:not([hidden])"); pg.wait_for_selector("#qr-acceso svg")
        r = pg.evaluate("JSON.parse(localStorage.getItem('cm:mi-registro'))")
        ev = foto(pg, "P01_boleto")
        ok = r["asiento"] == "M01-A01" and re.fullmatch(r"LOL-[0-9A-F]{8}", r["folio"]) and re.fullmatch(r"CMLOL-[0-9A-F]{24}", r["codigo_qr"]) \
            and pg.inner_text("#t-boleto").upper() == "MESA 1 · ASIENTO 1"
        registrar("P-01", "Registros de prueba", "Registro con asignación automática", "Guarda, asigna el primer lugar libre y muestra boleto con QR",
                  f"Boleto «Mesa 1 · Asiento 1», folio {r['folio']}, código {r['codigo_qr'][:12]}…", ok, [ev0, ev])
    p01()

    @caso("P-02", "Almacenamiento", "El registro queda guardado", "Al recargar, el registro sigue en la base y el contador baja")
    def p02():
        pg.reload(); pg.wait_for_load_state("load"); ir(pg, "inicio")
        pg.wait_for_function("document.querySelector('#libres-numero').textContent === '99'")
        guardados = pg.evaluate("JSON.parse(localStorage.getItem('cm:registros')).length")
        registrar("P-02", "Almacenamiento", "El registro queda guardado", "Al recargar, el registro sigue en la base y el contador baja",
                  f"Tras recargar: {guardados} registro en la base, contador en 99 libres", guardados == 1)
    p02()

    @caso("P-03", "Registros de prueba", "Validación de campos obligatorios", "No guarda y marca cada campo vacío")
    def p03():
        ir(pg, "registro"); pg.click("#btn-reservar")
        errs = [pg.inner_text(f"#error-{c}") for c in ("nombre", "correo", "telefono", "acepto")]
        centrar(pg, "#nombre"); ev = foto(pg, "P03_obligatorios")
        registrar("P-03", "Registros de prueba", "Validación de campos obligatorios", "No guarda y marca cada campo vacío",
                  "Mensajes: " + " | ".join(errs), all(errs), [ev])
    p03()

    @caso("P-04", "Registros de prueba", "Validación de formato", "Rechaza nombre con números, correo sin dominio y teléfono incompleto")
    def p04():
        ir(pg, "registro"); llenar(pg, "Ana123", "ana@correo", "55123"); pg.click("#btn-reservar")
        errs = [pg.inner_text(f"#error-{c}") for c in ("nombre", "correo", "telefono")]
        registrar("P-04", "Registros de prueba", "Validación de formato", "Rechaza nombre con números, correo sin dominio y teléfono incompleto",
                  "Mensajes: " + " | ".join(errs), all(errs))
    p04()

    @caso("P-05", "Registros de prueba", "WhatsApp escrito con lada 52", "Se guarda el número nacional de 10 dígitos")
    def p05():
        r = registrar_ui(pg, "Luis Gómez", "luis@correo.com", "+52 55 2222 2222")
        registrar("P-05", "Registros de prueba", "WhatsApp escrito con lada 52", "Se guarda el número nacional de 10 dígitos",
                  f"Escrito «+52 55 2222 2222» → guardado {r['telefono']}", r["telefono"] == "5522222222")
    p05()

    # ---------------------------------------------------- 3. Duplicados
    @caso("P-06", "Duplicados", "Correo repetido", "Rechaza el mismo correo aunque cambien mayúsculas o espacios")
    def p06():
        ir(pg, "registro"); llenar(pg, "Otra Persona", " ANA@Correo.com ", "5533333333"); pg.click("#btn-reservar")
        pg.wait_for_selector("#mensaje-form.mensaje-error")
        msg = pg.inner_text("#mensaje-form"); centrar(pg, "#mensaje-form"); ev = foto(pg, "P06_correo_duplicado")
        registrar("P-06", "Duplicados", "Correo repetido", "Rechaza el mismo correo aunque cambien mayúsculas o espacios",
                  f"«{msg}»", "ya tiene un lugar" in msg, [ev])
    p06()

    @caso("P-07", "Duplicados", "WhatsApp repetido", "Rechaza el mismo número")
    def p07():
        ir(pg, "registro"); llenar(pg, "Otra Persona", "otra@correo.com", "5511111111"); pg.click("#btn-reservar")
        pg.wait_for_selector("#mensaje-form.mensaje-error")
        msg = pg.inner_text("#mensaje-form")
        registrar("P-07", "Duplicados", "WhatsApp repetido", "Rechaza el mismo número", f"«{msg}»", "WhatsApp ya tiene" in msg)
    p07()

    # ---------------------------------------------------- 4. Asientos
    @caso("P-08", "Asignación de asientos", "Elegir asiento en el plano", "Guarda exactamente el asiento tocado")
    def p08():
        ir(pg, "registro"); llenar(pg, "Eva Ruiz", "eva@correo.com", "5544444444")
        centrar(pg, "#asiento-M05-A07"); pg.tap("#asiento-M05-A07")
        res = pg.inner_text("#resumen"); ev = foto(pg, "P08_eleccion")
        pg.click("#btn-reservar"); pg.wait_for_selector("[data-vista='boleto']:not([hidden])")
        r = pg.evaluate("JSON.parse(localStorage.getItem('cm:mi-registro'))")
        registrar("P-08", "Asignación de asientos", "Elegir asiento en el plano", "Guarda exactamente el asiento tocado",
                  f"«{res}» → boleto mesa {r['mesa']}, asiento {r['lugar']}", r["asiento"] == "M05-A07", [ev])
    p08()

    @caso("P-09", "Asignación de asientos", "Asiento ocupado bloqueado", "Los asientos de otras personas no se pueden elegir")
    def p09():
        ir(pg, "registro"); btn = pg.locator("#asiento-M01-A01")
        dis, lab = btn.is_disabled(), btn.get_attribute("aria-label")
        centrar(pg, "#asiento-M01-A01"); ev = foto(pg, "P09_ocupado")
        registrar("P-09", "Asignación de asientos", "Asiento ocupado bloqueado", "Los asientos de otras personas no se pueden elegir",
                  f"Mesa 1, asiento 1: deshabilitado={dis}, «{lab}»", dis and "ocupado" in lab, [ev])
    p09()

    @caso("P-10", "Asignación de asientos", "Asignación automática en orden", "Cada registro automático recibe el siguiente lugar libre")
    def p10():
        r = registrar_ui(pg, "Mia Soto", "mia@correo.com", "5555555555")
        registrar("P-10", "Asignación de asientos", "Asignación automática en orden", "Cada registro automático recibe el siguiente lugar libre",
                  f"Con M01-A01 y M01-A02 ocupados, el siguiente automático fue {r['asiento']}", r["asiento"] == "M01-A03")
    p10()

    # ---------------------------------------------------- 5. QR único
    @caso("P-11", "QR único", "Cada asistente tiene un QR distinto", "Folios y códigos QR no se repiten; el QR del boleto contiene el código")
    def p11():
        regs = pg.evaluate("JSON.parse(localStorage.getItem('cm:registros'))")
        codigos = [r["codigo_qr"] for r in regs]; folios = [r["folio"] for r in regs]
        png = foto(pg, "P11_qr_boleto", "#qr-acceso")
        leido = decodificar(png)
        mio = pg.evaluate("JSON.parse(localStorage.getItem('cm:mi-registro'))")
        ok = len(set(codigos)) == len(codigos) and len(set(folios)) == len(folios) and leido == mio["codigo_qr"]
        registrar("P-11", "QR único", "Cada asistente tiene un QR distinto", "Folios y códigos QR no se repiten; el QR del boleto contiene el código",
                  f"{len(codigos)} registros, {len(set(codigos))} códigos distintos; OpenCV leyó del boleto «{leido}»", ok, [png])
    p11()

    # ---------------------------------------------------- 7. WhatsApp
    @caso("P-12", "WhatsApp", "Mensaje de confirmación", "El botón abre wa.me con nombre, folio, lugar y código; el QR de WhatsApp lleva al mismo enlace")
    def p12():
        ir(pg, "boleto")
        href = pg.get_attribute("#b-whatsapp", "href")
        mio = pg.evaluate("JSON.parse(localStorage.getItem('cm:mi-registro'))")
        from urllib.parse import unquote
        texto = unquote(href.split("text=")[1])
        pg.click(".qr-whatsapp summary")
        png = foto(pg, "P12_qr_whatsapp", "#qr-whatsapp")
        leido = decodificar(png)
        ok = href.startswith("https://wa.me/525500000000?text=") and all(x in texto for x in (mio["folio"], mio["codigo_qr"], "mesa 1, asiento 3", "Mia Soto")) and leido == href
        registrar("P-12", "WhatsApp", "Mensaje de confirmación", "El botón abre wa.me con nombre, folio, lugar y código; el QR de WhatsApp lleva al mismo enlace",
                  f"Mensaje: «{texto.splitlines()[0]} … {texto.splitlines()[3]}»; QR leído = enlace: {leido == href}", ok, [png])
    p12()

    @caso("P-13", "Registros de prueba", "Recuperar boleto en «Mi lugar»", "Con folio y correo se vuelve a mostrar el boleto")
    def p13():
        regs = pg.evaluate("JSON.parse(localStorage.getItem('cm:registros'))")
        ana = regs[0]
        ir(pg, "mi-lugar"); pg.fill("#folio", ana["folio"].lower()); pg.fill("#correo-consulta", "ana@correo.com")
        ev0 = foto(pg, "P13_mi_lugar")
        pg.click("#btn-consultar"); pg.wait_for_selector("[data-vista='boleto']:not([hidden])")
        nombre = pg.inner_text("#b-nombre")
        registrar("P-13", "Registros de prueba", "Recuperar boleto en «Mi lugar»", "Con folio y correo se vuelve a mostrar el boleto",
                  f"Folio en minúsculas → boleto de «{nombre}»", nombre == "Ana López", [ev0])
    p13()

    @caso("P-14", "Registros de prueba", "Liberar lugar con correo equivocado", "No se cancela si el correo no corresponde al folio")
    def p14():
        regs = pg.evaluate("JSON.parse(localStorage.getItem('cm:registros'))")
        ir(pg, "mi-lugar"); pg.fill("#folio", regs[0]["folio"]); pg.fill("#correo-consulta", "intruso@correo.com")
        pg.click("#btn-cancelar"); pg.click("#confirmar-si"); pg.wait_for_selector("#mensaje-consulta.mensaje-error")
        n = pg.evaluate("JSON.parse(localStorage.getItem('cm:registros')).length")
        registrar("P-14", "Registros de prueba", "Liberar lugar con correo equivocado", "No se cancela si el correo no corresponde al folio",
                  f"«{pg.inner_text('#mensaje-consulta')}»; registros siguen en {n}", n == 4)
    p14()

    @caso("P-15", "Asignación de asientos", "Cupo lleno", "Con 100 registros no permite registrar más")
    def p15():
        c2 = nav.new_context(**MOVIL); q = abrir(c2, url + "#registro"); sembrar(q, 100); ir(q, "registro")
        dis = q.locator("#btn-reservar").is_disabled(); msg = q.inner_text("#mensaje-form")
        err = q.evaluate("() => Datos.reservar({nombre:'Ultima Persona', correo:'u@correo.com', telefono:'5599999999'}).then(()=>'ok', e => e.codigo)")
        centrar(q, "#btn-reservar"); ev = foto(q, "P15_cupo_lleno")
        registrar("P-15", "Asignación de asientos", "Cupo lleno", "Con 100 registros no permite registrar más",
                  f"Botón desactivado={dis}; «{msg}»; intento forzado → {err}", dis and err == "CUPO_LLENO", [ev])
        c2.close()
    p15()
    return ctx, pg


# ============================================================ Panel / CRUD
def pruebas_panel(nav, url, ctx):
    pg = abrir(ctx, url + "admin.html")

    @caso("A-01", "Panel administrativo", "Acceso con contraseña incorrecta", "No entra y muestra un mensaje")
    def a01():
        pg.wait_for_selector("[data-vista='login']:not([hidden])")
        pg.fill("#usuario", "admin"); pg.fill("#clave", "equivocada"); pg.click("#btn-entrar")
        pg.wait_for_selector("#mensaje-login.mensaje-error"); ev = foto(pg, "A01_login_error")
        registrar("A-01", "Panel administrativo", "Acceso con contraseña incorrecta", "No entra y muestra un mensaje",
                  f"«{pg.inner_text('#mensaje-login')}»", pg.is_visible("[data-vista='login']"), [ev])
    a01()

    @caso("A-02", "Panel administrativo", "Consultar asistentes (Read)", "Con usuario y contraseña correctos muestra estadísticas y la tabla")
    def a02():
        pg.fill("#clave", ADMIN[1]); pg.click("#btn-entrar")
        pg.wait_for_function("document.querySelectorAll('#tabla-cuerpo tr[data-id]').length === 4")
        reg = pg.inner_text("#e-registrados"); ev = foto(pg, "A02_panel")
        registrar("A-02", "Panel administrativo", "Consultar asistentes (Read)", "Con usuario y contraseña correctos muestra estadísticas y la tabla",
                  f"4 filas en la tabla; registrados = {reg}", reg == "4", [ev])
    a02()

    @caso("A-03", "Panel administrativo", "Buscar", "Filtra por nombre, correo, folio o teléfono")
    def a03():
        pg.fill("#buscar", "luis"); pg.wait_for_function("document.querySelectorAll('#tabla-cuerpo tr[data-id]').length === 1")
        n = pg.locator("#tabla-cuerpo tr[data-id]").count(); pg.fill("#buscar", "")
        pg.wait_for_function("document.querySelectorAll('#tabla-cuerpo tr[data-id]').length === 4")
        registrar("A-03", "Panel administrativo", "Buscar", "Filtra por nombre, correo, folio o teléfono", f"«luis» → {n} resultado", n == 1)
    a03()

    @caso("A-04", "Panel administrativo", "Alta manual (Create)", "El organizador registra a alguien y se le asigna lugar y QR")
    def a04():
        pg.click("#btn-nuevo"); pg.wait_for_selector("#dlg-editar[open]")
        pg.fill("#ed-nombre", "Invitado Especial"); pg.fill("#ed-correo", "invitado@correo.com"); pg.fill("#ed-telefono", "5566666666")
        pg.select_option("#ed-asiento", "M10-A01"); ev = foto(pg, "A04_alta")
        pg.click("#ed-guardar"); pg.wait_for_selector("#mensaje-tabla.mensaje-ok")
        msg = pg.inner_text("#mensaje-tabla")
        registrar("A-04", "Panel administrativo", "Alta manual (Create)", "El organizador registra a alguien y se le asigna lugar y QR",
                  f"«{msg}»", "mesa 10, asiento 1" in msg, [ev])
    a04()

    @caso("A-05", "Panel administrativo", "Modificar y reasignar asiento (Update)", "Cambia datos, mueve de asiento y marca la confirmación de WhatsApp")
    def a05():
        fila = pg.locator("#tabla-cuerpo tr", has_text="Luis Gómez")
        fila.locator("button[data-accion=editar]").click(); pg.wait_for_selector("#dlg-editar[open]")
        opciones = pg.eval_on_selector_all("#ed-asiento option", "o => o.map(x => x.value)")
        pg.fill("#ed-nombre", "Luis Gómez Ruiz"); pg.select_option("#ed-asiento", "M02-A03"); pg.check("#ed-confirmado")
        ev = foto(pg, "A05_editar")
        pg.click("#ed-guardar"); pg.wait_for_selector("#mensaje-tabla.mensaje-ok")
        r = pg.evaluate("JSON.parse(localStorage.getItem('cm:registros')).find(x => x.correo === 'luis@correo.com')")
        conf = pg.inner_text("#e-confirmados")
        ok = r["nombre"] == "Luis Gómez Ruiz" and r["asiento"] == "M02-A03" and r["confirmado_whatsapp"] and "M01-A01" not in opciones and conf == "1"
        registrar("A-05", "Panel administrativo", "Modificar y reasignar asiento (Update)", "Cambia datos, mueve de asiento y marca la confirmación de WhatsApp",
                  f"Guardado: «{r['nombre']}», {r['asiento']}, WhatsApp confirmado; el selector no ofrece asientos ocupados (M01-A01 ausente); contador WhatsApp = {conf}", ok, [ev])
    a05()

    @caso("A-06", "Panel administrativo", "Reasignar a un asiento ocupado", "La base de datos lo rechaza aunque se fuerce desde código")
    def a06():
        err = pg.evaluate("""() => Datos.admin.listar('').then(l => { const e = l.find(x => x.nombre === 'Eva Ruiz');
             return Datos.admin.actualizar(e.id, {nombre: e.nombre, correo: e.correo, telefono: e.telefono, asiento: 'M01-A01'}); })
             .then(() => 'se guardó', e => e.codigo)""")
        registrar("A-06", "Panel administrativo", "Reasignar a un asiento ocupado", "La base de datos lo rechaza aunque se fuerce desde código",
                  f"Mover a Eva a M01-A01 (de Ana) → {err}", err == "ASIENTO_OCUPADO")
    a06()

    @caso("A-07", "Panel administrativo", "Eliminar (Delete)", "Pide confirmación, borra el registro y libera el asiento")
    def a07():
        fila = pg.locator("#tabla-cuerpo tr", has_text="Invitado Especial")
        fila.locator("button[data-accion=eliminar]").click(); pg.wait_for_selector("#dlg-eliminar[open]")
        ev = foto(pg, "A07_eliminar")
        pg.click("#el-si"); pg.wait_for_function("document.querySelectorAll('#tabla-cuerpo tr[data-id]').length === 4")
        existe = pg.evaluate("JSON.parse(localStorage.getItem('cm:registros')).some(x => x.asiento === 'M10-A01')")
        registrar("A-07", "Panel administrativo", "Eliminar (Delete)", "Pide confirmación, borra el registro y libera el asiento",
                  f"Tabla con 4 filas; M10-A01 ocupado: {existe}", not existe, [ev])
    a07()

    @caso("A-08", "Panel administrativo", "Exportar a CSV", "Descarga un archivo con todos los asistentes")
    def a08():
        with pg.expect_download() as d:
            pg.click("#btn-csv")
        ruta = d.value.path(); txt = pathlib.Path(ruta).read_text(encoding="utf-8-sig")
        lineas = txt.strip().splitlines()
        registrar("A-08", "Panel administrativo", "Exportar a CSV", "Descarga un archivo con todos los asistentes",
                  f"{d.value.suggested_filename}: encabezado + {len(lineas) - 1} filas", len(lineas) == 5 and "Folio" in lineas[0])
    a08()

    # ------------------------------------------------ 6. Lectura del QR
    @caso("P-16", "Lectura y validación de QR", "Validar QR escrito a mano", "Primera vez «válido», segunda «ya ingresó», inventado «no válido»")
    def p16():
        ana = pg.evaluate("JSON.parse(localStorage.getItem('cm:registros'))[0]")
        pg.evaluate("location.hash = 'acceso'"); pg.wait_for_selector("[data-vista='acceso']:not([hidden])")
        estados = []
        for cod in (ana["codigo_qr"].lower(), ana["codigo_qr"], "CMLOL-INVENTADO"):
            pg.fill("#codigo-manual", cod); pg.click("#form-manual button")
            pg.wait_for_function("c => document.querySelector('#resultado').dataset.resultado && document.querySelectorAll('#lecturas li').length >= c", arg=len(estados) + 1)
            estados.append(pg.get_attribute("#resultado", "data-resultado"))
            if len(estados) == 2:
                ev = foto(pg, "P16_ya_ingreso")
        ev2 = foto(pg, "P16_no_valido")
        registrar("P-16", "Lectura y validación de QR", "Validar QR escrito a mano", "Primera vez «válido», segunda «ya ingresó», inventado «no válido»",
                  " → ".join(estados), estados == ["VALIDO", "YA_INGRESO", "NO_VALIDO"], [ev, ev2])
    p16()

    @caso("P-17", "Lectura y validación de QR", "Validar QR desde una foto", "Lee el QR de una imagen del boleto y lo valida")
    def p17():
        pg.set_input_files("#archivo-qr", str(EVID / "P11_qr_boleto.png"))
        pg.wait_for_function("document.querySelectorAll('#lecturas li').length >= 4")
        est = pg.get_attribute("#resultado", "data-resultado"); det = pg.inner_text("#resultado-detalle")
        ev = foto(pg, "P17_foto_qr")
        registrar("P-17", "Lectura y validación de QR", "Validar QR desde una foto", "Lee el QR de una imagen del boleto y lo valida",
                  f"{est}: «{det}»", est == "VALIDO" and "Mia Soto" in det, [ev])
    p17()
    return pg


def prueba_camara(pw, url, ctx_origen):
    """P-18: cámara simulada que muestra el QR de un boleto (video .y4m creado con ffmpeg)."""
    @caso("P-18", "Lectura y validación de QR", "Leer el QR con la cámara", "La cámara detecta el QR del boleto y registra el acceso")
    def p18():
        estado = ctx_origen.storage_state()
        video = pathlib.Path(tempfile.gettempdir()) / "qr_camara.y4m"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-loop", "1", "-i", str(EVID / "P11_qr_boleto.png"), "-t", "4",
                        "-vf", "scale=360:-1,pad=640:480:(ow-iw)/2:(oh-ih)/2:color=0x0a1428,format=yuv420p", "-r", "10", str(video)], check=True)
        nav2 = pw.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
                                        f"--use-file-for-fake-video-capture={video}"])
        try:
            c = nav2.new_context(**PC, storage_state=estado, permissions=["camera"])
            pg = abrir(c, url + "admin.html")
            pg.fill("#usuario", ADMIN[0]); pg.fill("#clave", ADMIN[1]); pg.click("#btn-entrar")
            pg.wait_for_selector("[data-vista='asistentes']:not([hidden])")
            pg.evaluate("location.hash = 'acceso'"); pg.wait_for_selector("[data-vista='acceso']:not([hidden])")
            pg.click("#btn-camara")
            pg.wait_for_function("document.querySelector('#resultado').dataset.resultado", timeout=15000)
            est = pg.get_attribute("#resultado", "data-resultado"); det = pg.inner_text("#resultado-detalle")
            ev = foto(pg, "P18_camara")
            pg.click("#btn-camara")
        finally:
            nav2.close()
        registrar("P-18", "Lectura y validación de QR", "Leer el QR con la cámara", "La cámara detecta el QR del boleto y registra el acceso",
                  f"Resultado {est}: «{det}»", est in ("VALIDO", "YA_INGRESO") and "Leído con cámara" in det, [ev])
    p18()


# ============================================================ 8. Navegación
def pruebas_navegacion(nav, url):
    for disp, conf in (("computadora", PC), ("celular", MOVIL)):
        @caso(f"N-{disp[:2].upper()}", "Navegación", f"Navegación en {disp}", "Todas las vistas abren desde el menú, sin desbordes y con atrás/adelante")
        def n():
            ctx = nav.new_context(**conf)
            pg = abrir(ctx, url)
            problemas, evs = [], []
            for v in ("inicio", "temas", "registro", "mi-lugar"):
                pg.click(f".pestanas a[href='#{v}']"); pg.wait_for_selector(f"[data-vista='{v}']:not([hidden])")
                if not sin_desborde(pg): problemas.append(v)
                if pg.get_attribute(f".pestanas a[href='#{v}']", "aria-current") != "page": problemas.append(v + " (menú)")
                evs.append(foto(pg, f"N_{disp}_{v}"))
            pg.go_back(); pg.wait_for_selector("[data-vista='registro']:not([hidden])")
            entrar_admin(pg, url)
            for v in ("asistentes", "acceso"):
                pg.evaluate("v => location.hash = v", v); pg.wait_for_selector(f"[data-vista='{v}']:not([hidden])")
                if not sin_desborde(pg): problemas.append("admin " + v)
                evs.append(foto(pg, f"N_{disp}_admin_{v}"))
            ctx.close()
            registrar(f"N-{disp[:2].upper()}", "Navegación", f"Navegación en {disp}", "Todas las vistas abren desde el menú, sin desbordes y con atrás/adelante",
                      "6 vistas revisadas; botón atrás regresó a Registro; " + ("sin problemas" if not problemas else "problemas: " + ", ".join(problemas)),
                      not problemas, evs)
        n()


# ============================================================ Interrupciones
def pruebas_interrupciones(nav, url):
    @caso("I-01", "Interrupciones", "Recargar a mitad del registro", "Lo escrito y el asiento elegido se conservan")
    def i01():
        ctx = nav.new_context(**MOVIL); pg = abrir(ctx, url + "#registro"); ir(pg, "registro")
        llenar(pg, "Recarga Prueba", "recarga@correo.com", "5577777777", acepto=False); pg.tap("#asiento-M02-A05")
        pg.reload(); pg.wait_for_load_state("load"); ir(pg, "registro")
        v = [pg.input_value(s) for s in ("#nombre", "#correo", "#telefono")]
        el = pg.eval_on_selector_all(".asiento.elegido", "e => e.map(x => x.dataset.asiento)")
        ctx.close()
        registrar("I-01", "Interrupciones", "Recargar a mitad del registro", "Lo escrito y el asiento elegido se conservan",
                  f"{v}, asiento {el}", v == ["Recarga Prueba", "recarga@correo.com", "5577777777"] and el == ["M02-A05"])
    i01()

    @caso("I-02", "Interrupciones", "Girar el teléfono con el boleto abierto", "El boleto sigue visible y sin errores")
    def i02():
        ctx = nav.new_context(**MOVIL); pg = abrir(ctx, url)
        registrar_ui(pg, "Giro Prueba", "giro@correo.com", "5588888888")
        pg.set_viewport_size({"width": 844, "height": 390}); pg.wait_for_timeout(400)
        vis = pg.is_visible("#qr-acceso svg"); ok_d = sin_desborde(pg); ev = foto(pg, "I02_giro")
        ctx.close()
        registrar("I-02", "Interrupciones", "Girar el teléfono con el boleto abierto", "El boleto sigue visible y sin errores",
                  f"QR visible={vis}; sin desborde horizontal={ok_d}", vis and ok_d, [ev])
    i02()

    @caso("I-03", "Interrupciones", "Perder la conexión", "Aparece el aviso y desaparece al volver la red")
    def i03():
        ctx = nav.new_context(**MOVIL); pg = abrir(ctx, url)
        ctx.set_offline(True); pg.wait_for_selector("#aviso-red", state="visible"); ev = foto(pg, "I03_sin_red")
        ctx.set_offline(False); pg.wait_for_selector("#aviso-red", state="hidden"); ctx.close()
        registrar("I-03", "Interrupciones", "Perder la conexión", "Aparece el aviso y desaparece al volver la red",
                  "Aviso «Sin conexión a Internet» visible y luego oculto", True, [ev])
    i03()

    @caso("I-04", "Interrupciones", "Sesión del panel vencida", "Si el token deja de servir, regresa al inicio de sesión")
    def i04():
        ctx = nav.new_context(**PC); pg = abrir(ctx, url)
        entrar_admin(pg, url)
        pg.evaluate("sessionStorage.removeItem('cm:token')")
        pg.fill("#buscar", "x")
        pg.wait_for_selector("[data-vista='login']:not([hidden])")
        msg = pg.inner_text("#mensaje-login"); ctx.close()
        registrar("I-04", "Interrupciones", "Sesión del panel vencida", "Si el token deja de servir, regresa al inicio de sesión",
                  f"Regresó al login con «{msg}»", "sesión terminó" in msg)
    i04()


# ============================================================ Base de datos real
def pruebas_bd(nav, url, dsn):
    import psycopg2
    conn = psycopg2.connect(dsn); conn.autocommit = True
    estado = {"caido": False}

    def reiniciar():
        with conn.cursor() as c:
            c.execute((RAIZ / "supabase" / "schema.sql").read_text())

    def postgrest(route):
        req = route.request
        cors = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, OPTIONS"}
        if req.method == "OPTIONS":
            return route.fulfill(status=204, headers=cors)
        if estado["caido"]:
            return route.fulfill(status=503, headers=cors, body="Service Unavailable")
        fn = req.url.rsplit("/", 1)[-1]; args = json.loads(req.post_data or "{}")
        if not req.headers.get("apikey"):
            return route.fulfill(status=401, headers=cors, json={"message": "No API key"})
        try:
            with conn.cursor() as c:
                c.execute("begin; set local role anon;")
                c.execute(f"select public.{fn}({', '.join(f'{k} := %s' for k in args)})", list(args.values()))
                v = c.fetchone()[0]; c.execute("commit;")
            return route.fulfill(status=200, headers=cors, body=json.dumps(v, default=str))
        except psycopg2.Error as e:
            with conn.cursor() as c:
                c.execute("rollback;")
            return route.fulfill(status=400, headers=cors, json={"code": e.pgcode, "message": e.diag.message_primary})

    cfg = (RAIZ / "js" / "config.js").read_text().replace("url: '',", f"url: '{URL_SUPA}',").replace("clavePublica: ''", "clavePublica: 'eyJprueba.clave'")

    def contexto(conf=MOVIL):
        c = nav.new_context(**conf)
        c.route("**/js/config.js", lambda r: r.fulfill(status=200, content_type="application/javascript", body=cfg))
        c.route(f"{URL_SUPA}/**", postgrest)
        return c

    def sql(q, *a):
        with conn.cursor() as c:
            c.execute(q, a)
            return c.fetchall() if c.description else None

    @caso("B-01", "Almacenamiento", "Registro guardado en PostgreSQL", "La página guarda en la tabla asistentes mediante la función RPC")
    def b01():
        reiniciar(); ctx = contexto(); pg = abrir(ctx, url)
        demo = pg.is_visible("#aviso-demo")
        r = registrar_ui(pg, "Base Real", "base@correo.com", "5510101010")
        filas = sql("select nombre, asiento_id, modo, length(codigo_qr) from asistentes")
        ctx.close()
        registrar("B-01", "Almacenamiento", "Registro guardado en PostgreSQL", "La página guarda en la tabla asistentes mediante la función RPC",
                  f"Fila: {filas[0]}; aviso de modo demo oculto: {not demo}", filas == [("Base Real", "M01-A01", "auto", 30)] and not demo)
    b01()

    @caso("B-02", "Panel administrativo", "Panel contra la base real", "Inicio de sesión con bcrypt, edición y validación de QR en PostgreSQL")
    def b02():
        ctx = contexto(PC); pg = abrir(ctx, url)
        entrar_admin(pg, url)
        tok = sql("select count(*) from sesiones_admin")[0][0]
        fila = pg.locator("#tabla-cuerpo tr", has_text="Base Real"); fila.locator("button[data-accion=editar]").click()
        pg.wait_for_selector("#dlg-editar[open]"); pg.check("#ed-confirmado"); pg.click("#ed-guardar"); pg.wait_for_selector("#mensaje-tabla.mensaje-ok")
        qr = sql("select codigo_qr from asistentes")[0][0]
        pg.evaluate("location.hash = 'acceso'"); pg.wait_for_selector("[data-vista='acceso']:not([hidden])")
        pg.fill("#codigo-manual", qr); pg.click("#form-manual button"); pg.wait_for_selector("#resultado.valido")
        db = sql("select confirmado_whatsapp, asistio_en is not null from asistentes")[0]
        acc = sql("select resultado from accesos")
        ctx.close()
        registrar("B-02", "Panel administrativo", "Panel contra la base real", "Inicio de sesión con bcrypt, edición y validación de QR en PostgreSQL",
                  f"Sesiones abiertas: {tok}; confirmado_whatsapp={db[0]}, asistio_en registrado={db[1]}; bitácora: {acc}", tok == 1 and db == (True, True) and acc == [("VALIDO",)])
    b02()

    @caso("B-03", "Asignación de asientos", "Otra persona gana el asiento elegido", "Avisa, quita la selección y actualiza el plano")
    def b03():
        ctx = contexto(); pg = abrir(ctx, url); ir(pg, "registro")
        llenar(pg, "Llega Tarde", "tarde@correo.com", "5520202020"); pg.check("input[name=modo][value=manual]"); pg.tap("#asiento-M03-A03")
        sql("select reservar_asiento('Llega Antes','antes@correo.com','5530303030','M03-A03')")
        pg.click("#btn-reservar"); pg.wait_for_selector("#mensaje-form.mensaje-error")
        msg = pg.inner_text("#mensaje-form"); pg.wait_for_function("document.querySelector('#asiento-M03-A03').disabled")
        sel = pg.locator(".asiento.elegido").count(); centrar(pg, "#asiento-M03-A03"); ev = foto(pg, "B03_asiento_ganado"); ctx.close()
        registrar("B-03", "Asignación de asientos", "Otra persona gana el asiento elegido", "Avisa, quita la selección y actualiza el plano",
                  f"«{msg}»; selección liberada: {sel == 0}", "acaba de ocuparse" in msg and sel == 0, [ev])
    b03()

    @caso("B-04", "Interrupciones", "Sin Internet / servidor caído al registrar", "Mensaje claro, datos conservados y reintento exitoso")
    def b04():
        ctx = contexto(); pg = abrir(ctx, url); ir(pg, "registro")
        llenar(pg, "Sin Red", "sinred@correo.com", "5540404040")
        ctx.set_offline(True); pg.click("#btn-reservar"); pg.wait_for_selector("#mensaje-form.mensaje-error"); m1 = pg.inner_text("#mensaje-form")
        ev = foto(pg, "B04_sin_red")
        ctx.set_offline(False); estado["caido"] = True; pg.click("#btn-reservar"); pg.wait_for_function("document.querySelector('#mensaje-form').textContent.includes('servidor')")
        m2 = pg.inner_text("#mensaje-form"); estado["caido"] = False
        pg.click("#btn-reservar"); pg.wait_for_selector("[data-vista='boleto']:not([hidden])"); ctx.close()
        registrar("B-04", "Interrupciones", "Sin Internet / servidor caído al registrar", "Mensaje claro, datos conservados y reintento exitoso",
                  f"Sin red: «{m1}» | Error 503: «{m2}» | al reintentar se registró", "No hay conexión" in m1 and "servidor no respondió" in m2, [ev])
    b04()

    @caso("B-05", "Duplicados", "Seguridad de la base", "Con la clave pública no se pueden leer tablas ni usar el panel sin sesión")
    def b05():
        res = []
        for q in ("select correo from asistentes", "select clave_hash from administradores", "select admin_listar('falso')"):
            try:
                with conn.cursor() as c:
                    c.execute("begin; set local role anon;"); c.execute(q); res.append("PERMITIDO")
            except psycopg2.Error as e:
                res.append(e.diag.message_primary)
            finally:
                with conn.cursor() as c:
                    c.execute("rollback;")
        registrar("B-05", "Duplicados", "Seguridad de la base", "Con la clave pública no se pueden leer tablas ni usar el panel sin sesión",
                  " | ".join(res), "PERMITIDO" not in res)
    b05()

    @caso("B-06", "QR único", "100 registros simultáneos", "100 asientos distintos, 100 QR distintos y «cupo lleno» para el resto")
    def b06():
        rondas = []
        for _ in range(3):
            reiniciar()
            def una(i):
                c2 = psycopg2.connect(dsn); c2.autocommit = True
                try:
                    with c2.cursor() as c:
                        c.execute("begin; set local role anon;")
                        c.execute("select reservar_asiento(%s,%s,%s)", ("Persona Prueba", f"p{i}@correo.com", f"66{i:08d}"))
                        c.execute("commit;"); return "OK"
                except psycopg2.Error as e:
                    return e.diag.message_primary
                finally:
                    c2.close()
            with concurrent.futures.ThreadPoolExecutor(25) as ex:
                res = list(ex.map(una, range(110)))
            asi, qrs = sql("select count(distinct asiento_id), count(distinct codigo_qr) from asistentes")[0]
            rondas.append((res.count("OK"), asi, qrs, res.count("CUPO_LLENO")))
        registrar("B-06", "QR único", "100 registros simultáneos", "100 asientos distintos, 100 QR distintos y «cupo lleno» para el resto",
                  "3 rondas de 110 peticiones en paralelo (guardados, asientos distintos, QR distintos, cupo lleno): " + "; ".join(map(str, rondas)),
                  all(r == (100, 100, 100, 10) for r in rondas))
    b06()
    conn.close()


# ============================================================ Rendimiento
def rendimiento(nav, url):
    datos = {}
    for nombre, conf, lento, n in (("computadora", PC, False, 5), ("celular_3g", MOVIL, True, 3)):
        medidas = []
        for _ in range(n):
            ctx = nav.new_context(**conf); pg = ctx.new_page(); logs = []
            pg.on("console", lambda m: logs.append(m.text))
            if lento:
                cdp = ctx.new_cdp_session(pg); cdp.send("Network.enable")
                cdp.send("Network.emulateNetworkConditions", {"offline": False, "latency": 150, "downloadThroughput": 1.6 * 1024 * 1024 / 8, "uploadThroughput": 750 * 1024 / 8})
                cdp.send("Emulation.setCPUThrottlingRate", {"rate": 4})
            pg.goto(url, wait_until="load"); pg.wait_for_function("document.querySelector('#libres-numero')")
            pg.wait_for_timeout(300)
            m = pg.evaluate("""() => { const n = performance.getEntriesByType('navigation')[0];
                const f = performance.getEntriesByName('first-contentful-paint')[0];
                const r = performance.getEntriesByType('resource');
                return { fcp: f ? f.startTime : 0, carga: n.loadEventEnd, peticiones: r.length + 1,
                  bytes: r.reduce((s, x) => s + (x.transferSize || x.encodedBodySize || 0), n.transferSize || n.encodedBodySize || 0),
                  raster: r.filter(x => /\\.(png|jpe?g|gif|webp)/i.test(x.name)).length }; }""")
            registrar_ui(pg, "Medir Tiempo", "medir@correo.com", "5512121212")
            m["lista"] = next((float(re.search(r"(\d+) ms", x).group(1)) for x in logs if "Página lista" in x), 0)
            m["guardar"] = next((float(re.search(r"(\d+) ms", x).group(1)) for x in logs if "Guardar registro" in x), 0)
            consola.extend(f"PERF  {x}" for x in logs if x.startswith("[Rendimiento]"))
            medidas.append(m); ctx.close()
        datos[nombre] = {k: round(sum(x[k] for x in medidas) / n, 1) for k in ("fcp", "lista", "carga", "guardar")}
        datos[nombre]["n"] = n
        datos["peticiones"], datos["bytes"], datos["raster"] = medidas[0]["peticiones"], medidas[0]["bytes"], medidas[0]["raster"]
    (RAIZ / "pruebas" / "rendimiento.json").write_text(json.dumps(datos, indent=2))
    print("Rendimiento:", datos)


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--pg"); a = ap.parse_args()
    srv, url = iniciar_servidor(); t0 = time.time()
    with sync_playwright() as p:
        nav = p.chromium.launch(); version = nav.version
        ctx, _ = pruebas_registro(nav, url)
        pruebas_panel(nav, url, ctx)
        prueba_camara(p, url, ctx)
        ctx.close()
        pruebas_navegacion(nav, url)
        pruebas_interrupciones(nav, url)
        if a.pg:
            pruebas_bd(nav, url, a.pg)
        rendimiento(nav, url)
        nav.close()
    srv.shutdown()
    (RAIZ / "pruebas" / "resultados.json").write_text(json.dumps(dict(fecha=time.strftime("%Y-%m-%d %H:%M"), chromium=version,
        duracion_s=round(time.time() - t0, 1), casos=resultados), indent=2, ensure_ascii=False))
    (RAIZ / "pruebas" / "consola.log").write_text("\n".join(consola), encoding="utf-8")
    print(f"\n{sum(r['ok'] for r in resultados)} de {len(resultados)} casos aprobados")


if __name__ == "__main__":
    main()
