/* ==========================================================================
   comun.js — Utilidades compartidas por index.html y admin.html
   ========================================================================== */
(function () {
  'use strict';
  const CFG = window.CONFIG;
  const $ = (s, raiz = document) => raiz.querySelector(s);
  const $$ = (s, raiz = document) => Array.from(raiz.querySelectorAll(s));

  /** Textos del evento desde config.js en los elementos con data-config */
  function aplicarConfig() {
    $$('[data-config]').forEach((el) => {
      const v = el.dataset.config.split('.').reduce((o, k) => (o ? o[k] : undefined), CFG);
      if (typeof v === 'string' && v) el.textContent = v;
    });
  }

  /** Avisos de modo demo y de conexión */
  function avisos(alVolverRed) {
    const demo = $('#aviso-demo');
    if (demo) demo.hidden = window.Datos.modo !== 'demo';
    const red = () => { const a = $('#aviso-red'); if (a) a.hidden = navigator.onLine; };
    window.addEventListener('online', () => { red(); if (alVolverRed) alVolverRed(); });
    window.addEventListener('offline', red);
    red();
  }

  /**
   * Navegación por vistas con el hash de la dirección (#inicio, #registro…).
   * Funciona con los botones atrás/adelante y en GitHub Pages.
   */
  function enrutador(inicial, alCambiar) {
    const vistas = $$('[data-vista]');
    const nombres = vistas.map((v) => v.dataset.vista);
    function mostrar() {
      const pedido = location.hash.slice(1);
      const actual = nombres.includes(pedido) ? pedido : inicial;
      vistas.forEach((v) => { v.hidden = v.dataset.vista !== actual; });
      $$('.pestanas a, .pestanas button[data-ir]').forEach((a) => {
        const destino = a.getAttribute('href') ? a.getAttribute('href').slice(1) : a.dataset.ir;
        if (destino === actual) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
      });
      window.scrollTo(0, 0);
      if (alCambiar) alCambiar(actual);
    }
    window.addEventListener('hashchange', mostrar);
    queueMicrotask(mostrar);   // después de que quien llama guarde el objeto devuelto
    return { ir: (v) => { if (location.hash === '#' + v) mostrar(); else location.hash = v; } };
  }

  /** QR vectorial (SVG), nítido y ligero */
  function dibujarQR(caja, texto, correccion) {
    try {
      const qr = window.qrcode(0, correccion || 'M');
      qr.addData(texto);
      qr.make();
      caja.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 8, scalable: true });
      caja.dataset.contenido = texto;
    } catch (e) {
      caja.textContent = 'No se pudo generar el código QR.';
      console.error('[QR]', e);
    }
  }

  const guardar = (alm, k, v) => { try { alm.setItem(k, JSON.stringify(v)); } catch (e) { /* sin almacenamiento */ } };
  const leer = (alm, k) => { try { return JSON.parse(alm.getItem(k)); } catch (e) { return null; } };
  const borrar = (alm, k) => { try { alm.removeItem(k); } catch (e) { /* nada */ } };

  function mensaje(el, texto, tipo) {
    el.textContent = texto || '';
    el.className = 'mensaje' + (tipo ? ' mensaje-' + tipo : '');
  }

  window.Comun = { $, $$, aplicarConfig, avisos, enrutador, dibujarQR, guardar, leer, borrar, mensaje };
})();
