# Seguridad · Resguardo de herramienta Citrojugo

Este documento explica cómo está protegida la aplicación y cómo ponerla en línea paso a paso.

## 1. Idea general

La página (lo que se publica en GitHub Pages) es **pública**: cualquiera puede ver su código. Eso está bien, porque **la página ya no contiene datos**. Los colaboradores, los NIP, el catálogo y los resguardos viven en una base de datos (Supabase) que:

- no entrega nada a quien no haya iniciado sesión con una cuenta **activa**;
- guarda los NIP **cifrados con bcrypt** en un área privada que nadie puede leer desde la página;
- revisa dentro de la base **quién** pide cada acción (almacén, supervisor o administrador) y la rechaza si no le corresponde, aunque alguien modifique el código de la página;
- anota cada movimiento en una **bitácora** que no se puede editar ni borrar.

```
Navegador (GitHub Pages)  ──HTTPS──▶  Supabase
  index.html, app.js                    Auth (correo + contraseña)
  config.js (URL + clave pública)       PostgreSQL con Row Level Security
  sin datos, sin NIP                    Funciones que validan rol y NIP
```

## 2. Modelo de amenazas (breve)

| Quién | Qué podría intentar | Qué lo detiene |
|---|---|---|
| Cualquier persona en internet | Descargar la lista de colaboradores, los NIP o los resguardos | La página no trae datos. La clave `anon` sin sesión no tiene permiso sobre ninguna tabla ni función. |
| Cualquier persona en internet | Adivinar contraseñas | Supabase Auth limita los intentos por IP. La página también frena después de 5 fallos. |
| Alguien que se registre por su cuenta (si dejaste el registro abierto) | Entrar | Toda cuenta nueva nace **inactiva** y sin datos visibles; solo el admin la activa. Además, la guía cierra el registro público. |
| Usuario de almacén con sesión | Adivinar el NIP de un colaborador (4 dígitos = 10,000 combinaciones) | La base compara el NIP con bcrypt. Bloquea al colaborador tras 5 fallos (15 min, y el doble en cada bloqueo seguido, hasta 24 h). Limita cada cuenta a 20 NIP fallidos por hora y 40 por día. Todo queda en la bitácora. |
| Usuario de almacén con sesión | Quitar herramienta sin NIP, dar de baja colaboradores o cambiar NIP | Esas funciones exigen rol supervisor/admin **y** que la contraseña se haya escrito hace menos de 5 minutos. Las tablas no aceptan escrituras directas. (Las **devoluciones** sí las puede registrar almacén con su sesión; quedan firmadas a su nombre en la bitácora.) |
| Usuario de almacén o supervisor con sesión | Cambiar el rol, activar/desactivar o editar cualquier cuenta, incluida la suya | Solo un admin puede hacerlo: la función lo exige y, además, un candado (*trigger*) en la tabla de perfiles rechaza cualquier cambio de rol, estado o nombre hecho con una sesión que no sea de admin. |
| Alguien con acceso a la PC del almacén | Leer NIP o contraseñas guardadas en el navegador | El navegador ya no guarda datos. Solo se guarda un token de sesión en `sessionStorage`, que se borra al cerrar el navegador. La sesión se cierra sola tras 30 min sin actividad. |
| Un sitio malicioso | Mostrar la app dentro de un iframe para engañar clics | La app se niega a correr dentro de un iframe. |
| Inyección de código (XSS) a través de nombres o notas | Ejecutar JavaScript en la sesión de otro usuario | Todo texto pasa por `esc()`. Los ids que vienen del servidor se validan como UUID. La CSP prohíbe scripts externos o en línea y `eval`. |

## 3. Qué protege cada medida

| Problema anterior | Solución |
|---|---|
| `SEED_DATA` (385 colaboradores con NIP en texto plano, 4,300 herramientas, 5,200 resguardos) dentro del HTML | Eliminado. **Arranque en blanco**: no se migra nada de la versión anterior. Colaboradores y catálogo se cargarán desde los Excel oficiales (`tools/importar_colaboradores.py`, `tools/importar_herramientas.py`), que se ejecutan en tu PC y **no se publican**. |
| Todo en `localStorage`, sin respaldo central | Base de datos central (Supabase, PostgreSQL). Respaldo con `tools/respaldo.py`. El botón "Descargar respaldo" en Usuarios rescata lo que quedó en cada PC. |
| El NIP se comparaba en el navegador | La función `crear_resguardo` de la base verifica el NIP y crea los resguardos en una sola transacción. El navegador nunca ve el NIP ni su hash. |
| Cuenta `admin / admin123` y respaldo `plain:` | No hay cuentas por defecto ni contraseñas en el código. Las contraseñas las maneja Supabase Auth (bcrypt en el servidor). |
| Roles y permisos solo en el navegador | Row Level Security y funciones `SECURITY DEFINER` con `search_path` fijo. El navegador solo decide qué botones mostrar; la base decide qué se permite. |
| Sin límite de intentos | Bloqueo por colaborador y límite por cuenta (NIP). Límite de Supabase Auth (contraseñas). Todo registrado en la bitácora. |
| Contraseña del supervisor revisada en el navegador | Para quitar sin NIP, dar de baja, cambiar NIP o administrar cuentas, el supervisor (o admin) escribe su correo y contraseña. La página abre con ellos una sesión **temporal** de Supabase, la base comprueba su rol y que la contraseña se acaba de escribir, ejecuta la acción a su nombre y la sesión se cierra. Así se conserva el flujo de siempre (el supervisor autoriza en la PC del almacén sin que nadie cierre sesión), pero ahora la validación es real y la acción queda firmada por él en la bitácora. |
| Devoluciones solo con supervisor (lento en el día a día) | Las devoluciones las registra quien tenga la sesión iniciada (almacén, supervisor o admin) tras una confirmación. La base valida que la cuenta esté activa y guarda en la bitácora **quién** devolvió, **cuándo**, qué herramienta y de qué colaborador. |
| Colaboradores identificados solo por nombre | Cada colaborador tiene **número de empleado** (único, obligatorio en altas). Se puede buscar y registrar resguardos por número; si un nombre se repite, la app pide el número. |
| Bajas de colaborador sin control | La baja siempre la autoriza un supervisor. Es una baja lógica: el historial se conserva. Si almacén pudiera dar de baja y volver a dar de alta a alguien, podría ponerle un NIP que conoce. |

### Roles

| Rol | Puede |
|---|---|
| **almacen** | Ver todo, registrar resguardos (con el NIP del colaborador), **registrar devoluciones** (con su sesión), dar de alta colaboradores (con número de empleado y NIP), agregar o quitar herramientas del catálogo y corregir la fecha de entrega. **No** puede tocar ninguna cuenta de usuario (ni la suya). |
| **supervisor** | Todo lo anterior, además de quitar herramienta sin NIP, dar de baja colaboradores y asignar, cambiar o desbloquear NIP. Tampoco puede tocar cuentas de usuario. |
| **admin** | Todo lo anterior, además de activar o desactivar cuentas, cambiar roles y ver la bitácora. |

¿Por qué "quitar sin NIP", la baja y el cambio de NIP siguen en supervisor? Porque con ellas alguien de almacén podría cerrar un resguardo sin que nadie lo note, o ponerle a un colaborador un NIP que conoce y firmar préstamos a su nombre. Una devolución normal no tiene ese riesgo: queda firmada por quien la registró.

## 4. Riesgos que quedan (y cómo reducirlos)

1. **El NIP tiene solo 4 dígitos.** Con el bloqueo, adivinarlo es muy lento (5 intentos cada 15 min o más, y cada intento queda registrado). Aun así, alguien que vea al colaborador teclearlo lo conoce. Revisa la bitácora (consulta en la sección 9).
2. **Los NIP del HTML anterior ya no son secretos** si ese archivo se compartió o publicó. Por eso no se reutilizan: el sistema arranca en blanco y cada colaborador recibe un NIP **nuevo** asignado por un supervisor. Al asignarlos, no repitas los NIP viejos.
3. **Colaboradores importados del Excel quedan sin NIP** hasta que un supervisor se lo asigne. Es intencional: no existe un NIP "por defecto" que alguien pueda adivinar (como 0000), y la base rechaza cualquier préstamo a su nombre mientras no lo tengan. Planea una jornada para asignarlos.
4. **Almacén puede registrar devoluciones.** Alguien de almacén podría marcar como devuelta una herramienta que no regresó. Queda su nombre en la bitácora y en la tarjeta ("Devolvió: …"); revisa la bitácora periódicamente (sección 9).
5. **Cualquier usuario activo puede leer todos los datos** (es necesario para trabajar). Activa solo a quien lo necesite y desactiva cuentas cuando alguien deje el puesto.
6. **Una PC infectada** (por ejemplo, con un capturador de teclas) puede robar contraseñas. Ningún sitio web lo evita. Mantén Windows actualizado y usa contraseñas distintas para cada servicio.
7. **`style-src 'unsafe-inline'`** en la CSP: la app usa estilos en línea (`style="..."`), así que no se pueden prohibir. El riesgo es bajo, porque no se puede ejecutar JavaScript con estilos y todo texto se escapa con `esc()`. Si en el futuro todos los estilos pasan a clases, se puede quitar.
8. **GitHub Pages no permite cabeceras HTTP.** La CSP va en una etiqueta `<meta>`, y `frame-ancestors` no funciona ahí. Por eso la app se protege del iframe con código. Si algún día usas Cloudflare Pages o Netlify, agrega las cabeceras de verdad.
9. **El plan gratuito de Supabase** pausa el proyecto tras 7 días sin uso y no ofrece respaldos descargables. Con uso diario no se pausa. Haz respaldos con `tools/respaldo.py`.
10. **La `service_role` key** da acceso total. Solo debe existir en tu PC al importar o respaldar. Si se filtra, cámbiala de inmediato (Supabase → Settings → API Keys → Roll / Revoke).

## 5. Guía paso a paso para Omar

> Tiempo aproximado: 45 minutos la primera vez. No necesitas saber programar.

### Paso 1 · Crear el proyecto de Supabase (gratis)

1. Entra a <https://supabase.com> → **Start your project** y crea una cuenta. Puedes usar tu GitHub.
2. **New project**:
   - *Name*: `citrojugo-resguardos`
   - *Database password*: genera una larga y guárdala en tu gestor de contraseñas. No la vas a usar en la app.
   - *Region*: la más cercana (por ejemplo, *East US*).
   - Plan **Free**.
3. Espera 1 o 2 minutos a que termine de crearse.

### Paso 2 · Crear las tablas y la seguridad

1. Menú izquierdo → **SQL Editor** → **New query**.
2. Abre `supabase/schema.sql`, copia **todo** el contenido, pégalo y presiona **Run**.
3. Debe decir *Success. No rows returned*. Si lo vuelves a ejecutar más adelante (por una actualización), no se pierden datos.

### Paso 3 · Cerrar el registro público y ajustar Auth

1. **Authentication → Sign In / Providers** (en versiones anteriores: *Providers → Email*):
   - Deja **Email** activado.
   - **Desactiva "Allow new users to sign up"**. Así nadie puede crearse una cuenta por su cuenta.
2. **Authentication → Policies / Passwords** (si aparece): longitud mínima de **10** caracteres.
3. **Authentication → URL Configuration → Site URL**: pon la dirección de GitHub Pages del Paso 7 (por ejemplo, `https://omar.github.io/resguardos/`). Hace falta para las invitaciones por correo.

### Paso 4 · Crear tu cuenta de administrador

1. **Authentication → Users → Add user → Create new user**.
   - Tu correo y una contraseña fuerte. Marca **Auto Confirm User**.
2. **SQL Editor → New query**, cambia el correo y ejecuta:
   ```sql
   update public.perfiles
      set rol = 'admin', activo = true, nombre = 'Omar'
    where email = 'tu-correo@ejemplo.com';
   ```
3. Debe decir *1 row affected*.

### Paso 5 · Configurar la página

1. Supabase → **Project Settings → API** (o **Data API** y **API Keys**). Copia:
   - **Project URL**, algo como `https://abcdxyz.supabase.co`.
   - La clave **anon public** (o **publishable**). **No** copies la `service_role` / `secret`.
2. Abre `config.js` con el Bloc de notas y reemplaza:
   ```js
   supabaseUrl: "https://abcdxyz.supabase.co",
   supabaseAnonKey: "eyJhbGciOi...la clave anon...",
   ```
3. Guarda.

### Paso 6 · Guardar los datos anteriores e importar los Excel oficiales

El sistema nuevo **arranca en blanco**: no se suben colaboradores, resguardos ni catálogo de la versión anterior.

**6a. Guarda tu copia de la versión anterior** (si la usaste):
1. En cada PC donde se usó, abre la **nueva** app ya publicada (Paso 7) en **ese mismo navegador**, inicia sesión como admin, entra a **Usuarios** y presiona **Descargar respaldo (JSON)**. (Si el HTML viejo se abría como archivo `file://`, copia `index.html`, `app.js`, `config.js` y `logo.png` a una carpeta de esa PC y abre `index.html` desde ahí para ver el botón.)
2. Opcional, para revisar que la copia esté completa (no necesita claves ni internet):
   ```powershell
   python migrar.py --respaldo "C:\ruta\respaldo-resguardos-2026-10-24.json" --html "C:\ruta\resguardos.html"
   ```
   Solo muestra un resumen. Con `--excel-referencia historial.xlsx` también genera un Excel de consulta, **sin NIP**.
3. Guarda el JSON y el HTML viejo en una USB o carpeta privada (**contienen NIP**) y bórralos de las computadoras. En cada PC, presiona **Borrar de este navegador** (Usuarios).

**6b. Cuando tengas los Excel oficiales, impórtalos** (necesitas Python 3 de <https://www.python.org/downloads/>; la primera vez ejecuta `python -m pip install openpyxl`):

*Colaboradores* — el Excel debe tener una columna de **número de empleado** y una de **nombre**; *área* y *puesto* son opcionales. Los títulos pueden variar ("No. de empleado", "Nómina", "Clave", "Nombre completo", "Departamento"…) y la fila de títulos no tiene que ser la primera.
```powershell
cd tools
python importar_colaboradores.py "C:\ruta\colaboradores.xlsx" --simular
```
Revisa el reporte (`reporte-colaboradores.txt`): filas sin número o sin nombre, números con caracteres raros, números repetidos (solo se toma la primera aparición) y nombres repetidos con números distintos (se permiten, pero conviene revisarlos). Corrige el Excel si hace falta y luego súbelo:
```powershell
$env:SUPABASE_URL = "https://abcdxyz.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY = "pega-aqui-la-service-role"
python importar_colaboradores.py "C:\ruta\colaboradores.xlsx"
```
- Puedes repetirlo sin duplicar a nadie (el número de empleado es único). Si cambió el nombre, área o puesto de alguien, usa `--actualizar`.
- **Los colaboradores importados quedan SIN NIP.** Antes de su primer préstamo, un supervisor debe asignárselo: Colaboradores → busca por número → **NIP** → el colaborador elige 4 dígitos y los teclea dos veces → el supervisor confirma con su correo y contraseña. Mientras tanto, la app muestra "NIP pendiente" y la base rechaza préstamos a su nombre.

*Catálogo de herramientas* (opcional) — columnas **nombre/descripción** e **ID de artículo/código** (opcional):
```powershell
python importar_herramientas.py "C:\ruta\catalogo.xlsx" --simular
python importar_herramientas.py "C:\ruta\catalogo.xlsx"
```
Si no importas catálogo, se va llenando solo: cada herramienta nueva que se presta se agrega automáticamente.

Al terminar, cierra PowerShell (la `service_role` key se borra con la ventana).

### Paso 7 · Publicar en GitHub Pages

1. En <https://github.com> → **New repository** → nombre `resguardos`. Público o privado: el código no tiene secretos. Con plan gratuito, Pages funciona en repos públicos.
2. Sube **solo** estos archivos (botón **Add file → Upload files**):
   - `index.html`
   - `app.js`
   - `config.js`
   - `logo.png`
   - `.gitignore`
   - `SEGURIDAD.md`
   - la carpeta `supabase/` (schema.sql; no tiene secretos)
   
   **No subas** `tools/`, `tests/`, `fusion/`, ningún `.json`, `.xlsx` ni reporte, ni el HTML viejo.
3. **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main` / root → Save.**
4. En 1 o 2 minutos aparece la dirección (`https://TU-USUARIO.github.io/resguardos/`). Ábrela e inicia sesión con tu correo de admin.
5. Si usas un **dominio propio**, la CSP de `index.html` ya permite `https://*.supabase.co`. No hay que cambiar nada.

### Paso 8 · Dar de alta a supervisores y personal de almacén

1. Supabase → **Authentication → Users → Add user**:
   - **Create new user** (tú le das una contraseña temporal) o
   - **Send invitation** (le llega un correo; necesita la *Site URL* del Paso 3).
2. En la app → **Usuarios**. Aparece la cuenta nueva como *desactivada*. Elige su **rol** y presiona **Activar**. Te pedirá tu correo y contraseña de admin.
3. Para quitar el acceso a alguien: **Desactivar**. Para borrarlo del todo: Supabase → Authentication → Users → ⋮ → Delete user.

> Nunca pongas la `service_role` key en la página ni en GitHub: con ella se pueden crear usuarios, pero también leer y borrar todo.

## 6. Uso diario

- **Nuevo resguardo**: escribe el **número de empleado** (o el nombre completo exacto). El colaborador teclea su NIP. Si se equivoca 5 veces, se bloquea 15 minutos. Un supervisor puede desbloquearlo antes en Colaboradores → **NIP** (le asigna uno nuevo).
- **Devolución**: en Activos, **Marcar devolución → Sí, devolver**. La registra quien tiene la sesión iniciada (almacén, supervisor o admin) y queda a su nombre en la bitácora.
- **Transferir herramienta de un colaborador a otro**: en Activos, **Transferir** en la tarjeta → escribe el número de empleado (o nombre) de quien la recibe → teclea su NIP **quien entrega** → teclea su NIP **quien recibe**. La base verifica los dos NIP (con el mismo bloqueo por intentos fallidos), cierra el resguardo anterior como "transferido a …" y crea uno nuevo a nombre de quien recibe, con nota "Transferido de …". Queda en la bitácora como `resguardo_transferido`. La puede registrar cualquier cuenta activa (almacén, supervisor o admin).
- **Quitar sin NIP, baja de colaborador o cambio de NIP**: el supervisor escribe **su correo** y contraseña en la ventana que aparece.
- **Buscar**: en Activos, Historial, Tabla y Colaboradores puedes buscar por nombre o por número de empleado.
- **Sin internet**: la app avisa y no guarda nada. Cuando vuelva la conexión, repite la operación. Un resguardo que se repite por un corte de red no se duplica.
- La sesión se cierra sola tras **30 minutos** sin uso (se cambia en `config.js`) o al cerrar el navegador.
- **Cambiar mi contraseña**: con la sesión iniciada, botón de la **llave** (junto a "Cerrar sesión", abajo en la barra lateral; en celular, arriba a la derecha). Pide la contraseña actual y la nueva dos veces (mínimo 10 caracteres). Recomienda a cada persona cambiar la contraseña inicial que le diste en su primer ingreso.

### Si alguien olvida su contraseña

La app no tiene "Olvidé mi contraseña": la restablece un administrador. En Supabase → **SQL Editor → New query**, cambia el correo y la contraseña temporal y ejecuta:

```sql
update auth.users
   set encrypted_password = extensions.crypt('Temporal-2026-cambiar', extensions.gen_salt('bf'))
 where email = 'correo@citrojugo.com.mx';
```

Debe decir *1 row affected*. Entrega la contraseña temporal en privado y pide a la persona que la cambie con el botón de la llave al entrar. (Ese query queda en el historial del SQL Editor: usa siempre una contraseña temporal, nunca la definitiva.)

Para quitarle el acceso a alguien (por ejemplo, si deja la empresa): en la app, **Usuarios → Desactivar**. Su historial se conserva.

## 7. Actualizaciones periódicas

1. **Cambios en la página** (diseño, textos, funciones): reemplaza `index.html` / `app.js` en GitHub (**Add file → Upload files**, mismo nombre). GitHub Pages se actualiza en 1 o 2 minutos. Pide a todos recargar con `Ctrl + F5`.
2. **Cambios en la base**: si una versión nueva trae un `supabase/schema.sql` actualizado, pégalo completo en el SQL Editor y ejecútalo. Está hecho para poder ejecutarse varias veces sin borrar datos.
3. **Antes de cada actualización**, haz un respaldo (siguiente sección).
4. **Cada mes**:
   - Revisa en Supabase → Authentication → Users que no haya cuentas desconocidas.
   - Revisa la bitácora (consulta de abajo).
   - Desactiva cuentas de quien ya no trabaje ahí.

## 8. Respaldos

1. PowerShell en `tools/`:
   ```powershell
   $env:SUPABASE_URL = "https://abcdxyz.supabase.co"
   $env:SUPABASE_SERVICE_ROLE_KEY = "..."
   python respaldo.py
   ```
2. Se crea `respaldo-AAAA-MM-DD.json` con todo: colaboradores, hashes de NIP, catálogo, resguardos, cuentas y bitácora. Guárdalo en una USB o carpeta privada. **No lo subas a GitHub.**
3. Hazlo cada semana y antes de cada actualización. Para restaurar, el archivo sirve como fuente para cargar los datos de nuevo (pide ayuda técnica).

## 9. Consultas útiles (SQL Editor)

```sql
-- Últimos 100 movimientos
select ts, usuario, accion, detalle from public.bitacora order by id desc limit 100;

-- NIP fallidos y bloqueos de los últimos 7 días
select ts, usuario, accion, detalle->>'colaborador' as colaborador
  from public.bitacora
 where accion in ('nip_incorrecto','nip_bloqueado','nip_limite_usuario')
   and ts > now() - interval '7 days'
 order by ts desc;

-- Colaboradores que aún no tienen NIP asignado
select numero_empleado, nombre, area from public.colaboradores where activo and nip_pendiente order by nombre;

-- Devoluciones de los últimos 30 días: quién, cuándo y qué
select ts, usuario, detalle->>'rol' as rol, detalle->>'colaborador' as colaborador, detalle->>'herramienta' as herramienta
  from public.bitacora where accion in ('resguardo_devuelto','resguardo_quitado','resguardo_transferido')
   and ts > now() - interval '30 days' order by ts desc;

-- Desbloquear a alguien (también se puede desde la app cambiando su NIP)
update app.colaborador_nip set intentos_fallidos = 0, bloqueos = 0, bloqueado_hasta = null
 where colaborador_id = (select id from public.colaboradores where numero_empleado = 'NUMERO' and activo);

-- Ajustes de seguridad (intentos, minutos de bloqueo, etc.)
select * from app.ajustes;
update app.ajustes set nip_max_intentos = 5, nip_bloqueo_minutos = 15;
```

## 10. Archivos del proyecto

| Archivo | ¿Se publica? | Para qué |
|---|---|---|
| `index.html` | Sí | Página y estilos. Incluye la CSP. |
| `app.js` | Sí | Lógica de la app. Habla con Supabase por HTTPS. |
| `config.js` | Sí | URL del proyecto y clave **anon** (pública). |
| `colaborador.html` | Sí | Portal del colaborador ("Soy Colaborador Citrojugo"). |
| `colaborador.js` | Sí | Lógica del portal. Solo llama a las funciones `colab_*`. |
| `logo.png` | Sí | Logo. |
| `supabase/schema.sql` | Sí (no tiene secretos) | Tablas, seguridad y funciones. |
| `SEGURIDAD.md` | Sí | Este documento. |
| `tools/migrar.py` | **No** | Revisa la copia de la versión anterior (no sube nada; no usa claves). |
| `tools/importar_colaboradores.py` | **No** | Importa colaboradores desde Excel (usa la service_role). |
| `tools/importar_herramientas.py` | **No** | Importa el catálogo desde Excel (usa la service_role). |
| `tools/excel_comun.py` | **No** | Funciones compartidas por los importadores. |
| `tools/respaldo.py` | **No** | Respaldo completo (usa la service_role). |
| `tests/` | **No** | Pruebas técnicas locales. |

## 11. Portal del colaborador ("Soy Colaborador Citrojugo")

Cada colaborador puede consultar desde su celular **solo sus** resguardos: lo que tiene hoy, desde cuándo, quién se lo entregó y todo su historial (entregas, devoluciones y transferencias). No puede modificar nada ni ver datos de nadie más.

**Cómo entra**

1. En la pantalla de inicio de la app, abajo, toca **Soy Colaborador Citrojugo** (o abre directamente `colaborador.html`).
2. **Primera vez**: número de empleado y, como contraseña, **el mismo número**. Eso no muestra ningún dato: solo abre una ventana de 10 minutos para crear su contraseña.
3. Para crearla escribe su **nombre completo como viene en la relación de colaboradores** (apellidos y nombre(s); no importan mayúsculas, acentos ni comas) y una contraseña de al menos 8 caracteres con una letra y un número.
4. Desde ese momento el número **ya no sirve** como contraseña.
5. Enseguida el portal le pide **crear su NIP** (4 números, con teclado y confirmación). Si el almacén ya le había asignado uno, puede conservarlo o cambiarlo.
6. Después puede **cambiar su NIP** desde la tarjeta "Tu NIP de almacén": teclea el actual y luego el nuevo dos veces. **Máximo un cambio cada 24 horas.**
7. Para cambiar su contraseña: botón de la llave → nombre completo + contraseña actual + la nueva.

**Contraseña y NIP no son lo mismo** (el portal se lo explica antes de cada uno):
- La **contraseña** solo sirve para entrar al portal y consultar. No recibe ni mueve herramienta.
- El **NIP** es su firma en el almacén: lo teclea al recibir herramienta o cuando se la transfieren. Los NIP muy fáciles (1111, 1234, 4321… o su número de empleado) se rechazan.

**Si la olvida o quedó bloqueado**: en la app de almacén → Colaboradores → botón **Portal** junto a su nombre → un supervisor confirma con su correo y contraseña. Su contraseña vuelve a ser su número de empleado (una sola vez) y deberá crear una nueva. **Si su NIP lo había creado él en el portal, también se anula** y lo creará de nuevo al entrar (así, si alguien más se apropió de su portal, no se queda con un NIP para firmar a su nombre). Un NIP asignado por un supervisor no se toca.

**Si olvida su NIP**: el supervisor se lo cambia como siempre (Colaboradores → NIP), o se restablece su portal y lo crea de nuevo.

**Cómo está protegido**

| Riesgo | Qué lo detiene |
|---|---|
| Ver datos de otro colaborador | Las funciones `colab_*` solo aceptan un token de sesión y devuelven únicamente los resguardos de su dueño. La clave pública no da acceso a ninguna tabla. |
| Entrar con el número de otro (primer ingreso) | El número solo abre la pantalla para crear contraseña; sin el nombre completo exacto no se ve nada. |
| Adivinar contraseñas o nombres | 5 fallos → bloqueo de 15 min (se duplica hasta 1 h). **10 nombres incorrectos** → la cuenta queda esperando que el almacén la restablezca (botón **Portal**). Por conexión: 100 fallos y 300 inicios de sesión por hora. Todo queda en la bitácora. |
| Dejar sin acceso a otro a propósito | El bloqueo dura máximo 1 h y no cierra las sesiones que el dueño ya tiene abiertas. |
| Llenar la base con peticiones | Máximo 3 sesiones abiertas por colaborador y los ingresos se anotan en la bitácora como máximo una vez cada 30 min. |
| Robo de la sesión | Token aleatorio de 256 bits; la base guarda solo su huella SHA-256. Vence a los 15 min sin uso o a las 8 h. Se guarda en `sessionStorage` (se borra al cerrar el navegador). |
| Contraseñas | bcrypt en el esquema privado `app`, igual que los NIP. |
| Cambiar el NIP de otro | Exige sesión del portal y, si ya tiene NIP, teclear el actual (mismo bloqueo de 5 intentos que en el almacén). Un cambio cada 24 h. Queda en la bitácora (`portal_nip_creado`, `portal_nip_cambiado`). |

**Riesgo que queda**: un compañero que conozca el número **y el nombre completo** de alguien que aún no activó su portal podría activarlo antes que él, ver su lista de herramientas y **crearle un NIP**. Con ese NIP podría firmar préstamos a su nombre si se presenta en el almacén; por eso el almacenista debe confirmar que quien teclea el NIP es la persona del resguardo. El dueño lo notaría: al intentar con su número, el portal le avisa que "este número ya creó su contraseña", y en su gafete aparece la fecha en que se creó; en ese caso, restablece su acceso con el botón **Portal** y revisa la bitácora. Conviene pedir a todos que activen su portal en los primeros días.

**Consultas útiles**

```sql
-- Actividad del portal (últimos 7 días)
select ts, usuario, accion, detalle->>'ip' as ip from public.bitacora
 where accion like 'portal%' and ts > now() - interval '7 days' order by ts desc;

-- Cuántos ya activaron su portal
select count(*) filter (where password_hash is not null) as activados, count(*) as con_intentos from app.portal_cuenta;

-- Ajustes del portal (intentos, bloqueo, tiempos de sesión)
select portal_max_intentos, portal_bloqueo_minutos, portal_ip_max_fallos_hora,
       portal_inactividad_minutos, portal_sesion_max_horas, portal_activacion_minutos from app.ajustes;
```

**Lista de colaboradores**: se carga con `carga_colaboradores.sql` (generado del Excel oficial; solo ESTATUS A y R). Pégalo en el SQL Editor y ejecútalo. Se puede repetir sin duplicar; actualiza nombre, departamento, puesto y localidad. **No lo subas a GitHub**: contiene nombres del personal.

## 12. Condición de entrega, auditoría y constancias

### Condición de la herramienta
Al armar un resguardo, cada herramienta lleva **obligatoriamente** su condición: **Nuevo**, **Usado en buen estado** o **Usado en mal estado**. La base rechaza préstamos sin ella. La condición se ve en las tarjetas, en la Tabla completa y en el portal del colaborador ("Entregada: …"). En una transferencia se conserva; si la última revisión la marcó como dañada, pasa como "Usado en mal estado".

### Auditoría (menú Control → Auditoría)
Sugerencias de revisión física ordenadas por prioridad:

| Prioridad | Qué muestra |
|---|---|
| Alta | Herramienta **no localizada** en la última revisión. |
| Alta | Herramienta **dañada** o entregada en mal estado (sin revisión que diga que está bien). |
| Media | Resguardos de **más de 180 días** sin revisión en los últimos 90 días. |
| Media | Colaboradores con **5 o más** herramientas. |
| Media | Herramienta **sin código** de artículo (fuera del catálogo; no concilia con AX). |
| Seguimiento | **Muestra aleatoria semanal** de 10 resguardos (conteo cíclico; cambia cada lunes y todos ven la misma). |
| Seguimiento | Colaboradores con herramienta que **no han activado su portal**. |

- Cada grupo tiene **Imprimir lista de verificación** (hoja carta con casillas Bien / Dañada / No localizada y firmas).
- **Registrar revisión** (en la tarjeta o en Auditoría): resultado + nota (obligatoria si está dañada o no se encontró). Queda en el resguardo y en la bitácora (`resguardo_revisado`) a nombre de quien la registró. Cualquier usuario activo de almacén puede registrarla.

### Constancia de no adeudo (menú Control → Constancias)
- La emite **solo personal de almacén con sesión** (almacén, supervisor o administrador). Los colaboradores no pueden emitirla desde su portal.
- La base **revisa en el momento** que el colaborador no tenga herramienta activa (y bloquea su registro mientras la emite, para que no se cuele un préstamo simultáneo). Si tiene adeudo, muestra la lista de lo pendiente.
- Cada constancia tiene **folio consecutivo** (CNA-000001…) y **código de verificación**; queda en la tabla `constancias` y en la bitácora (`constancia_emitida`). Para verificar una constancia impresa, búscala en "Constancias emitidas".
- Se imprime en **tamaño carta** (firma de quien expide y de quien recibe). Las reimpresiones dicen "Reimpresión del folio emitido el …".
- Lugar de expedición: "Tecomán, Colima". Para cambiarlo, agrega `lugarExpedicion: "Ciudad, Estado"` en `config.js`.
- También se llega desde Colaboradores: botón **Constancia** junto a quien no tiene herramienta en resguardo.

```sql
-- Constancias emitidas
select folio, codigo, emitida_en, emitida_por, (select nombre from public.colaboradores c where c.id = k.colaborador_id) as colaborador
  from public.constancias k order by folio desc;

-- Revisiones de los últimos 30 días
select ts, usuario, detalle->>'colaborador' as colaborador, detalle->>'herramienta' as herramienta, detalle->>'resultado' as resultado, detalle->>'nota' as nota
  from public.bitacora where accion = 'resguardo_revisado' and ts > now() - interval '30 days' order by ts desc;
```

### Otros ajustes de esta versión
- La política de seguridad de contenido (CSP) de `index.html` y `colaborador.html` ahora solo permite conectarse al proyecto de Supabase de Citrojugo (`svfpdejuhruojytqriji.supabase.co`). **Si algún día cambias de proyecto de Supabase**, actualiza esa línea en ambos archivos además de `config.js`.
- `importar_colaboradores` ahora también guarda la **localidad**.
- Catálogo precargado con los 1,329 artículos **HYE** del Excel de productos (los SHYE no se cargan). En "Nuevo resguardo" se buscan por código o por nombre.
