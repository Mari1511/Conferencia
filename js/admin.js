/* ==========================================================================
   admin.js — Panel de organización
     · Inicio de sesión (token de sesión, contraseña con bcrypt en Supabase)
     · Asistentes: consultar, buscar, registrar (uno o varios lugares),
       modificar, reasignar asientos, datos de accesibilidad, marcar
       confirmación de WhatsApp, eliminar y exportar a CSV (una fila por boleto)
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
    $('#e-registrados').textContent = res.ocupados;
    $('#e-cupo').textContent = `de ${res.cupo} lugares · ${res.registros} ${res.registros === 1 ? 'registro' : 'registros'}`;
    $('#e-libres').textContent = res.cupo - res.ocupados;
    $('#e-accesibles').textContent = `${res.accesibles_libres} accesibles ♿ libres`;
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
      const n = r.boletos.length;
      tr.append(celda(lugaresCortos(r)), celda(r.folio, 'secundario'), celda(r.nombre), celda(r.correo, 'secundario'), celda(r.telefono, 'secundario'));
      const acc = celda(r.discapacidad ? '♿ ' + tipoDe(r) : '—', r.discapacidad ? 'accesible' : 'secundario');
      if (r.discapacidad_detalle) acc.title = r.discapacidad_detalle;
      tr.appendChild(acc);
      const conf = document.createElement('td');
      conf.innerHTML = `<span class="insignia ${r.confirmado_whatsapp ? 'insignia-si">Sí' : 'insignia-no">No'}</span>`;
      const ing = document.createElement('td');
      const entraron = r.boletos.filter((b) => b.asistio_en);
      const ins = document.createElement('span');
      ins.className = 'insignia ' + (entraron.length ? 'insignia-si' : 'insignia-no');
      ins.textContent = !entraron.length ? 'Pendiente' : n === 1 ? hora(entraron[0].asistio_en) : `${entraron.length}/${n}`;
      ing.appendChild(ins);
      const accs = document.createElement('td');
      accs.innerHTML = '<div class="acciones-fila"><button type="button" class="boton boton-texto" data-accion="editar">Editar</button><button type="button" class="boton boton-texto" data-accion="eliminar">Eliminar</button></div>';
      tr.append(conf, ing, accs);
      cuerpo.appendChild(tr);
    });
  }

  const lugaresCortos = (r) => r.boletos.map((b) => `M${b.mesa}-A${b.lugar}${b.accesible ? '♿' : ''}`).join(', ');
  const lugaresLargos = (r) => r.boletos.map((b) => `mesa ${b.mesa}, asiento ${b.lugar}${b.accesible ? ' ♿' : ''}`).join('; ');
  const tipoDe = (r) => Datos.TIPOS[r.discapacidad] || r.discapacidad;
  let ocupadosEditor = new Set();

  /** Un <select> de asiento por boleto. En altas, «Automático» completa los que se dejen así. */
  function pintarSelectores() {
    const caja = $('#ed-asientos');
    const previos = [...caja.querySelectorAll('select')].map((x) => x.value);
    const actuales = editando ? editando.boletos.map((b) => b.asiento) : [];
    const n = editando ? actuales.length : Math.min(Datos.MAX, Math.max(1, Number($('#ed-cantidad').value) || 1));
    caja.textContent = '';
    for (let i = 0; i < n; i++) {
      const sel = document.createElement('select');
      sel.name = 'asiento';
      sel.setAttribute('aria-label', `Asiento del boleto ${i + 1}`);
      if (!editando) sel.add(new Option(`Boleto ${i + 1}: automático`, ''));
      let grupo = null;
      Datos.todosLosAsientos().forEach((id) => {
        if (ocupadosEditor.has(id) && !actuales.includes(id)) return;
        const p = Datos.partesAsiento(id);
        if (!grupo || grupo.dataset.mesa !== String(p.mesa)) {
          grupo = document.createElement('optgroup');
          grupo.label = `Mesa ${p.mesa}`;
          grupo.dataset.mesa = p.mesa;
          sel.appendChild(grupo);
        }
        const marca = Datos.esAccesible(id) ? ' ♿' : '';
        grupo.appendChild(new Option(`Boleto ${i + 1}: mesa ${p.mesa}, asiento ${p.lugar}${marca}${id === actuales[i] ? ' (actual)' : ''}`, id));
      });
      sel.value = previos[i] ?? actuales[i] ?? '';
      caja.appendChild(sel);
    }
  }

  async function abrirEditor(r) {
    editando = r || null;
    const f = $('#form-editar');
    f.reset();
    mensaje($('#mensaje-editar'), '');
    $('#t-editar').textContent = r ? 'Editar registro' : 'Nuevo registro';
    $('#ed-confirmado-fila').hidden = !r;
    $('#ed-cantidad-fila').hidden = Boolean(r);
    $('#ed-asientos').textContent = '';
    if (r) {
      f.elements.nombre.value = r.nombre;
      f.elements.correo.value = r.correo;
      f.elements.telefono.value = r.telefono;
      f.elements.confirmado.checked = Boolean(r.confirmado_whatsapp);
      f.elements.accesible.checked = Boolean(r.discapacidad);
      f.elements.discapacidad.value = r.discapacidad || '';
      f.elements.discapacidad_detalle.value = r.discapacidad_detalle || '';
    }
    $('#ed-campos-discapacidad').hidden = !f.elements.accesible.checked;
    ocupadosEditor = await Datos.ocupados();
    pintarSelectores();
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
      else {
        eliminando = r;
        const n = r.boletos.length;
        $('#eliminar-texto').textContent = `Se eliminará el registro de ${r.nombre} (${n} ${n === 1 ? 'lugar' : 'lugares'}: ${lugaresLargos(r)}) y ${n === 1 ? 'su código QR dejará' : 'sus códigos QR dejarán'} de servir.`;
        $('#dlg-eliminar').showModal();
      }
    });
    $('#ed-cancelar').addEventListener('click', () => $('#dlg-editar').close());
    Object.entries(Datos.TIPOS).forEach(([v, t]) => $('#ed-discapacidad').add(new Option(t, v)));
    $('#ed-cantidad').max = Datos.MAX;
    $('#ed-cantidad').addEventListener('input', pintarSelectores);
    $('#ed-accesible').addEventListener('change', (e) => { $('#ed-campos-discapacidad').hidden = !e.target.checked; });
    $('#form-editar').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const m = $('#mensaje-editar');
      const acc = f.elements.accesible.checked;
      const asientos = [...$('#ed-asientos').querySelectorAll('select')].map((x) => x.value).filter(Boolean);
      const d = { nombre: f.elements.nombre.value, correo: f.elements.correo.value, telefono: f.elements.telefono.value,
        cantidad: editando ? editando.boletos.length : Number(f.elements.cantidad.value) || 1, asientos,
        discapacidad: acc ? f.elements.discapacidad.value || null : null,
        discapacidad_detalle: acc ? f.elements.discapacidad_detalle.value : '',
        confirmado_whatsapp: f.elements.confirmado.checked };
      const errs = Datos.validar(d);
      if (acc && !f.elements.discapacidad.value) errs.discapacidad = 'Elige el tipo de discapacidad.';
      if (Object.keys(errs).length) { mensaje(m, Object.values(errs)[0], 'error'); return; }
      try {
        const r = await seguro(() => (editando ? A.actualizar(editando.id, d) : A.registrar(d)), m);
        if (!r) return;
        $('#dlg-editar').close();
        mensaje($('#mensaje-tabla'), editando ? `Se guardaron los cambios de ${r.nombre}.` : `${r.nombre} quedó registrado: ${lugaresLargos(r)} (folio ${r.folio}).`, 'ok');
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
    const filas = [['Folio', 'Boleto', 'Mesa', 'Asiento', 'Lugar accesible', 'Nombre', 'Correo', 'WhatsApp', 'Discapacidad', 'Detalle', 'Confirmó WhatsApp', 'Ingreso', 'Registro']]
      .concat(lista.flatMap((r) => r.boletos.map((b) => [r.folio, `${b.numero} de ${r.boletos.length}`, b.mesa, b.lugar, b.accesible ? 'Sí' : 'No',
        r.nombre, r.correo, r.telefono, r.discapacidad ? tipoDe(r) : '', r.discapacidad_detalle || '',
        r.confirmado_whatsapp ? 'Sí' : 'No', b.asistio_en || '', r.creado_en])));
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
    const b = r.boleto;
    let detalle = r.mensaje || 'Este código no pertenece a ningún registro. Pide el folio y búscalo en Asistentes.';
    if (a && b) {
      const n = a.boletos.length;
      const lugar = `mesa ${b.mesa}, asiento ${b.lugar}${b.accesible ? ' ♿' : ''}`;
      const quien = n > 1 ? `${a.nombre} (boleto ${b.numero} de ${n}${b.numero > 1 ? ', acompañante' : ''})` : a.nombre;
      if (r.resultado === 'VALIDO') detalle = `${quien}: ${lugar}. Bienvenida(o).`;
      if (r.resultado === 'YA_INGRESO') detalle = `${quien} ya entró a las ${hora(b.asistio_en)} (${lugar}).`;
      if (a.discapacidad) detalle += ` ♿ Requiere apoyo: ${tipoDe(a)}${a.discapacidad_detalle ? ' — ' + a.discapacidad_detalle : ''}.`;
    }
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
      const n = document.createElement('span'); n.textContent = x.nombre ? `${x.nombre} · M${x.mesa}-A${x.lugar}${x.total > 1 ? ` (${x.numero}/${x.total})` : ''}` : x.codigo_leido;
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
