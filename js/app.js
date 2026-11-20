/* ==========================================================================
   app.js — Página pública: inicio, temas, registro, boletos con QR y «Mi lugar»
   ========================================================================== */
(function () {
  'use strict';
  const CFG = window.CONFIG;
  const { Datos, Sala, Compartir } = window;
  const { $, aplicarConfig, avisos, enrutador, dibujarQR, guardar, leer, borrar, mensaje } = window.Comun;
  const TOTAL = Datos.TOTAL;
  const CLAVE_MIO = 'cm:v2:mi-registro';
  const CLAVE_BORRADOR = 'cm:v2:borrador';
  const CAMPOS = ['nombre', 'correo', 'telefono', 'discapacidad_detalle'];
  const ERRORES = ['nombre', 'correo', 'telefono', 'cantidad', 'discapacidad', 'discapacidad_detalle', 'asientos', 'acepto'];
  const form = $('#form-registro');
  let rutas;

  const plural = (n, uno, varios) => (n === 1 ? uno : varios);
  const asientosDe = (r) => (r && Array.isArray(r.boletos) ? r.boletos.map((b) => b.asiento) : []);

  /* ---------------- Disponibilidad ---------------- */
  function pintarCupo(ocupados) {
    $('#libres-numero').textContent = TOTAL - ocupados.size;
    $('#cupo-relleno').style.width = (ocupados.size / TOTAL) * 100 + '%';
    const lleno = ocupados.size >= TOTAL;
    $('#btn-reservar').disabled = lleno;
    const m = $('#mensaje-form');
    if (lleno) mensaje(m, Datos.MENSAJES.CUPO_LLENO, 'error');
    else if (m.textContent === Datos.MENSAJES.CUPO_LLENO) mensaje(m, '');   // BUG-03 v1
  }
  let enCurso = null;
  function refrescar() {
    if (enCurso) return enCurso;
    enCurso = Datos.ocupados()
      .then((o) => { Sala.actualizar(o); pintarCupo(o); $('#sala-cargando').hidden = true; })
      .catch((e) => { const c = $('#sala-cargando'); c.textContent = e.message; c.hidden = false; })
      .finally(() => { enCurso = null; });
    return enCurso;
  }

  /* ---------------- Formulario de registro ---------------- */
  const modo = () => form.querySelector('input[name="modo"]:checked').value;
  const fijarModo = (v) => { form.querySelector(`input[name="modo"][value="${v}"]`).checked = true; };
  const quiereAccesible = () => form.elements.requiere_accesible.checked;
  function cantidad() {
    const n = Number.parseInt(form.elements.cantidad.value, 10);
    return Math.min(Datos.MAX, Math.max(1, Number.isFinite(n) ? n : 1));
  }

  function sincronizar() {
    $('#campos-discapacidad').hidden = !quiereAccesible();
    $('#detalle-opcional').hidden = form.elements.discapacidad.value === 'otra';
    $('#cantidad-menos').disabled = cantidad() <= 1;
    $('#cantidad-mas').disabled = cantidad() >= Datos.MAX;
    Sala.configurar({ maximo: cantidad(), permitirAccesibles: quiereAccesible() });
  }

  function resumen() {
    const el = $('#resumen');
    const n = cantidad();
    const acc = quiereAccesible();
    if (modo() === 'auto') {
      el.textContent = n === 1
        ? (acc ? 'Te asignaremos un lugar accesible ♿.' : 'Te asignaremos el primer lugar libre.')
        : `Te asignaremos ${n} lugares juntos${acc ? ', uno de ellos accesible ♿' : ''}.`;
      return;
    }
    const elegidos = Sala.elegidos;
    if (!elegidos.length) { el.textContent = n === 1 ? 'Toca un asiento libre en el plano.' : `Toca ${n} asientos libres en el plano.`; return; }
    const lista = elegidos.map((id) => Datos.textoAsiento(id).replace('Mesa', 'mesa') + (Datos.esAccesible(id) ? ' ♿' : '')).join('; ');
    const faltan = n - elegidos.length;
    el.textContent = `Elegiste ${elegidos.length} de ${n}: ${lista}.` + (faltan ? ` ${plural(faltan, 'Falta 1', `Faltan ${faltan}`)}.` : '');
  }

  function errores(e) {
    ERRORES.forEach((c) => {
      const p = $('#error-' + c);
      if (p) p.textContent = e[c] || '';
      const campo = form.elements[c];
      if (campo && campo.setAttribute) campo.setAttribute('aria-invalid', e[c] ? 'true' : 'false');
    });
  }

  function leerFormulario() {
    const acc = quiereAccesible();
    return {
      nombre: form.elements.nombre.value, correo: form.elements.correo.value, telefono: form.elements.telefono.value,
      cantidad: cantidad(),
      asientos: modo() === 'manual' ? Sala.elegidos : [],
      discapacidad: acc ? form.elements.discapacidad.value || null : null,
      discapacidad_detalle: acc ? form.elements.discapacidad_detalle.value : ''
    };
  }
  function validarFormulario() {
    const d = leerFormulario();
    const e = Datos.validar(d);
    if (quiereAccesible() && !form.elements.discapacidad.value) e.discapacidad = 'Elige el tipo de discapacidad.';
    if (!form.elements.acepto.checked) e.acepto = 'Marca la casilla para continuar.';
    if (!e.asientos && modo() === 'manual' && d.asientos.length !== d.cantidad) {
      const faltan = d.cantidad - d.asientos.length;
      e.asientos = `Elige ${faltan} ${plural(faltan, 'asiento más', 'asientos más')} en el plano o cambia a asignación automática.`;
    }
    return { d, e };
  }

  function guardarBorrador() {
    const b = { modo: modo(), asientos: Sala.elegidos, cantidad: cantidad(), accesible: quiereAccesible(),
      discapacidad: form.elements.discapacidad.value };
    CAMPOS.forEach((c) => { b[c] = form.elements[c].value; });
    guardar(sessionStorage, CLAVE_BORRADOR, b);
  }
  function restaurarBorrador() {
    const b = leer(sessionStorage, CLAVE_BORRADOR);
    if (!b) return;
    CAMPOS.forEach((c) => { if (b[c]) form.elements[c].value = b[c]; });
    if (b.cantidad) form.elements.cantidad.value = b.cantidad;
    form.elements.requiere_accesible.checked = Boolean(b.accesible);
    if (b.discapacidad) form.elements.discapacidad.value = b.discapacidad;
    if (b.modo) fijarModo(b.modo);
    sincronizar();
    if (b.modo === 'manual' && Array.isArray(b.asientos)) Sala.fijar(b.asientos);
  }

  function prepararFormulario() {
    const sel = form.elements.discapacidad;
    Object.entries(Datos.TIPOS).forEach(([valor, texto]) => sel.add(new Option(texto, valor)));
    const cant = form.elements.cantidad;
    cant.max = Datos.MAX;
    $('#cantidad-menos').addEventListener('click', () => { cant.value = cantidad() - 1; cant.dispatchEvent(new Event('change', { bubbles: true })); });
    $('#cantidad-mas').addEventListener('click', () => { cant.value = cantidad() + 1; cant.dispatchEvent(new Event('change', { bubbles: true })); });
    cant.addEventListener('blur', () => { cant.value = cantidad(); });

    const tel = form.elements.telefono;
    tel.addEventListener('input', () => { const l = tel.value.replace(/\D/g, '').slice(0, 13); if (l !== tel.value) tel.value = l; });
    tel.addEventListener('blur', () => { const n = Datos.limpiarTelefono(tel.value); if (n !== tel.value) { tel.value = n; guardarBorrador(); } });

    form.addEventListener('input', guardarBorrador);
    form.addEventListener('change', (e) => {
      const n = e.target.name;
      if (n === 'modo' && e.target.value === 'auto') Sala.limpiar();
      if (['cantidad', 'requiere_accesible', 'discapacidad'].includes(n)) {
        sincronizar();
        if (n === 'cantidad') $('#error-cantidad').textContent = '';
        if (n === 'requiere_accesible' && !quiereAccesible()) ['discapacidad', 'discapacidad_detalle'].forEach((c) => { $('#error-' + c).textContent = ''; });
      }
      resumen();
      guardarBorrador();
    });
    ['nombre', 'correo', 'telefono'].forEach((c) => form.elements[c].addEventListener('blur', () => {
      if (!form.elements[c].value) return;
      const e = Datos.validar(leerFormulario());
      $('#error-' + c).textContent = e[c] || '';
      form.elements[c].setAttribute('aria-invalid', e[c] ? 'true' : 'false');
    }));
    form.addEventListener('submit', enviar);
  }

  /** Respuesta del plano cuando se toca un asiento o cambia la selección */
  function alElegir(lista, info) {
    if (lista.length && modo() !== 'manual') fijarModo('manual');
    const n = cantidad();
    const textos = {
      accesible: Datos.MENSAJES.ACCESIBLE_NO_PERMITIDO,
      maxAccesibles: Datos.MENSAJES.ACCESIBLES_EXCEDIDOS,
      completo: `Ya elegiste tus ${n} lugares. Toca uno de tus asientos para quitarlo o aumenta la cantidad.`,
      perdido: 'Uno de los asientos que elegiste acaba de ocuparse. Elige otro.',
      recortado: 'Redujiste la cantidad de lugares: quitamos los últimos asientos que elegiste.',
      quitadosAccesibles: 'Quitamos el lugar accesible ♿ de tu selección porque desmarcaste la casilla de accesibilidad.'
    };
    $('#error-asientos').textContent = textos[info.motivo] || '';
    if (info.motivo === 'accesible') form.elements.requiere_accesible.focus();
    resumen();
    guardarBorrador();
  }

  async function enviar(ev) {
    ev.preventDefault();
    const m = $('#mensaje-form');
    mensaje(m, '');
    const { d, e } = validarFormulario();
    errores(e);
    if (Object.keys(e).length) {
      const primero = ERRORES.find((c) => e[c]);
      const campo = form.elements[primero];
      if (campo && campo.focus) campo.focus();
      mensaje(m, 'Revisa los datos marcados en rojo.', 'error');
      return;
    }

    const btn = $('#btn-reservar');
    btn.disabled = true;
    btn.textContent = 'Registrando…';
    try {
      const r = await Datos.reservar(d);
      guardar(localStorage, CLAVE_MIO, r);
      borrar(sessionStorage, CLAVE_BORRADOR);
      Sala.limpiar();          // primero la selección: si no, bajar la cantidad la «recorta» y activa el modo manual
      form.reset();
      sincronizar();
      $('#error-asientos').textContent = '';
      Sala.marcarPropios(asientosDe(r));
      resumen();
      refrescar();
      rutas.ir('boleto');
      if (Compartir.correoActivo()) enviarCorreoBoleto(r, true);
    } catch (err) {
      mensaje(m, err.message, 'error');
      if (err.codigo === 'CORREO_DUPLICADO') errores({ correo: 'Este correo ya está registrado.' });
      if (err.codigo === 'TELEFONO_DUPLICADO') errores({ telefono: 'Este número ya está registrado.' });
      if (['ACCESIBLE_NO_PERMITIDO', 'ACCESIBLES_EXCEDIDOS', 'LUGARES_INSUFICIENTES'].includes(err.codigo)) errores({ asientos: err.message });
      if (err.codigo === 'ASIENTO_OCUPADO') refrescar();
      console.error('[Registro]', err.codigo, err);
    } finally {
      btn.textContent = 'Confirmar registro';
      btn.disabled = false;
    }
  }

  /* ---------------- Boletos: QR de acceso + WhatsApp ---------------- */
  function enlaceWhatsApp(r) {
    const lugares = r.boletos.map((b) => `• Boleto ${b.numero}: mesa ${b.mesa}, asiento ${b.lugar}${b.accesible ? ' ♿' : ''}`);
    const texto = [
      `Hola, confirmo mi asistencia a la conferencia magistral «${CFG.evento.titulo}».`,
      `Nombre: ${r.nombre}`,
      `Folio: ${r.folio}`,
      `${r.boletos.length} ${plural(r.boletos.length, 'lugar', 'lugares')}:`,
      ...lugares,
      ...(r.discapacidad ? [`Accesibilidad: ${Datos.TIPOS[r.discapacidad] || r.discapacidad}${r.discapacidad_detalle ? ' (' + r.discapacidad_detalle + ')' : ''}`] : []),
      `Fecha: ${CFG.evento.fecha}, ${CFG.evento.hora}`
    ].join('\n');
    return `https://wa.me/${CFG.whatsapp.numeroOrganizador}?text=${encodeURIComponent(texto)}`;
  }

  function pintarBoleto() {
    let r = leer(localStorage, CLAVE_MIO);
    if (r && !Array.isArray(r.boletos)) { borrar(localStorage, CLAVE_MIO); r = null; }   // formato de la v1
    $('#boleto').hidden = !r;
    $('#sin-boleto').hidden = Boolean(r);
    if (!r) return;
    const n = r.boletos.length;
    const b1 = r.boletos[0];
    $('#t-boleto').textContent = n === 1 ? `Mesa ${b1.mesa} · Asiento ${b1.lugar}` : `${n} lugares reservados`;
    $('#b-nombre').textContent = r.nombre;
    $('#b-folio').textContent = r.folio;
    const acc = $('#b-accesible');
    acc.hidden = !r.discapacidad;
    acc.textContent = r.discapacidad ? `♿ Accesibilidad: ${Datos.TIPOS[r.discapacidad] || r.discapacidad}${r.discapacidad_detalle ? ' — ' + r.discapacidad_detalle : ''}` : '';

    const caja = $('#b-boletos');
    caja.textContent = '';
    caja.classList.toggle('varios', n > 1);
    r.boletos.forEach((b) => {
      const tarjeta = document.createElement('div');
      tarjeta.className = 'boleto-qr' + (b.accesible ? ' es-accesible' : '');
      const et = document.createElement('span'); et.className = 'etiqueta'; et.textContent = n > 1 ? `Boleto ${b.numero} de ${n}` : 'Boleto';
      const lugar = document.createElement('strong'); lugar.textContent = `Mesa ${b.mesa} · Asiento ${b.lugar}${b.accesible ? ' ♿' : ''}`;
      const qr = document.createElement('div'); qr.className = 'qr-marco';
      qr.setAttribute('role', 'img'); qr.setAttribute('aria-label', `Código QR de acceso, mesa ${b.mesa}, asiento ${b.lugar}`);
      tarjeta.append(et, lugar, qr);
      caja.appendChild(tarjeta);
      dibujarQR(qr, b.codigo_qr, 'Q');
    });
    $('#b-acceso').textContent = n > 1 ? 'Cada persona muestra su propio QR en la entrada' : 'Muestra este QR en la entrada';
    $('#b-compartir-texto').textContent = n > 1 ? 'Compartir boletos por WhatsApp' : 'Compartir boleto por WhatsApp';
    $('#b-descargar').textContent = n > 1 ? 'Descargar imágenes' : 'Descargar imagen';

    const wa = enlaceWhatsApp(r);
    $('#b-whatsapp').href = wa;
    dibujarQR($('#qr-whatsapp'), wa, 'L');
    $('#b-correo').hidden = !Compartir.correoActivo();
    prepararImagenes(r);
  }

  /* Las imágenes se generan antes del clic: el menú de compartir del celular
     solo se abre si se llama justo en el gesto del usuario. */
  let imagenes = null;   // { clave, lista: [{ nombre, blob }] }
  function prepararImagenes(r) {
    const clave = r.folio + '|' + r.boletos.map((b) => b.codigo_qr + b.asiento).join(',');
    if (imagenes && imagenes.clave === clave) return;
    imagenes = null;
    $('#b-compartir').disabled = true;
    $('#b-descargar').disabled = true;
    Compartir.imagenesBoletos(r).then((lista) => {
      imagenes = { clave, lista };
      $('#b-compartir').disabled = false;
      $('#b-descargar').disabled = false;
    }).catch((e) => console.error('[Imagen]', e));
  }
  function prepararBotonesBoleto() {
    const m = $('#mensaje-boleto');
    $('#b-compartir').addEventListener('click', async () => {
      const r = leer(localStorage, CLAVE_MIO);
      if (!r || !imagenes) return;
      const res = await Compartir.compartir(r, imagenes.lista);
      if (res === 'descargado') {
        mensaje(m, imagenes.lista.length > 1
          ? 'Se descargaron las imágenes de tus boletos. Adjúntalas en el chat de WhatsApp que se abrió.'
          : 'Se descargó la imagen de tu boleto. Adjúntala en el chat de WhatsApp que se abrió.', 'ok');
      }
    });
    $('#b-descargar').addEventListener('click', () => {
      if (imagenes) imagenes.lista.forEach((img, i) => setTimeout(() => Compartir.descargar(img.blob, img.nombre), i * 400));
    });
    $('#b-correo').addEventListener('click', () => {
      const r = leer(localStorage, CLAVE_MIO);
      if (r) enviarCorreoBoleto(r, false);
    });
  }
  async function enviarCorreoBoleto(r, automatico) {
    const m = $('#mensaje-boleto');
    const btn = $('#b-correo');
    btn.disabled = true;
    mensaje(m, `Enviando la confirmación a ${r.correo}…`);
    try {
      await Compartir.enviarCorreo(r);
      mensaje(m, `Te enviamos la confirmación de tus lugares a ${r.correo}. Revisa también la carpeta de spam.`, 'ok');
    } catch (e) {
      console.error('[Correo]', e);
      mensaje(m, automatico
        ? 'Tus lugares quedaron registrados, pero no pudimos enviarte el correo. Toca «Enviar a mi correo» para reintentar.'
        : 'No pudimos enviar el correo. Revisa tu conexión y vuelve a intentarlo.', 'error');
    } finally { btn.disabled = false; }
  }

  /* ---------------- Mi lugar ---------------- */
  function prepararConsulta() {
    const f = $('#form-consulta');
    const m = $('#mensaje-consulta');
    const dialogo = $('#confirmar');
    const valores = () => ({ folio: f.elements.folio.value.trim().toUpperCase(), correo: f.elements.correo.value.trim() });

    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const { folio, correo } = valores();
      if (!folio || !correo) { mensaje(m, 'Escribe tu folio y tu correo.', 'error'); return; }
      try {
        const r = await Datos.consultar(folio, correo);
        if (!r) { mensaje(m, Datos.MENSAJES.NO_ENCONTRADO, 'error'); return; }
        guardar(localStorage, CLAVE_MIO, r);
        Sala.marcarPropios(asientosDe(r));
        mensaje(m, '');
        rutas.ir('boleto');
      } catch (err) { mensaje(m, err.message, 'error'); }
    });
    $('#btn-cancelar').addEventListener('click', () => {
      const { folio, correo } = valores();
      if (!folio || !correo) { mensaje(m, 'Para liberar tus lugares escribe tu folio y tu correo.', 'error'); return; }
      dialogo.showModal();
    });
    $('#confirmar-no').addEventListener('click', () => dialogo.close());
    $('#confirmar-si').addEventListener('click', async () => {
      dialogo.close();
      const { folio, correo } = valores();
      try {
        await Datos.cancelar(folio, correo);
        const mio = leer(localStorage, CLAVE_MIO);
        if (mio && mio.folio === folio) { borrar(localStorage, CLAVE_MIO); Sala.marcarPropios([]); }
        f.reset();
        mensaje(m, 'Tus lugares quedaron libres. Gracias por avisar.', 'ok');
        refrescar();
      } catch (err) { mensaje(m, err.message, 'error'); }
    });
  }

  /** El registro guardado pudo cancelarse o cambiarse en otro dispositivo (BUG-02 v1) */
  async function verificarMiRegistro() {
    const mio = leer(localStorage, CLAVE_MIO);
    if (!mio || !mio.folio) return;
    try {
      const r = await Datos.consultar(mio.folio, mio.correo);
      if (!r) { borrar(localStorage, CLAVE_MIO); Sala.marcarPropios([]); }
      else { guardar(localStorage, CLAVE_MIO, r); Sala.marcarPropios(asientosDe(r)); }
    } catch (e) { /* sin red: se conserva y se reintenta después */ }
  }

  /* ---------------- Arranque ---------------- */
  function arrancar() {
    aplicarConfig();
    avisos(refrescar);
    Sala.crear($('#sala'), { alElegir });
    const mio = leer(localStorage, CLAVE_MIO);
    if (mio && Array.isArray(mio.boletos)) {
      Sala.marcarPropios(asientosDe(mio));
      $('#folio').value = mio.folio; $('#correo-consulta').value = mio.correo || '';
    }
    prepararFormulario();
    restaurarBorrador();
    sincronizar();
    prepararConsulta();
    $('#b-imprimir').addEventListener('click', () => window.print());
    prepararBotonesBoleto();
    $('#contacto-wa').href = Compartir.enlaceContacto();
    resumen();
    rutas = enrutador('inicio', (v) => { if (v === 'boleto') pintarBoleto(); if (v === 'registro') refrescar(); });
    refrescar().then(() => {
      console.info(`[Rendimiento] Página lista: ${Math.round(performance.now())} ms`);
      verificarMiRegistro().then(() => { if (location.hash === '#boleto') pintarBoleto(); });
    });
    if (Datos.modo === 'supabase') setInterval(() => { if (!document.hidden) refrescar(); }, CFG.refrescoSegundos * 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refrescar(); });
    window.addEventListener('storage', (e) => { if (e.key && e.key.startsWith('cm:')) refrescar(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', arrancar); else arrancar();
})();
