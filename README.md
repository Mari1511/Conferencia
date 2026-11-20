# Conferencia magistral «Cómo se gana una partida normal»

Sistema web de gestión para una conferencia magistral sobre las mecánicas de League of Legends.
Publica la información del evento, registra asistentes, administra una base de datos, asigna
lugares dentro del recinto (100 lugares en 10 mesas) y genera códigos QR para identificar y
validar a cada asistente en la entrada. La confirmación de asistencia se hace por WhatsApp.

Cada persona puede reservar **de 1 a 5 lugares** (ella y sus acompañantes) y elegirlos en el plano
como en el cine; cada lugar tiene **su propio boleto con QR**. Hay **8 lugares accesibles ♿**
reservados para personas con discapacidad: solo se pueden apartar indicando el tipo de discapacidad.

| Página | Para quién | Qué hace |
|---|---|---|
| `index.html` | Asistentes | Inicio, Temas, Registro (varios lugares y accesibilidad) con plano de asientos, Boletos con QR, Mi lugar |
| `admin.html` | Organización | Inicio de sesión, Asistentes (CRUD + CSV), Control de acceso con cámara |

- Diseño inspirado en los clientes de juego (azul noche, líneas doradas, turquesa para lo activo). Todo el arte es propio y en SVG: **no hay imágenes PNG ni JPG** en las páginas.
- Funciona sin servidor propio: se publica en **GitHub Pages** y guarda los datos en **Supabase** (PostgreSQL).
- Sin Supabase configurado funciona en **modo demostración** (datos en el navegador) para probar y presentar.

---

## 1. Probarlo en tu computadora

```bash
cd Conferencia
python -m http.server 8000
```
Abre `http://localhost:8000` (portal) y `http://localhost:8000/admin.html` (panel).

**Panel en modo demostración:** usuario `admin`, contraseña `Conferencia2026!`.

La cámara del control de acceso solo funciona en `localhost` o con `https` (GitHub Pages ya usa https).

## 2. Personalizar (`js/config.js`)

| Clave | Qué cambia |
|---|---|
| `evento.*` | Título, tema, fecha, hora, lugar y dirección |
| `ponente.*` | Nombre, cargo y biografía |
| `sala.mesas`, `sala.asientosPorMesa` | Tamaño del recinto (cámbialo también en `schema.sql`, sección 2) |
| `sala.maxPorRegistro` | Lugares que puede reservar una persona (5). En SQL: `evento.max_lugares_registro` |
| `sala.maxAccesiblesPorRegistro` | Lugares accesibles por registro (1). En SQL: `evento.max_accesibles_registro` |
| `sala.accesibles` | Asientos reservados para personas con discapacidad. En SQL: `update asientos set accesible = true …` |
| `discapacidades` | Tipos que se pueden indicar (deben coincidir con el `check` de `asistentes.discapacidad`) |
| `whatsapp.numeroOrganizador` | **Obligatorio cambiarlo.** Formato `52` + 10 dígitos, sin «+» |
| `supabase.url`, `supabase.clavePublica` | Vacíos = modo demo; con datos = base compartida |

## 3. Publicar en GitHub Pages

1. Crea un repositorio público y sube el **contenido** de esta carpeta (`index.html` en la raíz).
2. *Settings → Pages → Deploy from a branch*, rama `main`, carpeta `/ (root)`.
3. En 1–2 minutos queda en `https://TU-USUARIO.github.io/REPOSITORIO/` y el panel en `…/admin.html`.

## 4. Conectar la base de datos (Supabase)

1. Crea un proyecto gratuito en <https://supabase.com>.
2. *SQL Editor* → pega **todo** `supabase/schema.sql` → *Run*. (Volver a ejecutarlo borra los registros.)
3. *Project Settings → API*: copia la **Project URL** y la clave **anon/publishable** en `js/config.js`.
4. Entra al panel con `admin` / `Conferencia2026!` y **cambia la contraseña**:
   ```sql
   update public.administradores
      set clave_hash = extensions.crypt('TuClaveNueva', extensions.gen_salt('bf'))
    where usuario = 'admin';
   ```
5. Para el personal de la puerta puedes crear otra cuenta (ver el final de `schema.sql`).

**¿Es seguro dejar la clave pública en el código?** Sí. Las 8 tablas tienen RLS sin políticas: con esa
clave no se pueden leer ni modificar. La página solo ejecuta funciones que validan todo en el servidor,
y las del panel exigen un token de sesión obtenido con usuario y contraseña (bcrypt).

### Modelo de datos

`evento` 1—N `mesas` 1—N `asientos` 1—0..1 `boletos` N—1 `asistentes`
· `boletos` 1—N `accesos` N—1 `administradores` 1—N `sesiones_admin`

- **asistentes**: la persona que reserva (correo Gmail, WhatsApp y, si pide lugar accesible, `discapacidad` y `discapacidad_detalle`).
- **boletos**: uno por lugar (1 a 5 por asistente), cada uno con su asiento y su `codigo_qr`.
- **asientos.accesible**: marca los lugares ♿.

Restricciones: correo, teléfono, folio, asiento por boleto y código QR únicos; solo correos `@gmail.com`;
teléfono de 10 dígitos; tipo de discapacidad válido y detalle obligatorio si es «otra»; un **trigger**
impide asignar un lugar accesible a quien no indicó discapacidad; máximo 5 lugares y 1 accesible por
registro; asignación con `FOR UPDATE SKIP LOCKED` y reintento. Diagrama completo en
`docs/diagramas/entidad_relacion.svg`.

### Correo de confirmación (EmailJS)

GitHub Pages no tiene servidor, así que el correo se envía con [EmailJS](https://www.emailjs.com)
(plan gratuito: 200 correos al mes). Sin configurarlo, el sitio funciona igual pero no manda correos.

1. Crea una cuenta en EmailJS → *Email Services → Add New Service* → **Gmail** → conecta tu cuenta.
   Copia el **Service ID**.
2. *Email Templates → Create New Template*. En **To Email** escribe `{{to_email}}` y en **Subject**
   `Tus lugares en la conferencia (folio {{folio}})`. En el contenido puedes usar:
   `{{to_name}}`, `{{evento}}`, `{{cantidad}}` (número de lugares), `{{lugares}}` (lista de mesa y asiento),
   `{{codigos}}` (código de cada boleto), `{{accesibilidad}}`, `{{folio}}`, `{{fecha}}`, `{{hora}}`,
   `{{lugar}}`, `{{enlace}}` (recuperar boletos) y `{{whatsapp}}` (contacto). Guarda y copia el **Template ID**.
3. *Account → General*: copia la **Public Key**.
4. Pega los tres valores en `js/config.js` → `correo`.
5. Opcional: *Account → Security → Allowed origins*: `https://mari1511.github.io` para que nadie más use tu cuenta.

## 5. Cómo funciona

**Asistente:** Registro → escribe nombre, correo Gmail y WhatsApp → indica **cuántos lugares** necesita
(1 a 5) → si alguien requiere lugar accesible marca la casilla y elige el **tipo de discapacidad**
(silla de ruedas, motriz, visual, auditiva u otra, con detalles) → asignación automática (lugares juntos;
el accesible para quien lo pidió y los acompañantes a su lado) o los elige en el plano como en el cine
(los lugares azules ♿ están bloqueados si no indicó discapacidad) → recibe **un boleto con QR único por
lugar** (`CMLOL-` + 24 caracteres aleatorios) → toca
«Confirmar con el organizador» (se abre WhatsApp con el mensaje ya escrito) → recibe la confirmación por
correo (si EmailJS está configurado) → puede **compartir su boleto como imagen por WhatsApp** (en el
celular se abre el menú de compartir con la imagen; en la computadora se descarga y se abre WhatsApp) →
si lo pierde, lo recupera en «Mi lugar» con folio y correo. En todo el portal hay un botón flotante
«¿Dudas? Escríbenos» que abre un chat de WhatsApp con el organizador.

**Organización:** consulta y busca registros (con todos sus lugares y la accesibilidad), da de alta con
uno o varios lugares, edita, reasigna el asiento de cada boleto, marca quién confirmó por WhatsApp,
elimina y exporta a CSV (una fila por boleto). En **Control de acceso** lee el QR con la cámara (jsQR),
desde una foto o escribiendo el código: responde *Acceso válido*, *Ya ingresó* o *Código no válido*,
indica qué boleto es («boleto 2 de 3, acompañante») y, si el registro indicó discapacidad, muestra el
apoyo que necesita.

> WhatsApp: que WhatsApp registre a alguien por sí solo requiere la API de pago de WhatsApp Business y un
> servidor. Por eso se usa un enlace `wa.me` con el mensaje listo, y el organizador marca la confirmación.

## 6. Estructura

```
index.html · admin.html
css/estilos.css            Guía visual completa (variables, componentes, celular, impresión)
js/config.js               Configuración
js/datos.js                Validación + adaptador demo (localStorage) + adaptador Supabase (RPC)
js/comun.js                Navegación por pestañas, QR, avisos
js/compartir.js            Imagen del boleto, compartir por WhatsApp, correo (EmailJS)
js/sala.js                 Plano de mesas (selección múltiple y lugares accesibles)
js/app.js · js/admin.js    Lógica del portal y del panel
js/vendor/                 qrcode-generator 1.4.4 (MIT) · jsQR 1.4.0 (Apache 2.0)
fonts/                     Marcellus y Barlow (SIL OFL)
supabase/schema.sql        Base de datos · pruebas_crud.sql: evidencias CRUD
pruebas/                   evidencias_crud.txt, tablas.txt, estructura_asistentes.txt, evidencias/ (y pruebas_e2e.py de la v1)
docs/diagramas/            Casos de uso, entidad-relación, navegación, arquitectura
docs/diseno/               Wireframes, guía de estilo, mockups
docs/entregas/             Documentos Word de las etapas 1 a 5
```

## 7. Pruebas

> `pruebas_e2e.py` y sus resultados corresponden a la **versión 1** (un lugar por persona, cualquier correo).
> La versión 2 se probó con el portal, el panel y `supabase/pruebas_crud.sql` (salida en
> `pruebas/evidencias_crud.txt`).

```bash
pip install playwright opencv-python psycopg2-binary
python -m playwright install chromium        # y ffmpeg instalado para la cámara simulada
python pruebas/pruebas_e2e.py                 # modo demo
python pruebas/pruebas_e2e.py --pg "host=localhost dbname=pruebas user=postgres"   # + base real
```
Para `--pg` usa una base de **prueba** y crea antes los roles de Supabase:
`create role anon nologin; create role authenticated nologin; grant usage on schema public to anon, authenticated;`

## 8. Entregables por etapa

| Etapa | Documento | Archivos de apoyo |
|---|---|---|
| 1. Análisis y planeación | `docs/entregas/Etapa1_Analisis_y_planeacion.docx` | `docs/diagramas/casos_de_uso.svg` |
| 2. Diseño UI/UX | `Etapa2_Diseno_UI_UX.docx` | `docs/diseno/wireframes.html`, `guia_estilo.html`, `mockup_*.png`, `docs/diagramas/navegacion.png` |
| 3. Base de datos | `Etapa3_Base_de_datos.docx` | `supabase/schema.sql`, `pruebas_crud.sql`, `pruebas/evidencias_crud.txt` |
| 4. Desarrollo | `Etapa4_Desarrollo.docx` | Código fuente completo |
| 5. Pruebas | `Etapa5_Pruebas_y_validacion.docx` | `pruebas/` |

Prototipo de navegación: la propia aplicación (HTML) es navegable. Si se pide en Figma, importa los
`mockup_*.png` como marcos y únelos con *Prototype → On click → Navigate to* según `navegacion.png`.

## 9. Créditos

qrcode-generator © Kazuhiko Arase (MIT) · jsQR © Cosmo Wolfe (Apache 2.0) · Marcellus © Astigmatic
y Barlow © Jeremy Tribby (SIL OFL 1.1). Evento académico independiente: no está afiliado ni patrocinado
por Riot Games. League of Legends es una marca registrada de Riot Games, Inc.
