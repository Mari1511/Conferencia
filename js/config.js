/* ==========================================================================
   config.js — Único archivo que hay que editar para adaptar el evento.
   Lo leen la página pública (index.html) y el panel (admin.html).
   ========================================================================== */
window.CONFIG = {

  evento: {
    nombre: 'Conferencia magistral',
    titulo: 'Cómo se gana una partida normal',
    tema: 'Mecánicas de League of Legends',
    fecha: 'Viernes 4 de diciembre de 2026',
    hora: '17:00 a 20:30 h',
    lugar: 'Auditorio principal',
    direccion: 'Edificio de Docencia, planta baja'
  },

  ponente: {
    nombre: 'Ponente invitado',
    cargo: 'Analista de partidas y entrenador de esports universitarios',
    bio: 'Revisa repeticiones con equipos amateur desde hace años. En esta charla '
       + 'desarma una partida normal minuto a minuto para explicar por qué se gana '
       + 'o se pierde, sin depender de reflejos ni de campeones de moda.'
  },

  /* Si cambias mesas o asientos, cambia también supabase/schema.sql (sección 2). */
  sala: { mesas: 10, asientosPorMesa: 10 },

  /* Número que recibe las confirmaciones: formato internacional sin «+».
     México: 52 + 10 dígitos, p. ej. '525512345678'.  ← CÁMBIALO */
  whatsapp: { numeroOrganizador: '525500000000', ladaPais: '52' },

  /* Vacío = MODO DEMOSTRACIÓN (datos en el navegador; panel: admin / Conferencia2026!).
     Con datos = base compartida en Supabase (ver README, sección 4). */
  supabase: {
    url: '',            // ej. 'https://abcdefghijkl.supabase.co'
    clavePublica: ''    // clave anon o publishable
  },

  refrescoSegundos: 20
};
