/* ==========================================================================
   admin.js — Panel de organización
     · Inicio de sesión (token de sesión, contraseña con bcrypt en Supabase)
     · Asistentes: consultar, buscar, registrar, modificar, reasignar asiento,
       marcar confirmación de WhatsApp, eliminar y exportar a CSV
     · Control de acceso: leer QR con la cámara (jsQR), desde foto o a mano,
       validar y llevar bitácora de lecturas
   ========================================================================== */
(function () {
  'use strict';
  const CFG = window.CONFIG;
  const { Datos } = window;
  const A = Datos.admin;
  const { $, aplicarConfig, avisos, enrutador, mensaje } = window.Comun;
  const TOTAL = CFG.sala.mesas * CFG.sala.asientosPorMesa;
  let rutas;
  let lista = [];
  let editando = null;      // ficha en edición (null = alta nueva)
  let eliminando = null;

  const hora = (iso) => (iso ? new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }) : '');
  const celda = (texto, clase) => { const td = document.createElement('td'); td.textContent = texto; if (clase) td.className = clase; return td; };

  /** Si la sesión expiró, vuelve al inicio de sesión */
  async function seguro(fn, salida) {
    try { return await fn(); }
    catch (e) {
      if (e.codigo === 'SESION_INVALIDA') { await A.cerrar(); mostrarSesion(); rutas.ir('login'); mensaje($('#mensaje-login'), e.message, 'error'); return null; }
      if (salida) mensaje(salida, e.message, 'error');
      throw e;
    }
  }

  function mostrarSesion() {
    const activa = A.activa();
    $('#pestanas-admin').hidden = !activa;
    $('#sesion-admin').hidden = !activa;
    $('#nombre-admin').textContent = A.nombre();
  }

  /* ======================= Inicio de sesión ======================= */
  function prepararLogin() {
    $('#form-login').addEventListener('submit', async (e) => {
      e.preventDefault();
      const m = $('#mensaje-login');
      const btn = $('#btn-entrar');
      mensaje(m, '');
      btn.disabled = true;
      try {
        await A.iniciar($('#usuario').value, $('#clave').value);
        $('#clave').value = '';
        mostrarSesion();
        rutas.ir('asistentes');
      } catch (err) { mensaje(m, err.message, 'error'); }
      finally { btn.disabled = false; }
    });
    $('#btn-salir').addEventListener('click', async () => { detenerCamara(); await A.cerrar(); mostrarSesion(); rutas.ir('login'); });
  }

  /* ======================= Asistentes ======================= */
  async function cargar() {
    const m = $('#mensaje-tabla');
    const [res, filas] = await Promise.all([
      seguro(() => A.resumen(), m),
      seguro(() => A.listar($('#buscar').value), m)
    ]).catch(() => [null, null]);
    if (!res || !filas) return;
    lista = filas;
    $('#e-registrados').textContent = res.registrados;
    $('#e-cupo').textContent = `de ${res.cupo} lugares`;
    $('#e-libres').textContent = res.cupo - res.registrados;
    $('#e-asistieron').textContent = res.asistieron;
    $('#e-confirmados').textContent = res.confirmados;
    pintarTabla();
  }

  function pintarTabla() {
    const cuerpo = $('#tabla-cuerpo');
    cuerpo.textContent = '';
    if (!lista.length) {
      const tr = document.createElement('tr');
      const td = celda($('#buscar').value ? 'Sin resultados para esa búsqueda.' : 'Todavía no hay asistentes registrados.', 'vacio');
      td.colSpan = 9; tr.appendChild(td); cuerpo.appendChild(tr);
      return;
    }
    lista.forEach((r) => {
      const tr = document.createElement('tr');
      tr.dataset.id = r.id;
      tr.append(celda(r.mesa), celda(r.lugar), celda(r.folio, 'secundario'), celda(r.nombre), celda(r.correo, 'secundario'), celda(r.telefono, 'secundario'));
      const conf = document.createElement('td');
      conf.innerHTML = `<span class="insignia ${r.confirmado_whatsapp ? 'insignia-si">Sí' : 'insignia-no">No'}</span>`;
      const ing = document.createElement('td');
      ing.innerHTML = r.asistio_en ? `<span class="insignia insignia-si"></span>` : '<span class="insignia insignia-no">Pendiente</span>';
      if (r.asistio_en) ing.firstChild.textContent = hora(r.asistio_en);
      const acc = document.createElement('td');
      acc.innerHTML = '<div class="acciones-fila"><button type="button" class="boton boton-texto" data-accion="editar">Editar</button><button type="button" class="boton boton-texto" data-accion="eliminar">Eliminar</button></div>';
      tr.append(conf, ing, acc);
      cuerpo.appendChild(tr);
    });
  }

  async function opcionesAsiento(actual) {
    const ocupados = await Datos.ocupados();
    const sel = $('#ed-asiento');
    sel.textContent = '';
    if (!actual) sel.add(new Option('Automático (primer lugar libre)', ''));
    let grupo = null;
    Datos.todosLosAsientos().forEach((id) => {
      if (ocupados.has(id) && id !== actual) return;
      const p = Datos.partesAsiento(id);
      if (!grupo || grupo.dataset.mesa !== String(p.mesa)) {
        grupo = document.createElement('optgroup');
        grupo.label = `Mesa ${p.mesa}`;
        grupo.dataset.mesa = p.mesa;
        sel.appendChild(grupo);
      }
      grupo.appendChild(new Option(`Mesa ${p.mesa}, asiento ${p.lugar}${id === actual ? ' (actual)' : ''}`, id));
    });
    sel.value = actual || '';
  }

  async function abrirEditor(r) {
    editando = r || null;
    const f = $('#form-editar');
    f.reset();
    mensaje($('#mensaje-editar'), '');
    $('#t-editar').textContent = r ? 'Editar asistente' : 'Nuevo registro';
    $('#ed-confirmado-fila').hidden = !r;
    if (r) {
      f.elements.nombre.value = r.nombre;
      f.elements.correo.value = r.correo;
      f.elements.telefono.value = r.telefono;
      f.elements.confirmado.checked = Boolean(r.confirmado_whatsapp);
    }
    await opcionesAsiento(r ? r.asiento : null);
    $('#dlg-editar').showModal();
  }

  function prepararAsistentes() {
    let espera;
    $('#buscar').addEventListener('input', () => { clearTimeout(espera); espera = setTimeout(cargar, 250); });
    $('#btn-nuevo').addEventListener('click', () => abrirEditor(null));
    $('#btn-csv').addEventListener('click', exportarCSV);
    $('#tabla-cuerpo').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-accion]');
      if (!b) return;
      const r = lista.find((x) => String(x.id) === b.closest('tr').dataset.id);
      if (b.dataset.accion === 'editar') abrirEditor(r);
      else { eliminando = r; $('#eliminar-texto').textContent = `Se eliminará a ${r.nombre} (mesa ${r.mesa}, asiento ${r.lugar}) y su código QR dejará de servir.`; $('#dlg-eliminar').showModal(); }
    });
    $('#ed-cancelar').addEventListener('click', () => $('#dlg-editar').close());
    $('#form-editar').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const m = $('#mensaje-editar');
      const d = { nombre: f.elements.nombre.value, correo: f.elements.correo.value, telefono: f.elements.telefono.value,
        asiento: f.elements.asiento.value || null, confirmado_whatsapp: f.elements.confirmado.checked };
      const errs = Datos.validar(d);
      if (Object.keys(errs).length) { mensaje(m, Object.values(errs)[0], 'error'); return; }
      try {
        const r = await seguro(() => (editando ? A.actualizar(editando.id, d) : A.registrar(d)), m);
        if (!r) return;
        $('#dlg-editar').close();
        mensaje($('#mensaje-tabla'), editando ? `Se guardaron los cambios de ${r.nombre}.` : `${r.nombre} quedó registrado en la mesa ${r.mesa}, asiento ${r.lugar} (folio ${r.folio}).`, 'ok');
        cargar();
      } catch (err) { /* el mensaje ya se mostró */ }
    });
    $('#el-no').addEventListener('click', () => $('#dlg-eliminar').close());
    $('#el-si').addEventListener('click', async () => {
      $('#dlg-eliminar').close();
      try {
        const ok = await seguro(() => A.eliminar(eliminando.id), $('#mensaje-tabla'));
        if (ok) { mensaje($('#mensaje-tabla'), `Se eliminó el registro de ${eliminando.nombre}.`, 'ok'); cargar(); }
      } catch (err) { /* ya mostrado */ }
    });
  }

  function exportarCSV() {
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const filas = [['Mesa', 'Asiento', 'Folio', 'Nombre', 'Correo', 'WhatsApp', 'Confirmó WhatsApp', 'Ingreso', 'Registro']]
      .concat(lista.map((r) => [r.mesa, r.lugar, r.folio, r.nombre, r.correo, r.telefono, r.confirmado_whatsapp ? 'Sí' : 'No', r.asistio_en || '', r.creado_en]));
    const csv = '\ufeff' + filas.map((f) => f.map(q).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'asistentes-conferencia.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* ======================= Control de acceso ======================= */
  let flujo = null;
  let ultimo = { texto: '', t: 0 };
  let pausa = false;
  const lienzo = document.createElement('canvas');

  function leerQR(fuente, ancho, alto) {
    if (!window.jsQR) return null;
    const escala = Math.min(1, 800 / Math.max(ancho, alto));
    lienzo.width = Math.round(ancho * escala);
    lienzo.height = Math.round(alto * escala);
    const ctx = lienzo.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(fuente, 0, 0, lienzo.width, lienzo.height);
    const img = ctx.getImageData(0, 0, lienzo.width, lienzo.height);
    const r = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
    return r ? r.data : null;
  }

  async function activarCamara() {
    const video = $('#video');
    const texto = $('#camara-texto');
    if (flujo) { detenerCamara(); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      texto.textContent = 'Este navegador no permite usar la cámara. Sube una foto del QR o escribe el código.'; return;
    }
    try {
      flujo = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    } catch (e) {
      texto.textContent = 'No se pudo abrir la cámara. Revisa el permiso del navegador (la página debe abrirse con https).';
      return;
    }
    video.srcObject = flujo;
    await video.play();
    video.hidden = false; $('#camara-guia').hidden = false; texto.hidden = true;
    $('#btn-camara').textContent = 'Detener cámara';
    const ciclo = () => {
      if (!flujo) return;
      if (!pausa && video.readyState >= 2) {
        const leido = leerQR(video, video.videoWidth, video.videoHeight);
        if (leido) procesar(leido, 'cámara');
      }
      setTimeout(ciclo, 180);
    };
    ciclo();
  }
  function detenerCamara() {
    if (flujo) flujo.getTracks().forEach((t) => t.stop());
    flujo = null;
    const video = $('#video');
    if (video) { video.hidden = true; video.srcObject = null; }
    if ($('#camara-guia')) $('#camara-guia').hidden = true;
    if ($('#camara-texto')) { $('#camara-texto').hidden = false; $('#camara-texto').textContent = 'La cámara está apagada.'; }
    if ($('#btn-camara')) $('#btn-camara').textContent = 'Activar cámara';
  }

  async function procesar(codigo, origen) {
    const texto = String(codigo || '').trim();
    if (!texto) return;
    const ahora = Date.now();
    if (texto === ultimo.texto && ahora - ultimo.t < 4000) return;   // la cámara lee el mismo QR varias veces
    ultimo = { texto, t: ahora };
    pausa = true;
    try {
      const r = await seguro(() => A.validarQR(texto));
      if (r) mostrarResultado(r, origen);
      cargarLecturas();
    } catch (e) {
      mostrarResultado({ resultado: 'ERROR', mensaje: e.message });
    } finally { setTimeout(() => { pausa = false; }, 1500); }
  }

  function mostrarResultado(r, origen) {
    const caja = $('#resultado');
    const estados = { VALIDO: ['valido', 'Acceso válido'], YA_INGRESO: ['ya', 'Ya ingresó'], NO_VALIDO: ['no', 'Código no válido'], ERROR: ['no', 'Error'] };
    const [clase, titulo] = estados[r.resultado] || estados.ERROR;
    caja.className = 'resultado ' + clase;
    caja.dataset.resultado = r.resultado;
    $('#resultado-estado').textContent = titulo;
    const a = r.asistente;
    let detalle = r.mensaje || 'Este código no pertenece a ningún registro. Pide el folio y búscalo en Asistentes.';
    if (a && r.resultado === 'VALIDO') detalle = `${a.nombre}: mesa ${a.mesa}, asiento ${a.lugar}. Bienvenida(o).`;
    if (a && r.resultado === 'YA_INGRESO') detalle = `${a.nombre} ya entró a las ${hora(a.asistio_en)} (mesa ${a.mesa}, asiento ${a.lugar}).`;
    $('#resultado-detalle').textContent = detalle + (origen ? ` · Leído con ${origen}.` : '');
  }

  async function cargarLecturas() {
    const l = await seguro(() => A.accesos()).catch(() => null);
    if (!l) return;
    const ul = $('#lecturas');
    ul.textContent = '';
    if (!l.length) { const li = document.createElement('li'); li.textContent = 'Sin lecturas todavía.'; ul.appendChild(li); return; }
    const txt = { VALIDO: 'Válido', YA_INGRESO: 'Ya ingresó', NO_VALIDO: 'No válido' };
    l.forEach((x) => {
      const li = document.createElement('li');
      const t = document.createElement('span'); t.textContent = hora(x.fecha);
      const n = document.createElement('span'); n.textContent = x.nombre ? `${x.nombre} · M${x.mesa}-A${x.lugar}` : x.codigo_leido;
      const r = document.createElement('span'); r.className = x.resultado; r.textContent = txt[x.resultado];
      li.append(t, n, r); ul.appendChild(li);
    });
  }

  function prepararAcceso() {
    $('#btn-camara').addEventListener('click', activarCamara);
    $('#form-manual').addEventListener('submit', (e) => {
      e.preventDefault();
      ultimo = { texto: '', t: 0 };
      procesar($('#codigo-manual').value, 'captura manual');
      $('#codigo-manual').value = '';
    });
    $('#archivo-qr').addEventListener('change', (e) => {
      const archivo = e.target.files[0];
      if (!archivo) return;
      const img = new Image();
      img.onload = () => {
        const leido = leerQR(img, img.naturalWidth, img.naturalHeight);
        URL.revokeObjectURL(img.src);
        ultimo = { texto: '', t: 0 };
        if (leido) procesar(leido, 'foto');
        else mostrarResultado({ resultado: 'ERROR', mensaje: 'No se encontró un código QR en la imagen. Intenta con una foto más cercana y nítida.' });
      };
      img.src = URL.createObjectURL(archivo);
      e.target.value = '';
    });
  }

  /* ======================= Arranque ======================= */
  function arrancar() {
    aplicarConfig();
    avisos();
    prepararLogin();
    prepararAsistentes();
    prepararAcceso();
    mostrarSesion();
    rutas = enrutador(A.activa() ? 'asistentes' : 'login', (v) => {
      if (!A.activa() && v !== 'login') { rutas.ir('login'); return; }
      if (A.activa() && v === 'login') { rutas.ir('asistentes'); return; }
      if (v !== 'acceso') detenerCamara();
      if (v === 'asistentes') cargar();
      if (v === 'acceso') cargarLecturas();
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && A.activa() && location.hash === '#asistentes') cargar(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', arrancar); else arrancar();
})();
