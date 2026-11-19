/* ==========================================================================
   app.js — Página pública: inicio, temas, registro, boleto con QR y «Mi lugar»
   ========================================================================== */
(function () {
  'use strict';
  const CFG = window.CONFIG;
  const { Datos, Sala, Compartir } = window;
  const { $, aplicarConfig, avisos, enrutador, dibujarQR, guardar, leer, borrar, mensaje } = window.Comun;
  const TOTAL = CFG.sala.mesas * CFG.sala.asientosPorMesa;
  const CLAVE_MIO = 'cm:mi-registro';
  const CLAVE_BORRADOR = 'cm:borrador';
  const CAMPOS = ['nombre', 'correo', 'telefono'];
  const form = $('#form-registro');
  let rutas;

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

  function resumen() {
    const el = $('#resumen');
    if (modo() === 'auto') el.textContent = 'Te asignaremos el primer lugar libre.';
    else if (Sala.elegido) { const p = Datos.partesAsiento(Sala.elegido); el.textContent = `Elegiste la mesa ${p.mesa}, asiento ${p.lugar}.`; }
    else el.textContent = 'Toca un asiento libre en el plano.';
  }
  function errores(e) {
    CAMPOS.concat('acepto').forEach((c) => {
      $('#error-' + c).textContent = e[c] || '';
      form.elements[c].setAttribute('aria-invalid', e[c] ? 'true' : 'false');
    });
  }
  function guardarBorrador() {
    const b = { modo: modo(), asiento: Sala.elegido };
    CAMPOS.forEach((c) => { b[c] = form.elements[c].value; });
    guardar(sessionStorage, CLAVE_BORRADOR, b);
  }
  function restaurarBorrador() {
    const b = leer(sessionStorage, CLAVE_BORRADOR);
    if (!b) return;
    CAMPOS.forEach((c) => { if (b[c]) form.elements[c].value = b[c]; });
    if (b.modo) fijarModo(b.modo);
    if (b.modo === 'manual' && b.asiento) Sala.elegir(b.asiento);
  }

  function prepararFormulario() {
    const tel = form.elements.telefono;
    tel.addEventListener('input', () => { const l = tel.value.replace(/\D/g, '').slice(0, 13); if (l !== tel.value) tel.value = l; });
    tel.addEventListener('blur', () => { const n = Datos.limpiarTelefono(tel.value); if (n !== tel.value) { tel.value = n; guardarBorrador(); } });
    form.addEventListener('input', guardarBorrador);
    form.addEventListener('change', (e) => {
      if (e.target.name === 'modo') { if (e.target.value === 'auto') Sala.elegir(null); resumen(); }
      guardarBorrador();
    });
    CAMPOS.forEach((c) => form.elements[c].addEventListener('blur', () => {
      if (!form.elements[c].value) return;
      const e = Datos.validar(Object.fromEntries(CAMPOS.map((k) => [k, form.elements[k].value])));
      $('#error-' + c).textContent = e[c] || '';
      form.elements[c].setAttribute('aria-invalid', e[c] ? 'true' : 'false');
    }));
    form.addEventListener('submit', enviar);
  }

  async function enviar(ev) {
    ev.preventDefault();
    const m = $('#mensaje-form');
    mensaje(m, '');
    const datos = { nombre: form.elements.nombre.value, correo: form.elements.correo.value,
      telefono: form.elements.telefono.value, asiento: modo() === 'manual' ? Sala.elegido : null };
    const e = Datos.validar(datos);
    if (!form.elements.acepto.checked) e.acepto = 'Marca la casilla para continuar.';
    errores(e);
    if (Object.keys(e).length) {
      form.elements[CAMPOS.concat('acepto').find((c) => e[c])].focus();
      mensaje(m, 'Revisa los datos marcados en rojo.', 'error');
      return;
    }
    if (modo() === 'manual' && !Sala.elegido) { mensaje(m, 'Elige un asiento en el plano o cambia a asignación automática.', 'error'); return; }

    const btn = $('#btn-reservar');
    btn.disabled = true;
    btn.textContent = 'Registrando…';
    try {
      const r = await Datos.reservar(datos);
      guardar(localStorage, CLAVE_MIO, r);
      borrar(sessionStorage, CLAVE_BORRADOR);
      form.reset();
      Sala.elegir(null);
      Sala.marcarPropio(r.asiento);
      resumen();
      refrescar();
      rutas.ir('boleto');
      if (Compartir.correoActivo()) enviarCorreoBoleto(r, true);
    } catch (err) {
      mensaje(m, err.message, 'error');
      if (err.codigo === 'CORREO_DUPLICADO') errores({ correo: 'Este correo ya está registrado.' });
      if (err.codigo === 'TELEFONO_DUPLICADO') errores({ telefono: 'Este número ya está registrado.' });
      if (err.codigo === 'ASIENTO_OCUPADO') { Sala.elegir(null); resumen(); refrescar(); }
      console.error('[Registro]', err.codigo, err);
    } finally {
      btn.textContent = 'Confirmar registro';
      btn.disabled = false;
    }
  }

  /* ---------------- Boleto: QR de acceso + WhatsApp ---------------- */
  function enlaceWhatsApp(r) {
    const texto = [
      `Hola, confirmo mi asistencia a la conferencia magistral «${CFG.evento.titulo}».`,
      `Nombre: ${r.nombre}`,
      `Folio: ${r.folio}`,
      `Lugar: mesa ${r.mesa}, asiento ${r.lugar}`,
      `Código de acceso: ${r.codigo_qr}`,
      `Fecha: ${CFG.evento.fecha}, ${CFG.evento.hora}`
    ].join('\n');
    return `https://wa.me/${CFG.whatsapp.numeroOrganizador}?text=${encodeURIComponent(texto)}`;
  }
  function pintarBoleto() {
    const r = leer(localStorage, CLAVE_MIO);
    $('#boleto').hidden = !r;
    $('#sin-boleto').hidden = Boolean(r);
    if (!r) return;
    $('#b-mesa').textContent = r.mesa;
    $('#b-lugar').textContent = r.lugar;
    $('#b-nombre').textContent = r.nombre;
    $('#b-folio').textContent = r.folio;
    dibujarQR($('#qr-acceso'), r.codigo_qr, 'Q');
    const wa = enlaceWhatsApp(r);
    $('#b-whatsapp').href = wa;
    dibujarQR($('#qr-whatsapp'), wa, 'L');
    $('#b-correo').hidden = !Compartir.correoActivo();
    prepararImagen(r);
  }

  /* La imagen se genera antes del clic: el menú de compartir del celular
     solo se abre si se llama justo en el gesto del usuario. */
  let imagen = null;   // { folio, blob }
  function prepararImagen(r) {
    if (imagen && imagen.folio === r.folio && imagen.codigo === r.codigo_qr) return;
    imagen = null;
    $('#b-compartir').disabled = true;
    $('#b-descargar').disabled = true;
    Compartir.imagenBoleto(r).then((blob) => {
      imagen = { folio: r.folio, codigo: r.codigo_qr, blob };
      $('#b-compartir').disabled = false;
      $('#b-descargar').disabled = false;
    }).catch((e) => console.error('[Imagen]', e));
  }
  function prepararBotonesBoleto() {
    const m = $('#mensaje-boleto');
    $('#b-compartir').addEventListener('click', async () => {
      const r = leer(localStorage, CLAVE_MIO);
      if (!r || !imagen) return;
      const res = await Compartir.compartir(r, imagen.blob);
      if (res === 'descargado') mensaje(m, 'Se descargó la imagen de tu boleto. Adjúntala en el chat de WhatsApp que se abrió.', 'ok');
    });
    $('#b-descargar').addEventListener('click', () => {
      const r = leer(localStorage, CLAVE_MIO);
      if (r && imagen) Compartir.descargar(imagen.blob, `boleto-${r.folio}.png`);
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
      mensaje(m, `Te enviamos la confirmación de tu lugar a ${r.correo}. Revisa también la carpeta de spam.`, 'ok');
    } catch (e) {
      console.error('[Correo]', e);
      mensaje(m, automatico
        ? 'Tu lugar quedó registrado, pero no pudimos enviarte el correo. Toca «Enviar a mi correo» para reintentar.'
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
        Sala.marcarPropio(r.asiento);
        mensaje(m, '');
        rutas.ir('boleto');
      } catch (err) { mensaje(m, err.message, 'error'); }
    });
    $('#btn-cancelar').addEventListener('click', () => {
      const { folio, correo } = valores();
      if (!folio || !correo) { mensaje(m, 'Para liberar tu lugar escribe tu folio y tu correo.', 'error'); return; }
      dialogo.showModal();
    });
    $('#confirmar-no').addEventListener('click', () => dialogo.close());
    $('#confirmar-si').addEventListener('click', async () => {
      dialogo.close();
      const { folio, correo } = valores();
      try {
        await Datos.cancelar(folio, correo);
        const mio = leer(localStorage, CLAVE_MIO);
        if (mio && mio.folio === folio) { borrar(localStorage, CLAVE_MIO); Sala.marcarPropio(null); }
        f.reset();
        mensaje(m, 'Tu lugar quedó libre. Gracias por avisar.', 'ok');
        refrescar();
      } catch (err) { mensaje(m, err.message, 'error'); }
    });
  }

  /** El boleto guardado pudo cancelarse en otro dispositivo (BUG-02 v1) */
  async function verificarMiRegistro() {
    const mio = leer(localStorage, CLAVE_MIO);
    if (!mio || !mio.folio) return;
    try {
      const r = await Datos.consultar(mio.folio, mio.correo);
      if (!r) { borrar(localStorage, CLAVE_MIO); Sala.marcarPropio(null); }
      else { guardar(localStorage, CLAVE_MIO, r); Sala.marcarPropio(r.asiento); }
    } catch (e) { /* sin red: se conserva y se reintenta después */ }
  }

  /* ---------------- Arranque ---------------- */
  function arrancar() {
    aplicarConfig();
    avisos(refrescar);
    Sala.crear($('#sala'), {
      alElegir(id, info) {
        if (id && modo() !== 'manual') fijarModo('manual');
        if (info && info.perdido) mensaje($('#mensaje-form'), 'El asiento que elegiste acaba de ocuparse. Elige otro.', 'error');
        resumen();
        guardarBorrador();
      }
    });
    const mio = leer(localStorage, CLAVE_MIO);
    if (mio) { Sala.marcarPropio(mio.asiento); $('#folio').value = mio.folio; $('#correo-consulta').value = mio.correo || ''; }
    restaurarBorrador();
    prepararFormulario();
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
