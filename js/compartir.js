/* ==========================================================================
   compartir.js — Confirmaciones para el asistente
   --------------------------------------------------------------------------
   • imagenesBoletos(r) → genera una imagen PNG (canvas) por boleto, con su QR
   • compartir(r, imgs) → comparte las imágenes por WhatsApp (menú de compartir
                         del celular) o la descarga y abre WhatsApp en PC
   • enviarCorreo(r)   → envía la confirmación al correo del asistente con
                         EmailJS (sin servidor propio; ver config.js → correo)
   • enlaceContacto()  → enlace wa.me para escribirle al organizador
   ========================================================================== */
(function () {
  'use strict';
  const CFG = window.CONFIG;
  const EV = CFG.evento;

  /* ---------------- WhatsApp ---------------- */
  function enlaceContacto() {
    const texto = CFG.whatsapp.mensajeContacto || `Hola, tengo una duda sobre la conferencia «${EV.titulo}».`;
    return `https://wa.me/${CFG.whatsapp.numeroOrganizador}?text=${encodeURIComponent(texto)}`;
  }

  const listaLugares = (r, sep) => r.boletos.map((b) => `Mesa ${b.mesa}, asiento ${b.lugar}${b.accesible ? ' ♿' : ''}`).join(sep);

  function textoBoleto(r) {
    const n = r.boletos.length;
    return [
      n === 1 ? `✅ Mi lugar para la conferencia magistral «${EV.titulo}» está confirmado.`
              : `✅ Nuestros ${n} lugares para la conferencia magistral «${EV.titulo}» están confirmados.`,
      `👤 ${r.nombre}`,
      `🪑 ${listaLugares(r, ' · ')}`,
      `🎫 Folio: ${r.folio}`,
      `📅 ${EV.fecha}, ${EV.hora}`,
      `📍 ${EV.lugar}, ${EV.direccion}`
    ].join('\n');
  }

  /* ---------------- Imagen del boleto ---------------- */
  const ANCHO = 1080;
  const ALTO = 1500;
  const C = { noche: '#010a13', azul: '#0a1428', oro1: '#f0e6d2', oro2: '#c8aa6e', oro4: '#785a28',
              texto2: '#a09b8c', turquesa: '#0ac8b9' };
  const TITULO = "'Marcellus', Georgia, serif";
  const TEXTO = "'Barlow', 'Segoe UI', Arial, sans-serif";

  function lineas(ctx, texto, maximo) {
    const palabras = String(texto).split(/\s+/);
    const res = [];
    let actual = '';
    palabras.forEach((p) => {
      const prueba = actual ? actual + ' ' + p : p;
      if (ctx.measureText(prueba).width > maximo && actual) { res.push(actual); actual = p; } else actual = prueba;
    });
    if (actual) res.push(actual);
    return res;
  }
  function centrado(ctx, texto, y, fuente, color, maximo, interlineado) {
    ctx.font = fuente;
    ctx.fillStyle = color;
    const ls = lineas(ctx, texto, maximo || ANCHO - 160);
    ls.forEach((l, i) => ctx.fillText(l, ANCHO / 2, y + i * (interlineado || 0)));
    return y + (ls.length - 1) * (interlineado || 0);
  }
  function separador(ctx, y) {
    const g = ctx.createLinearGradient(140, 0, ANCHO - 140, 0);
    g.addColorStop(0, 'rgba(200,170,110,0)'); g.addColorStop(0.5, C.oro2); g.addColorStop(1, 'rgba(200,170,110,0)');
    ctx.strokeStyle = g; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(140, y); ctx.lineTo(ANCHO - 140, y); ctx.stroke();
    ctx.fillStyle = C.oro2;
    ctx.save(); ctx.translate(ANCHO / 2, y); ctx.rotate(Math.PI / 4); ctx.fillRect(-7, -7, 14, 14); ctx.restore();
  }
  function qr(ctx, texto, x, y, lado) {
    const q = window.qrcode(0, 'Q');
    q.addData(texto); q.make();
    const n = q.getModuleCount();
    const margen = 4;
    const celda = Math.floor(lado / (n + margen * 2));
    const real = celda * (n + margen * 2);
    const ox = x + (lado - real) / 2;
    const oy = y + (lado - real) / 2;
    ctx.fillStyle = '#ffffff'; ctx.fillRect(ox, oy, real, real);
    ctx.fillStyle = C.noche;
    for (let f = 0; f < n; f++) for (let c = 0; c < n; c++)
      if (q.isDark(f, c)) ctx.fillRect(ox + (c + margen) * celda, oy + (f + margen) * celda, celda, celda);
  }

  /** Una imagen por boleto (cada persona del grupo entra con la suya) */
  async function imagenesBoletos(r) {
    const n = r.boletos.length;
    const lista = [];
    for (const b of r.boletos) {
      const blob = await imagenBoleto(r, b);
      lista.push({ blob, nombre: n > 1 ? `boleto-${r.folio}-${b.numero}de${n}.png` : `boleto-${r.folio}.png` });
    }
    return lista;
  }

  async function imagenBoleto(r, b) {
    try { await Promise.all([document.fonts.load(`40px ${TITULO}`), document.fonts.load(`600 40px ${TEXTO}`), document.fonts.load(`40px ${TEXTO}`)]); }
    catch (e) { /* se usan fuentes del sistema */ }
    const cv = document.createElement('canvas');
    cv.width = ANCHO; cv.height = ALTO;
    const ctx = cv.getContext('2d');
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';

    // Fondo y marco dorado
    const fondo = ctx.createLinearGradient(0, 0, 0, ALTO);
    fondo.addColorStop(0, C.azul); fondo.addColorStop(1, C.noche);
    ctx.fillStyle = fondo; ctx.fillRect(0, 0, ANCHO, ALTO);
    ctx.strokeStyle = C.oro4; ctx.lineWidth = 3; ctx.strokeRect(40, 40, ANCHO - 80, ALTO - 80);
    ctx.strokeStyle = C.oro2; ctx.lineWidth = 1.5; ctx.strokeRect(56, 56, ANCHO - 112, ALTO - 112);

    let y = 150;
    centrado(ctx, (EV.nombre || 'Conferencia magistral').toUpperCase(), y, `30px ${TITULO}`, C.oro2);
    y = centrado(ctx, EV.titulo, y + 70, `56px ${TITULO}`, C.oro1, ANCHO - 200, 64);
    separador(ctx, y + 55);
    const n = r.boletos.length;
    const estado = n > 1 ? `REGISTRO CONFIRMADO · BOLETO ${b.numero} DE ${n}` : 'REGISTRO CONFIRMADO';
    centrado(ctx, estado, y + 125, `600 30px ${TEXTO}`, C.turquesa);
    centrado(ctx, `Mesa ${b.mesa} · Asiento ${b.lugar}`, y + 210, `78px ${TITULO}`, C.oro1);
    const titular = n > 1 ? `${r.nombre}${b.numero > 1 ? ' · acompañante' : ''}` : r.nombre;
    y = centrado(ctx, titular, y + 275, `40px ${TEXTO}`, C.texto2, ANCHO - 200, 48);
    if (b.accesible) { y += 52; centrado(ctx, '♿ LUGAR ACCESIBLE', y, `600 32px ${TEXTO}`, '#6fa8ff'); }

    const lado = b.accesible ? 400 : 440;
    const qy = y + 50;
    qr(ctx, b.codigo_qr, (ANCHO - lado) / 2, qy, lado);
    centrado(ctx, r.folio, qy + lado + 70, `600 44px ${TEXTO}`, C.oro2);
    separador(ctx, qy + lado + 120);
    centrado(ctx, `${EV.fecha} · ${EV.hora}`, qy + lado + 190, `36px ${TEXTO}`, C.oro1);
    centrado(ctx, `${EV.lugar} · ${EV.direccion}`, qy + lado + 245, `32px ${TEXTO}`, C.texto2);
    centrado(ctx, 'Muestra este código QR en la entrada', ALTO - 100, `28px ${TEXTO}`, C.turquesa);

    return new Promise((ok, mal) => cv.toBlob((b) => (b ? ok(b) : mal(new Error('No se pudo crear la imagen'))), 'image/png'));
  }

  function descargar(blob, nombre) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = nombre;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  /**
   * Debe llamarse directamente desde el clic (la imagen ya debe estar generada),
   * porque el menú de compartir del celular exige un gesto del usuario.
   * Devuelve 'compartido', 'cancelado' o 'descargado'.
   */
  async function compartir(r, imagenes) {
    const texto = textoBoleto(r);
    const varios = imagenes.length > 1;
    const archivos = imagenes.map((i) => new File([i.blob], i.nombre, { type: 'image/png' }));
    if (navigator.canShare && navigator.canShare({ files: archivos })) {
      try {
        await navigator.share({ files: archivos, text: texto, title: varios ? 'Mis boletos' : 'Mi boleto' });
        return 'compartido';
      } catch (e) {
        if (e.name === 'AbortError') return 'cancelado';
        console.warn('[Compartir]', e);
      }
    }
    // Computadora o navegador sin «compartir archivos»: se descargan y se abre WhatsApp con el texto
    imagenes.forEach((i, n) => setTimeout(() => descargar(i.blob, i.nombre), n * 400));
    const nota = varios ? '(Te adjunto las imágenes de los boletos)' : '(Te adjunto la imagen de mi boleto)';
    window.open(`https://wa.me/?text=${encodeURIComponent(texto + '\n\n' + nota)}`, '_blank', 'noopener');
    return 'descargado';
  }

  /* ---------------- Correo (EmailJS) ---------------- */
  const correoActivo = () => {
    const m = CFG.correo || {};
    return Boolean(m.serviceId && m.templateId && m.publicKey);
  };

  async function enviarCorreo(r) {
    if (!correoActivo()) throw new Error('El envío de correos no está configurado.');
    const m = CFG.correo;
    const sitio = location.href.split('#')[0];
    const resp = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service_id: m.serviceId,
        template_id: m.templateId,
        user_id: m.publicKey,
        template_params: {
          to_email: r.correo,
          to_name: r.nombre,
          evento: EV.titulo,
          cantidad: r.boletos.length,
          lugares: listaLugares(r, '\n'),
          mesa: r.boletos[0].mesa,
          asiento: r.boletos[0].lugar,
          folio: r.folio,
          codigos: r.boletos.map((b) => `Boleto ${b.numero} (mesa ${b.mesa}, asiento ${b.lugar}): ${b.codigo_qr}`).join('\n'),
          accesibilidad: r.discapacidad ? `${(CFG.discapacidades || {})[r.discapacidad] || r.discapacidad}${r.discapacidad_detalle ? ' — ' + r.discapacidad_detalle : ''}` : 'No solicitada',
          fecha: EV.fecha,
          hora: EV.hora,
          lugar: `${EV.lugar}, ${EV.direccion}`,
          enlace: sitio + '#mi-lugar',
          whatsapp: enlaceContacto()
        }
      })
    });
    if (!resp.ok) throw new Error('No se pudo enviar el correo (' + resp.status + ').');
  }

  window.Compartir = { enlaceContacto, textoBoleto, imagenBoleto, imagenesBoletos, compartir, descargar, enviarCorreo, correoActivo };
})();
