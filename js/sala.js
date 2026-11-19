/* ==========================================================================
   sala.js — Plano interactivo de mesas y asientos
   --------------------------------------------------------------------------
   Dibuja CONFIG.sala.mesas mesas redondas con CONFIG.sala.asientosPorMesa
   asientos alrededor. Cada asiento es un <button> real (accesible con
   teclado y lector de pantalla). Expone window.Sala.
   ========================================================================== */
(function () {
  'use strict';

  const { mesas: MESAS, asientosPorMesa: POR_MESA } = window.CONFIG.sala;
  const { idAsiento } = window.Datos;

  let contenedor = null;
  let ocupados = new Set();
  let elegido = null;          // id del asiento seleccionado
  let propio = null;           // id del asiento reservado por esta persona
  let alElegir = () => {};

  function crear(elemento, opciones) {
    contenedor = elemento;
    alElegir = opciones.alElegir || alElegir;
    contenedor.textContent = '';

    for (let mesa = 1; mesa <= MESAS; mesa++) {
      const caja = document.createElement('div');
      caja.className = 'mesa';
      caja.dataset.mesa = mesa;

      const centro = document.createElement('div');
      centro.className = 'mesa-centro';
      centro.innerHTML = `<span class="mesa-num">Mesa ${mesa}</span><span class="mesa-libres" data-libres></span>`;
      caja.appendChild(centro);

      for (let lugar = 1; lugar <= POR_MESA; lugar++) {
        // Asientos repartidos en círculo; el 1 queda arriba, en sentido horario.
        const angulo = (2 * Math.PI * (lugar - 1)) / POR_MESA - Math.PI / 2;
        const x = 50 + 40 * Math.cos(angulo);
        const y = 50 + 40 * Math.sin(angulo);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'asiento';
        btn.id = 'asiento-' + idAsiento(mesa, lugar);
        btn.dataset.asiento = idAsiento(mesa, lugar);
        btn.style.left = x + '%';
        btn.style.top = y + '%';
        btn.textContent = lugar;
        caja.appendChild(btn);
      }
      contenedor.appendChild(caja);
    }

    contenedor.addEventListener('click', (evento) => {
      const btn = evento.target.closest('.asiento');
      if (!btn || btn.disabled) return;
      elegir(btn.dataset.asiento === elegido ? null : btn.dataset.asiento);
    });
  }

  function elegir(id) {
    elegido = id;
    pintar();
    alElegir(elegido);
  }

  function actualizar(nuevosOcupados) {
    ocupados = nuevosOcupados;
    // Si el asiento elegido se ocupó mientras la persona llenaba el formulario,
    // se quita la selección y se avisa.
    let perdido = false;
    if (elegido && ocupados.has(elegido) && elegido !== propio) {
      elegido = null;
      perdido = true;
    }
    pintar();
    if (perdido) alElegir(null, { perdido: true });
  }

  function pintar() {
    if (!contenedor) return;
    contenedor.querySelectorAll('.mesa').forEach((caja) => {
      let libres = 0;
      caja.querySelectorAll('.asiento').forEach((btn) => {
        const id = btn.dataset.asiento;
        const ocupado = ocupados.has(id);
        // Corrección BUG-02: un asiento solo es «tuyo» si de verdad está ocupado.
        const esPropio = id === propio && ocupado;
        const esElegido = id === elegido;
        if (!ocupado) libres++;
        btn.classList.toggle('ocupado', ocupado && !esPropio);
        btn.classList.toggle('propio', esPropio);
        btn.classList.toggle('elegido', esElegido);
        btn.disabled = ocupado;
        btn.setAttribute('aria-pressed', esElegido ? 'true' : 'false');
        const estado = esPropio ? 'tu lugar' : ocupado ? 'ocupado' : esElegido ? 'seleccionado' : 'libre';
        btn.setAttribute('aria-label', `Mesa ${caja.dataset.mesa}, asiento ${btn.textContent}, ${estado}`);
      });
      caja.querySelector('[data-libres]').textContent = libres === 1 ? '1 libre' : `${libres} libres`;
      caja.classList.toggle('llena', libres === 0);
    });
  }

  window.Sala = {
    crear,
    actualizar,
    elegir,
    get elegido() { return elegido; },
    marcarPropio(id) { propio = id; pintar(); },
    enfocar(id) {
      const btn = document.getElementById('asiento-' + id);
      if (btn) btn.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  };
})();
