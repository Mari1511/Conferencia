/* ==========================================================================
   datos.js — Capa de datos (la usan index.html y admin.html)
   --------------------------------------------------------------------------
   Misma interfaz para dos «adaptadores»:
     • Demo     → localStorage del navegador (sin servidor, para probar y clase)
     • Supabase → PostgreSQL en la nube, por medio de las funciones RPC de
                  supabase/schema.sql (no se tocan tablas directamente)

   Un REGISTRO es la persona que reserva (nombre, correo, WhatsApp y, si la
   pide, su discapacidad). Cada registro tiene de 1 a N BOLETOS: uno por
   lugar, cada uno con su propio código QR de acceso.

   Público:  Datos.ocupados() · reservar(d) · consultar(folio, correo) · cancelar(folio, correo)
   Panel:    Datos.admin.iniciar(usuario, clave) · cerrar() · activa()
             resumen() · listar(buscar) · registrar(d) · actualizar(id, d)
             eliminar(id) · validarQR(codigo) · accesos()

   Entrada de reservar / registrar / actualizar:
     { nombre, correo, telefono, cantidad, asientos: ['M01-A03', …],
       discapacidad: 'silla_ruedas' | … | null, discapacidad_detalle }
     · asientos vacío = asignación automática de «cantidad» lugares
     · asientos incompleto = se respetan los elegidos y se completan solos

   Los errores se lanzan como ErrorDatos con un código fijo; MENSAJES
   traduce cada código a un texto claro en español.
   ========================================================================== */
(function () {
  'use strict';

  const CFG = window.CONFIG;
  const SALA = CFG.sala;
  const MESAS = SALA.mesas;
  const POR_MESA = SALA.asientosPorMesa;
  const TOTAL = MESAS * POR_MESA;
  const MAX = SALA.maxPorRegistro || 1;
  const MAX_ACC = SALA.maxAccesiblesPorRegistro ?? 1;
  const ACCESIBLES = new Set(SALA.accesibles || []);
  const TIPOS = CFG.discapacidades || {};

  const MENSAJES = {
    DATOS_INVALIDOS: 'Revisa los datos marcados en rojo.',
    ASIENTO_OCUPADO: 'Uno de los asientos que elegiste acaba de ocuparse. Elige otro; el plano ya está actualizado.',
    CORREO_DUPLICADO: 'Ese correo ya tiene un registro. Recupera tus boletos en «Mi lugar».',
    TELEFONO_DUPLICADO: 'Ese número de WhatsApp ya tiene un registro. Recupera tus boletos en «Mi lugar».',
    CUPO_LLENO: `Ya no quedan lugares: los ${TOTAL} asientos están reservados.`,
    LUGARES_INSUFICIENTES: 'No quedan suficientes lugares libres para esa cantidad. Prueba con menos lugares.',
    ACCESIBLE_NO_PERMITIDO: 'Los lugares accesibles (♿) son solo para personas con discapacidad. Marca «Requiero un lugar accesible» e indica el tipo, o elige otro asiento.',
    ACCESIBLES_EXCEDIDOS: `Cada registro puede apartar como máximo ${MAX_ACC} lugar accesible.`,
    NO_ENCONTRADO: 'No encontramos un registro con esos datos. Revisa el folio y el correo.',
    CREDENCIALES_INVALIDAS: 'Usuario o contraseña incorrectos.',
    SESION_INVALIDA: 'Tu sesión terminó. Vuelve a iniciar sesión.',
    SIN_CONEXION: 'No hay conexión a Internet. Conéctate y vuelve a intentarlo; tus datos siguen aquí.',
    ERROR_SERVIDOR: 'El servidor no respondió. Espera unos segundos y vuelve a intentarlo.'
  };

  class ErrorDatos extends Error {
    constructor(codigo) {
      super(MENSAJES[codigo] || MENSAJES.ERROR_SERVIDOR);
      this.name = 'ErrorDatos';
      this.codigo = MENSAJES[codigo] ? codigo : 'ERROR_SERVIDOR';
    }
  }

  /* ---------- Asientos ---------- */
  const dos = (n) => String(n).padStart(2, '0');
  const idAsiento = (mesa, lugar) => `M${dos(mesa)}-A${dos(lugar)}`;
  function partesAsiento(id) {
    const m = /^M(\d{2})-A(\d{2})$/.exec(id || '');
    if (!m) return null;
    const mesa = Number(m[1]);
    const lugar = Number(m[2]);
    return mesa >= 1 && mesa <= MESAS && lugar >= 1 && lugar <= POR_MESA ? { mesa, lugar } : null;
  }
  function todosLosAsientos() {
    const lista = [];
    for (let m = 1; m <= MESAS; m++) for (let l = 1; l <= POR_MESA; l++) lista.push(idAsiento(m, l));
    return lista;
  }
  const esAccesible = (id) => ACCESIBLES.has(id);
  const textoAsiento = (id) => { const p = partesAsiento(id); return p ? `Mesa ${p.mesa}, asiento ${p.lugar}` : id; };

  /* ---------- Validación (misma regla que _normalizar() en SQL) ---------- */
  const RE_NOMBRE = /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ' .-]{3,80}$/;
  const RE_CORREO = /^[a-z0-9._%+-]+@gmail\.com$/;   // solo cuentas Gmail

  /** Deja el teléfono en 10 dígitos; quita la lada del país si sobra (BUG-01 v1). */
  function limpiarTelefono(valor) {
    const d = String(valor || '').replace(/\D/g, '');
    const lada = String(CFG.whatsapp.ladaPais || '');
    if (lada && d.length === lada.length + 10 && d.startsWith(lada)) return d.slice(lada.length);
    if (lada && d.length === lada.length + 11 && d.startsWith(lada + '1')) return d.slice(lada.length + 1);
    return d;
  }
  function normalizar(d) {
    const asientos = Array.isArray(d.asientos) ? d.asientos.filter(Boolean) : (d.asiento ? [d.asiento] : []);
    const discapacidad = d.discapacidad ? String(d.discapacidad) : null;
    return {
      nombre: String(d.nombre || '').trim().replace(/\s+/g, ' '),
      correo: String(d.correo || '').trim().toLowerCase(),
      telefono: limpiarTelefono(d.telefono),
      cantidad: Number.parseInt(d.cantidad ?? (asientos.length || 1), 10),
      asientos,
      discapacidad,
      discapacidad_detalle: discapacidad ? String(d.discapacidad_detalle || '').trim().replace(/\s+/g, ' ') || null : null
    };
  }
  function validar(datos) {
    const d = normalizar(datos);
    const e = {};
    if (!d.nombre) e.nombre = 'Escribe tu nombre.';
    else if (!RE_NOMBRE.test(d.nombre)) e.nombre = 'Usa solo letras y espacios (3 a 80 caracteres).';
    if (!d.correo) e.correo = 'Escribe tu correo.';
    else if (d.correo.length > 120 || !RE_CORREO.test(d.correo)) e.correo = 'Solo se aceptan correos de Gmail, por ejemplo: nombre@gmail.com';
    if (!d.telefono) e.telefono = 'Escribe tu número de WhatsApp.';
    else if (d.telefono.length !== 10) e.telefono = 'Deben ser 10 dígitos.';
    if (!Number.isInteger(d.cantidad) || d.cantidad < 1 || d.cantidad > MAX) e.cantidad = `Elige de 1 a ${MAX} lugares.`;
    if (d.discapacidad && !TIPOS[d.discapacidad]) e.discapacidad = 'Elige el tipo de discapacidad.';
    if (d.discapacidad === 'otra' && (!d.discapacidad_detalle || d.discapacidad_detalle.length < 3)) e.discapacidad_detalle = 'Describe brevemente la discapacidad.';
    if (d.discapacidad_detalle && d.discapacidad_detalle.length > 200) e.discapacidad_detalle = 'Máximo 200 caracteres.';
    if (d.asientos.some((id) => !partesAsiento(id)) || new Set(d.asientos).size !== d.asientos.length) e.asientos = 'Hay un asiento que no existe o está repetido.';
    else if (d.asientos.length > d.cantidad) e.asientos = `Elegiste más asientos (${d.asientos.length}) que lugares (${d.cantidad}).`;
    else {
      const acc = d.asientos.filter(esAccesible).length;
      if (acc && !d.discapacidad) e.asientos = MENSAJES.ACCESIBLE_NO_PERMITIDO;
      else if (acc > MAX_ACC) e.asientos = MENSAJES.ACCESIBLES_EXCEDIDOS;
    }
    return e;
  }
  /** Convierte el primer error de validación del servidor de reglas de asientos en su código */
  function codigoDeErrores(e) {
    if (e.asientos === MENSAJES.ACCESIBLE_NO_PERMITIDO) return 'ACCESIBLE_NO_PERMITIDO';
    if (e.asientos === MENSAJES.ACCESIBLES_EXCEDIDOS) return 'ACCESIBLES_EXCEDIDOS';
    return 'DATOS_INVALIDOS';
  }

  /**
   * Asignación de lugares (misma lógica que _asignar() en SQL):
   *  1. Se respetan los asientos elegidos.
   *  2. Si la persona pidió lugar accesible y no eligió uno, se le da el
   *     primer accesible libre (si hay; si no, uno normal).
   *  3. El resto se completa con asientos normales lo más cerca posible:
   *     misma mesa y asientos contiguos; si no hay ancla, la primera mesa
   *     donde quepa todo el grupo.
   */
  function asignar(ocupados, elegidos, cantidad, quiereAccesible) {
    const res = [...elegidos];
    const libre = (id) => !ocupados.has(id) && !res.includes(id);
    const distancia = (a, b) => { const x = Math.abs(a - b); return Math.min(x, POR_MESA - x); };
    let ancla = res.length ? partesAsiento(res[0]) : null;

    if (quiereAccesible && res.length < cantidad && !res.some(esAccesible)) {
      const cand = todosLosAsientos().filter((id) => esAccesible(id) && libre(id))
        .sort((a, b) => (ancla ? (partesAsiento(a).mesa !== ancla.mesa) - (partesAsiento(b).mesa !== ancla.mesa) : 0));
      if (cand.length) { res.push(cand[0]); ancla = ancla || partesAsiento(cand[0]); }
    }
    const faltan = cantidad - res.length;
    if (faltan <= 0) return res;

    const normales = todosLosAsientos().filter((id) => libre(id) && !esAccesible(id));
    if (normales.length < faltan) throw new ErrorDatos(ocupados.size >= TOTAL ? 'CUPO_LLENO' : 'LUGARES_INSUFICIENTES');
    if (!ancla) {
      for (let m = 1; m <= MESAS && !ancla; m++) {
        const enMesa = normales.filter((id) => partesAsiento(id).mesa === m);
        if (enMesa.length >= faltan) ancla = partesAsiento(enMesa[0]);
      }
    }
    const clave = (id) => {
      const p = partesAsiento(id);
      if (!ancla) return [0, p.mesa, p.lugar];
      return [p.mesa === ancla.mesa ? 0 : 1, Math.abs(p.mesa - ancla.mesa), p.mesa === ancla.mesa ? distancia(p.lugar, ancla.lugar) : p.lugar];
    };
    normales.sort((a, b) => { const x = clave(a); const y = clave(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || a.localeCompare(b); });
    return res.concat(normales.slice(0, faltan));
  }

  async function medir(etiqueta, fn) {
    const t0 = performance.now();
    try { return await fn(); }
    finally { console.info(`[Rendimiento] ${etiqueta}: ${Math.round(performance.now() - t0)} ms`); }
  }
  function hexAleatorio(bytes) {
    const b = new Uint8Array(bytes);
    crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
  }

  /* ======================================================================
     Adaptador DEMO (localStorage)
     ====================================================================== */
  // v2: un registro con varios boletos (las claves de la v1 se ignoran)
  const K = { registros: 'cm:v2:registros', accesos: 'cm:v2:accesos', secuencia: 'cm:v2:secuencia' };
  const leerLS = (k, def) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? def; } catch (e) { return def; } };
  const guardarLS = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { throw new ErrorDatos('ERROR_SERVIDOR'); } };
  // Credenciales del modo demo (en Supabase se guardan cifradas con bcrypt)
  const DEMO_ADMIN = { usuario: 'admin', clave: 'Conferencia2026!', nombre: 'Organización (demo)' };

  function ficha(r) {
    const boletos = r.boletos.map((b) => {
      const p = partesAsiento(b.asiento) || {};
      return { ...b, mesa: p.mesa, lugar: p.lugar, accesible: esAccesible(b.asiento) };
    }).sort((a, b) => a.numero - b.numero);
    return { ...r, boletos };
  }

  const Demo = {
    modo: 'demo',
    _todos() { const l = leerLS(K.registros, []); return Array.isArray(l) ? l : []; },
    _ocupados(ignorarId) {
      const s = new Set();
      this._todos().forEach((r) => { if (r.id !== ignorarId) r.boletos.forEach((b) => s.add(b.asiento)); });
      return s;
    },
    _revisar(entrada, ignorarId) {
      const e = validar(entrada);
      if (Object.keys(e).length) throw new ErrorDatos(codigoDeErrores(e));
      const d = normalizar(entrada);
      const otros = this._todos().filter((r) => r.id !== ignorarId);
      if (otros.some((r) => r.correo === d.correo)) throw new ErrorDatos('CORREO_DUPLICADO');
      if (otros.some((r) => r.telefono === d.telefono)) throw new ErrorDatos('TELEFONO_DUPLICADO');
      const ocupados = this._ocupados(ignorarId);
      if (d.asientos.some((id) => ocupados.has(id))) throw new ErrorDatos('ASIENTO_OCUPADO');
      return { d, ocupados };
    },
    async ocupados() { return this._ocupados(null); },
    async reservar(entrada, modo) {
      const { d, ocupados } = this._revisar(entrada, null);
      const asientos = asignar(ocupados, d.asientos, d.cantidad, Boolean(d.discapacidad));
      const lista = this._todos();
      const id = leerLS(K.secuencia, 0) + 1;
      const r = {
        id, folio: 'LOL-' + hexAleatorio(4),
        nombre: d.nombre, correo: d.correo, telefono: d.telefono,
        discapacidad: d.discapacidad, discapacidad_detalle: d.discapacidad_detalle,
        modo: modo || (d.asientos.length ? 'manual' : 'auto'), confirmado_whatsapp: false,
        creado_en: new Date().toISOString(),
        boletos: asientos.map((a, i) => ({ id: id * 100 + i + 1, numero: i + 1, asiento: a, codigo_qr: 'CMLOL-' + hexAleatorio(12), asistio_en: null }))
      };
      lista.push(r);
      guardarLS(K.registros, lista);
      guardarLS(K.secuencia, id);
      return ficha(r);
    },
    async consultar(folio, correo) {
      const f = String(folio || '').trim().toUpperCase();
      const c = String(correo || '').trim().toLowerCase();
      const r = this._todos().find((x) => x.folio === f && x.correo === c);
      return r ? ficha(r) : null;
    },
    async cancelar(folio, correo) {
      const r = await this.consultar(folio, correo);
      if (!r) throw new ErrorDatos('NO_ENCONTRADO');
      guardarLS(K.registros, this._todos().filter((x) => x.id !== r.id));
      return true;
    },
    admin: {
      _sesion() { if (!sessionStorage.getItem('cm:token')) throw new ErrorDatos('SESION_INVALIDA'); },
      async iniciar(usuario, clave) {
        if (String(usuario).trim().toLowerCase() !== DEMO_ADMIN.usuario || clave !== DEMO_ADMIN.clave) {
          throw new ErrorDatos('CREDENCIALES_INVALIDAS');
        }
        return { token: 'demo-' + hexAleatorio(16), nombre: DEMO_ADMIN.nombre };
      },
      async cerrar() { return true; },
      async resumen() {
        this._sesion();
        const l = Demo._todos();
        const boletos = l.flatMap((r) => r.boletos);
        return { cupo: TOTAL, ocupados: boletos.length, registros: l.length,
          asistieron: boletos.filter((b) => b.asistio_en).length, confirmados: l.filter((r) => r.confirmado_whatsapp).length,
          accesibles_libres: [...ACCESIBLES].filter((id) => !boletos.some((b) => b.asiento === id)).length };
      },
      async listar(buscar) {
        this._sesion();
        const q = String(buscar || '').trim().toLowerCase();
        return Demo._todos()
          .filter((r) => !q || [r.nombre.toLowerCase(), r.correo, r.folio.toLowerCase(), r.telefono].some((v) => v.includes(q)))
          .map(ficha)
          .sort((a, b) => a.boletos[0].asiento.localeCompare(b.boletos[0].asiento));
      },
      async registrar(d) { this._sesion(); return Demo.reservar(d, 'admin'); },
      async actualizar(id, entrada) {
        this._sesion();
        const lista = Demo._todos();
        const r = lista.find((x) => x.id === id);
        if (!r) throw new ErrorDatos('NO_ENCONTRADO');
        const datos = { ...entrada, cantidad: r.boletos.length };
        if ((entrada.asientos || []).length !== r.boletos.length) throw new ErrorDatos('DATOS_INVALIDOS');
        const { d } = Demo._revisar(datos, id);
        Object.assign(r, { nombre: d.nombre, correo: d.correo, telefono: d.telefono,
          discapacidad: d.discapacidad, discapacidad_detalle: d.discapacidad_detalle,
          confirmado_whatsapp: Boolean(entrada.confirmado_whatsapp) });
        r.boletos.sort((a, b) => a.numero - b.numero).forEach((b, i) => { b.asiento = d.asientos[i]; });
        guardarLS(K.registros, lista);
        return ficha(r);
      },
      async eliminar(id) {
        this._sesion();
        const l = Demo._todos();
        if (!l.some((r) => r.id === id)) throw new ErrorDatos('NO_ENCONTRADO');
        guardarLS(K.registros, l.filter((r) => r.id !== id));
        return true;
      },
      async validarQR(codigo) {
        this._sesion();
        const c = String(codigo || '').trim().toUpperCase();
        const lista = Demo._todos();
        let r = null; let b = null;
        lista.some((x) => { const y = x.boletos.find((z) => z.codigo_qr === c); if (y) { r = x; b = y; } return Boolean(y); });
        let resultado = 'NO_VALIDO';
        if (b && b.asistio_en) resultado = 'YA_INGRESO';
        else if (b) { resultado = 'VALIDO'; b.asistio_en = new Date().toISOString(); guardarLS(K.registros, lista); }
        const f = r ? ficha(r) : null;
        const boleto = f ? f.boletos.find((z) => z.codigo_qr === c) : null;
        const accesos = leerLS(K.accesos, []);
        accesos.unshift({ fecha: new Date().toISOString(), resultado, codigo_leido: c.slice(0, 120),
          nombre: f ? f.nombre : null, mesa: boleto ? boleto.mesa : null, lugar: boleto ? boleto.lugar : null,
          numero: boleto ? boleto.numero : null, total: f ? f.boletos.length : null });
        guardarLS(K.accesos, accesos.slice(0, 100));
        return { resultado, asistente: f, boleto };
      },
      async accesos() { this._sesion(); return leerLS(K.accesos, []).slice(0, 20); }
    }
  };

  /* ======================================================================
     Adaptador SUPABASE (API REST de PostgREST → funciones RPC)
     ====================================================================== */
  async function rpc(funcion, args) {
    if (!navigator.onLine) throw new ErrorDatos('SIN_CONEXION');
    const clave = CFG.supabase.clavePublica;
    const cab = { 'Content-Type': 'application/json', apikey: clave };
    if (clave.startsWith('eyJ')) cab.Authorization = 'Bearer ' + clave;   // claves «anon» antiguas (JWT)
    const control = new AbortController();
    const t = setTimeout(() => control.abort(), 10000);
    let res;
    try {
      res = await fetch(CFG.supabase.url.replace(/\/+$/, '') + '/rest/v1/rpc/' + funcion, {
        method: 'POST', headers: cab, body: JSON.stringify(args || {}), signal: control.signal
      });
    } catch (e) {
      throw new ErrorDatos(navigator.onLine ? 'ERROR_SERVIDOR' : 'SIN_CONEXION');
    } finally { clearTimeout(t); }
    const cuerpo = await res.json().catch(() => null);
    if (!res.ok) {
      console.error('[Supabase]', funcion, res.status, cuerpo);
      throw new ErrorDatos(cuerpo && typeof cuerpo.message === 'string' ? cuerpo.message : '');
    }
    return cuerpo;
  }
  const token = () => sessionStorage.getItem('cm:token') || '';
  function argumentos(entrada) {
    const e = validar(entrada);
    if (Object.keys(e).length) throw new ErrorDatos(codigoDeErrores(e));
    const d = normalizar(entrada);
    return { p_nombre: d.nombre, p_correo: d.correo, p_telefono: d.telefono, p_cantidad: d.cantidad,
      p_asientos: d.asientos, p_discapacidad: d.discapacidad, p_detalle: d.discapacidad_detalle };
  }

  const Supabase = {
    modo: 'supabase',
    async ocupados() { const l = await rpc('asientos_ocupados'); return new Set(Array.isArray(l) ? l : []); },
    async reservar(entrada) { return rpc('reservar_lugares', argumentos(entrada)); },
    consultar: (folio, correo) => rpc('consultar_registro', { p_folio: folio, p_correo: correo }),
    cancelar: (folio, correo) => rpc('cancelar_registro', { p_folio: folio, p_correo: correo }),
    admin: {
      iniciar: (usuario, clave) => rpc('admin_iniciar_sesion', { p_usuario: usuario, p_clave: clave }),
      cerrar: () => rpc('admin_cerrar_sesion', { p_token: token() }),
      resumen: () => rpc('admin_resumen', { p_token: token() }),
      listar: (buscar) => rpc('admin_listar', { p_token: token(), p_buscar: buscar || null }),
      async registrar(entrada) { return rpc('admin_registrar', { p_token: token(), ...argumentos(entrada) }); },
      async actualizar(id, entrada) {
        const a = argumentos({ ...entrada, cantidad: (entrada.asientos || []).length || 1 });
        delete a.p_cantidad;
        return rpc('admin_actualizar', { p_token: token(), p_id: id, ...a, p_confirmado: Boolean(entrada.confirmado_whatsapp) });
      },
      eliminar: (id) => rpc('admin_eliminar', { p_token: token(), p_id: id }),
      validarQR: (codigo) => rpc('admin_validar_qr', { p_token: token(), p_codigo: codigo }),
      accesos: () => rpc('admin_accesos', { p_token: token(), p_limite: 20 })
    }
  };

  /* ---------- Selección del adaptador ---------- */
  const base = CFG.supabase && CFG.supabase.url && CFG.supabase.clavePublica ? Supabase : Demo;
  const envolver = (obj, prefijo) => Object.fromEntries(Object.entries(obj)
    .filter(([k, v]) => typeof v === 'function' && !k.startsWith('_'))
    .map(([k, fn]) => [k, (...a) => medir(`${prefijo}${k}`, () => fn.apply(obj, a))]));

  const admin = envolver(base.admin, 'Panel: ');
  const iniciarOriginal = admin.iniciar;
  admin.iniciar = async (u, c) => {
    const s = await iniciarOriginal(u, c);
    sessionStorage.setItem('cm:token', s.token);
    sessionStorage.setItem('cm:admin', s.nombre);
    return s;
  };
  const cerrarOriginal = admin.cerrar;
  admin.cerrar = async () => {
    try { await cerrarOriginal(); } catch (e) { /* aunque falle, se borra la sesión local */ }
    sessionStorage.removeItem('cm:token');
    sessionStorage.removeItem('cm:admin');
  };
  admin.activa = () => Boolean(sessionStorage.getItem('cm:token'));
  admin.nombre = () => sessionStorage.getItem('cm:admin') || '';

  window.Datos = {
    modo: base.modo,
    ocupados: () => medir('Consultar asientos ocupados', () => base.ocupados()),
    reservar: (d) => medir('Guardar registro', () => base.reservar(d)),
    consultar: (f, c) => medir('Consultar boleto', () => base.consultar(f, c)),
    cancelar: (f, c) => medir('Cancelar registro', () => base.cancelar(f, c)),
    admin,
    validar, normalizar, limpiarTelefono, idAsiento, partesAsiento, todosLosAsientos,
    esAccesible, textoAsiento, asignar,
    TOTAL, MAX, MAX_ACC, TIPOS,
    ErrorDatos, MENSAJES
  };
})();
