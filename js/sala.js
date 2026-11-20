/* ==========================================================================
   sala.js — Plano interactivo de mesas y asientos
   --------------------------------------------------------------------------
   Dibuja CONFIG.sala.mesas mesas redondas con CONFIG.sala.asientosPorMesa
   asientos alrededor. Cada asiento es un <button> real (accesible con
   teclado y lector de pantalla). Expone window.Sala.

   Como en el cine: se eligen tantos asientos como lugares se pidieron
   (Sala.configurar({ maximo })). Los lugares accesibles (♿) solo se pueden
   elegir si la persona indicó una discapacidad (permitirAccesibles).
   ========================================================================== */
(function () {
  'use strict';

  const { mesas: MESAS, asientosPorMesa: POR_MESA } = window.CONFIG.sala;
  const { idAsiento, esAccesible, MAX_ACC } = window.Datos;
  const ICONO_ACCESIBLE = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="4" r="2"/><path d="M10.5 7.5h2.2l.5 5h4.3l2.5 5.2-1.8.9-2-4.1h-4.6zM9.4 10.2l.3 2.2A4.5 4.5 0 1 0 15.3 18l1.4 1.3a6.5 6.5 0 1 1-7.3-9.1z"/></svg>';

  let contenedor = null;
  let ocupados = new Set();
  let elegidos = [];            // ids seleccionados, en orden de selección
  let propios = new Set();      // asientos reservados por esta persona
  let maximo = 1;
  let permitirAccesibles = false;
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
        const id = idAsiento(mesa, lugar);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'asiento';
        btn.id = 'asiento-' + id;
        btn.dataset.asiento = id;
        btn.dataset.lugar = lugar;
        btn.style.left = 50 + 40 * Math.cos(angulo) + '%';
        btn.style.top = 50 + 40 * Math.sin(angulo) + '%';
        if (esAccesible(id)) { btn.classList.add('accesible'); btn.innerHTML = ICONO_ACCESIBLE; }
        else btn.textContent = lugar;
        caja.appendChild(btn);
      }
      contenedor.appendChild(caja);
    }

    contenedor.addEventListener('click', (evento) => {
      const btn = evento.target.closest('.asiento');
      if (!btn || btn.disabled) return;
      alternar(btn.dataset.asiento);
    });
  }

  /** Selecciona o quita un asiento respetando las reglas; avisa por qué si no se puede */
  function alternar(id) {
    if (elegidos.includes(id)) { elegidos = elegidos.filter((x) => x !== id); avisar(); return; }
    if (esAccesible(id) && !permitirAccesibles) { avisar({ motivo: 'accesible' }); return; }
    if (esAccesible(id) && elegidos.filter(esAccesible).length >= MAX_ACC) { avisar({ motivo: 'maxAccesibles' }); return; }
    if (elegidos.length >= maximo) {
      if (maximo === 1) elegidos = [];          // con un solo lugar, tocar otro lo cambia
      else { avisar({ motivo: 'completo' }); return; }
    }
    elegidos.push(id);
    avisar();
  }
  function avisar(info) { pintar(); alElegir(elegidos.slice(), info || {}); }

  /** Cambia la cantidad de lugares y si se permiten accesibles; ajusta la selección */
  function configurar(op) {
    if (op.maximo != null) maximo = op.maximo;
    if (op.permitirAccesibles != null) permitirAccesibles = op.permitirAccesibles;
    let info = {};
    const antes = elegidos.length;
    if (!permitirAccesibles) elegidos = elegidos.filter((id) => !esAccesible(id));
    if (elegidos.length < antes) info = { motivo: 'quitadosAccesibles' };
    if (elegidos.length > maximo) { elegidos = elegidos.slice(0, maximo); info = { motivo: 'recortado' }; }
    pintar();
    if (elegidos.length !== antes) alElegir(elegidos.slice(), info);
  }

  function fijar(lista) { elegidos = (lista || []).slice(0, maximo); pintar(); alElegir(elegidos.slice(), {}); }

  function actualizar(nuevosOcupados) {
    ocupados = nuevosOcupados;
    // Si un asiento elegido se ocupó mientras la persona llenaba el formulario,
    // se quita de la selección y se avisa.
    const antes = elegidos.length;
    elegidos = elegidos.filter((id) => !ocupados.has(id) || propios.has(id));
    pintar();
    if (elegidos.length < antes) alElegir(elegidos.slice(), { motivo: 'perdido' });
  }

  function pintar() {
    if (!contenedor) return;
    const lleno = elegidos.length >= maximo && maximo > 1;
    contenedor.querySelectorAll('.mesa').forEach((caja) => {
      let libres = 0;
      caja.querySelectorAll('.asiento').forEach((btn) => {
        const id = btn.dataset.asiento;
        const ocupado = ocupados.has(id);
        // Corrección BUG-02: un asiento solo es «tuyo» si de verdad está ocupado.
        const esPropio = propios.has(id) && ocupado;
        const esElegido = elegidos.includes(id);
        const acc = esAccesible(id);
        const bloqueado = !ocupado && !esElegido && acc && !permitirAccesibles;
        if (!ocupado) libres++;
        btn.classList.toggle('ocupado', ocupado && !esPropio);
        btn.classList.toggle('propio', esPropio);
        btn.classList.toggle('elegido', esElegido);
        btn.classList.toggle('bloqueado', bloqueado);
        btn.classList.toggle('apagado', !ocupado && !esElegido && lleno);
        btn.disabled = ocupado;
        btn.setAttribute('aria-pressed', esElegido ? 'true' : 'false');
        const estado = esPropio ? 'tu lugar' : ocupado ? 'ocupado' : esElegido ? 'seleccionado' : 'libre';
        const tipo = acc ? ', lugar accesible para personas con discapacidad' : '';
        btn.setAttribute('aria-label', `Mesa ${caja.dataset.mesa}, asiento ${btn.dataset.lugar}${tipo}, ${estado}`);
        btn.title = acc ? `Lugar accesible ♿ (mesa ${caja.dataset.mesa}, asiento ${btn.dataset.lugar})` : '';
      });
      caja.querySelector('[data-libres]').textContent = libres === 1 ? '1 libre' : `${libres} libres`;
      caja.classList.toggle('llena', libres === 0);
    });
  }

  window.Sala = {
    crear,
    actualizar,
    configurar,
    fijar,
    limpiar() { fijar([]); },
    get elegidos() { return elegidos.slice(); },
    get maximo() { return maximo; },
    marcarPropios(lista) { propios = new Set(lista || []); pintar(); },
    enfocar(id) {
      const btn = document.getElementById('asiento-' + id);
      if (btn) btn.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  };
})();
