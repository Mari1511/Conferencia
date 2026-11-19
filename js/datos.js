/* ==========================================================================
   datos.js — Capa de datos (la usan index.html y admin.html)
   --------------------------------------------------------------------------
   Misma interfaz para dos «adaptadores»:
     • Demo     → localStorage del navegador (sin servidor, para probar y clase)
     • Supabase → PostgreSQL en la nube, por medio de las funciones RPC de
                  supabase/schema.sql (no se tocan tablas directamente)

   Público:  Datos.ocupados() · reservar(d) · consultar(folio, correo) · cancelar(folio, correo)
   Panel:    Datos.admin.iniciar(usuario, clave) · cerrar() · activa()
             resumen() · listar(buscar) · registrar(d) · actualizar(id, d)
             eliminar(id) · validarQR(codigo) · accesos()

   Los errores se lanzan como ErrorDatos con un código fijo; MENSAJES
   traduce cada código a un texto claro en español.
   ========================================================================== */
(function () {
  'use strict';

  const CFG = window.CONFIG;
  const MESAS = CFG.sala.mesas;
  const POR_MESA = CFG.sala.asientosPorMesa;

  const MENSAJES = {
    DATOS_INVALIDOS: 'Revisa los datos marcados en rojo.',
    ASIENTO_OCUPADO: 'Ese asiento acaba de ocuparse. Elige otro; el plano ya está actualizado.',
    CORREO_DUPLICADO: 'Ese correo ya tiene un lugar reservado. Recupera tu boleto en «Mi lugar».',
    TELEFONO_DUPLICADO: 'Ese número de WhatsApp ya tiene un lugar reservado. Recupera tu boleto en «Mi lugar».',
    CUPO_LLENO: 'Ya no quedan lugares: los 100 asientos están reservados.',
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
    return {
      nombre: String(d.nombre || '').trim().replace(/\s+/g, ' '),
      correo: String(d.correo || '').trim().toLowerCase(),
      telefono: limpiarTelefono(d.telefono),
      asiento: d.asiento || null
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
    if (d.asiento && !partesAsiento(d.asiento)) e.asiento = 'Ese asiento no existe.';
    return e;
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
  const K = { registros: 'cm:registros', accesos: 'cm:accesos', secuencia: 'cm:secuencia' };
  const leerLS = (k, def) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? def; } catch (e) { return def; } };
  const guardarLS = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { throw new ErrorDatos('ERROR_SERVIDOR'); } };
  // Credenciales del modo demo (en Supabase se guardan cifradas con bcrypt)
  const DEMO_ADMIN = { usuario: 'admin', clave: 'Conferencia2026!', nombre: 'Organización (demo)' };

  const Demo = {
    modo: 'demo',
    _todos() { const l = leerLS(K.registros, []); return Array.isArray(l) ? l : []; },
    _ficha(r) {
      const p = partesAsiento(r.asiento) || {};
      return { ...r, mesa: p.mesa, lugar: p.lugar };
    },
    _insertar(entrada, modo, ignorarId) {
      if (Object.keys(validar(entrada)).length) throw new ErrorDatos('DATOS_INVALIDOS');
      const d = normalizar(entrada);
      const lista = this._todos();
      const otros = lista.filter((r) => r.id !== ignorarId);
      if (otros.some((r) => r.correo === d.correo)) throw new ErrorDatos('CORREO_DUPLICADO');
      if (otros.some((r) => r.telefono === d.telefono)) throw new ErrorDatos('TELEFONO_DUPLICADO');
      const usados = new Set(otros.map((r) => r.asiento));
      let asiento = d.asiento;
      if (asiento) { if (usados.has(asiento)) throw new ErrorDatos('ASIENTO_OCUPADO'); }
      else { asiento = todosLosAsientos().find((id) => !usados.has(id)); if (!asiento) throw new ErrorDatos('CUPO_LLENO'); }
      return { d, lista, asiento };
    },
    async ocupados() { return new Set(this._todos().map((r) => r.asiento)); },
    async reservar(entrada, modo) {
      const { d, lista, asiento } = this._insertar(entrada, modo);
      const id = leerLS(K.secuencia, 0) + 1;
      const r = {
        id, folio: 'LOL-' + hexAleatorio(4), codigo_qr: 'CMLOL-' + hexAleatorio(12),
        nombre: d.nombre, correo: d.correo, telefono: d.telefono, asiento,
        modo: modo || (d.asiento ? 'manual' : 'auto'), confirmado_whatsapp: false,
        asistio_en: null, creado_en: new Date().toISOString()
      };
      lista.push(r);
      guardarLS(K.registros, lista);
      guardarLS(K.secuencia, id);
      return this._ficha(r);
    },
    async consultar(folio, correo) {
      const f = String(folio || '').trim().toUpperCase();
      const c = String(correo || '').trim().toLowerCase();
      const r = this._todos().find((x) => x.folio === f && x.correo === c);
      return r ? this._ficha(r) : null;
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
        return { cupo: MESAS * POR_MESA, registrados: l.length,
          asistieron: l.filter((r) => r.asistio_en).length, confirmados: l.filter((r) => r.confirmado_whatsapp).length };
      },
      async listar(buscar) {
        this._sesion();
        const q = String(buscar || '').trim().toLowerCase();
        return Demo._todos()
          .filter((r) => !q || [r.nombre.toLowerCase(), r.correo, r.folio.toLowerCase(), r.telefono].some((v) => v.includes(q)))
          .map((r) => Demo._ficha(r))
          .sort((a, b) => a.asiento.localeCompare(b.asiento));
      },
      async registrar(d) { this._sesion(); return Demo.reservar(d, 'admin'); },
      async actualizar(id, entrada) {
        this._sesion();
        const actual = Demo._todos().find((r) => r.id === id);
        if (!actual) throw new ErrorDatos('NO_ENCONTRADO');
        if (!partesAsiento(entrada.asiento)) throw new ErrorDatos('DATOS_INVALIDOS');
        const { d, lista, asiento } = Demo._insertar(entrada, 'admin', id);
        const r = lista.find((x) => x.id === id);
        Object.assign(r, { nombre: d.nombre, correo: d.correo, telefono: d.telefono, asiento,
          confirmado_whatsapp: Boolean(entrada.confirmado_whatsapp) });
        guardarLS(K.registros, lista);
        return Demo._ficha(r);
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
        const r = lista.find((x) => x.codigo_qr === c);
        let resultado = 'NO_VALIDO';
        if (r && r.asistio_en) resultado = 'YA_INGRESO';
        else if (r) { resultado = 'VALIDO'; r.asistio_en = new Date().toISOString(); guardarLS(K.registros, lista); }
        const accesos = leerLS(K.accesos, []);
        accesos.unshift({ fecha: new Date().toISOString(), resultado, codigo_leido: c.slice(0, 120),
          nombre: r ? r.nombre : null, mesa: r ? partesAsiento(r.asiento).mesa : null, lugar: r ? partesAsiento(r.asiento).lugar : null });
        guardarLS(K.accesos, accesos.slice(0, 100));
        return { resultado, asistente: r ? Demo._ficha(r) : null };
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

  const Supabase = {
    modo: 'supabase',
    async ocupados() { const l = await rpc('asientos_ocupados'); return new Set(Array.isArray(l) ? l : []); },
    async reservar(entrada) {
      if (Object.keys(validar(entrada)).length) throw new ErrorDatos('DATOS_INVALIDOS');
      const d = normalizar(entrada);
      return rpc('reservar_asiento', { p_nombre: d.nombre, p_correo: d.correo, p_telefono: d.telefono, p_asiento: d.asiento });
    },
    consultar: (folio, correo) => rpc('consultar_registro', { p_folio: folio, p_correo: correo }),
    cancelar: (folio, correo) => rpc('cancelar_registro', { p_folio: folio, p_correo: correo }),
    admin: {
      iniciar: (usuario, clave) => rpc('admin_iniciar_sesion', { p_usuario: usuario, p_clave: clave }),
      cerrar: () => rpc('admin_cerrar_sesion', { p_token: token() }),
      resumen: () => rpc('admin_resumen', { p_token: token() }),
      listar: (buscar) => rpc('admin_listar', { p_token: token(), p_buscar: buscar || null }),
      registrar(entrada) {
        if (Object.keys(validar(entrada)).length) return Promise.reject(new ErrorDatos('DATOS_INVALIDOS'));
        const d = normalizar(entrada);
        return rpc('admin_registrar', { p_token: token(), p_nombre: d.nombre, p_correo: d.correo, p_telefono: d.telefono, p_asiento: d.asiento });
      },
      actualizar(id, entrada) {
        if (Object.keys(validar(entrada)).length) return Promise.reject(new ErrorDatos('DATOS_INVALIDOS'));
        const d = normalizar(entrada);
        return rpc('admin_actualizar', { p_token: token(), p_id: id, p_nombre: d.nombre, p_correo: d.correo,
          p_telefono: d.telefono, p_asiento: d.asiento, p_confirmado: Boolean(entrada.confirmado_whatsapp) });
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
    ErrorDatos, MENSAJES
  };
})();
