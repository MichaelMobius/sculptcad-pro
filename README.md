<p align="center">
  <img src="src/assets/logo-sculptcad-pro_github.png" width="620" alt="SculptCAD Pro" />
</p>

<p align="center">
  Modelado, escultura, pintura, vectorización 2D→3D y exportación 3D directamente en el navegador.
</p>

# SculptCAD Pro

SculptCAD Pro es una aplicación web de modelado y escultura 3D construida con **Three.js**. Funciona completamente en el navegador, no requiere backend y puede publicarse en cualquier servicio de alojamiento estático.

La aplicación reúne creación de primitivas, transformaciones, pinceles de escultura, pintura de texturas, operaciones de malla, conversión de imágenes binarias a SVG y extrusión de contornos 2D como objetos 3D editables.

## Características principales

### Modelado

- Creación de cubos, esferas, cilindros, conos, toros y planos.
- Selección, movimiento, rotación y escalado mediante gizmos.
- Edición numérica de dimensiones X, Y y Z.
- Ajuste a grilla, bloqueo de proporciones y apoyo automático sobre el plano.
- Duplicación, eliminación, renombrado y gestión de objetos de la escena.
- Importación de modelos OBJ, STL y GLTF/GLB.

### Escultura

- Pinceles para añadir volumen, inflar, aplanar, arrastrar, pellizcar, girar, aplicar ruido, escalar localmente y suavizar.
- Herramienta **Crease** para crear surcos, pliegues o crestas.
- Radio, fuerza, acumulación, superficie delgada e inversión de dirección.
- Simetría en los ejes X, Y y Z, calculada en el espacio local del objeto.
- Máscara de protección con opciones para borrar, invertir y suavizar bordes.
- Topología dinámica localizada durante la escultura.
- Subdivisión, remallado, reducción de polígonos y relajación de topología mediante Web Worker.

### Pintura y materiales

- Pintura directa sobre la textura UV del objeto.
- Control de color, tamaño y opacidad del pincel.
- Carga de una imagen como textura.
- Ajuste del color base, metalidad y rugosidad.
- Descarga de la textura resultante como PNG.

### Imagen 2D → objeto 3D

- Carga de imágenes PNG, JPG, WEBP, BMP y GIF.
- Conversión a máscara binaria mediante umbral configurable.
- Inversión de figura y fondo.
- Eliminación de componentes pequeños y ruido.
- Suavizado de máscara y contornos.
- Simplificación poligonal para reducir puntos innecesarios.
- Vista previa de la imagen original, la silueta y el vector.
- Generación y descarga de SVG.
- Extrusión con ancho, alto, profundidad y bisel configurables.
- El objeto resultante puede moverse, esculpirse, pintarse y exportarse como cualquier otra pieza.

### Exportación y persistencia

- Exportación de escena en GLB y OBJ.
- Exportación de un objeto seleccionado o de toda la escena en STL.
- STL binario o ASCII.
- Guardado local del proyecto mediante IndexedDB.
- Historial de deshacer y rehacer con presupuesto de memoria.

## Arquitectura

El proyecto es una aplicación estática basada en módulos ES:

```text
sculptcad-pro/
├── index.html                 # Interfaz y punto de entrada
├── LICENSE                    # Licencia MIT
├── manifest.webmanifest       # Configuración instalable/PWA básica
├── src/
│   ├── main.js                # Coordinación de escena, UI, historial e importación/exportación
│   ├── styles.css             # Sistema visual y responsive
│   ├── assets/                # Logo, favicon e iconos
│   ├── core/                  # Estado, DOM, materiales, escena y wireframe
│   ├── history/               # Presupuesto de memoria del historial
│   ├── io/                    # Descarga de archivos
│   ├── sculpt/                # Registro y herramientas de escultura
│   ├── utils/                 # Buffers y remallado local
│   └── workers/               # Operaciones intensivas de malla
└── tests/                     # Validación estática y pruebas smoke
```

Las operaciones pesadas de malla se ejecutan fuera del hilo principal mediante un **Web Worker**. Los trazos de escultura y pintura se agrupan por `requestAnimationFrame` para reducir trabajo redundante.

## Requisitos

- Navegador moderno con WebGL y soporte para módulos ES.
- Chrome, Edge o Firefox recientes.
- Conexión a internet para cargar Three.js `0.164.1` desde jsDelivr.

No necesita Node.js, npm, PHP, base de datos ni servidor de aplicación para su uso normal.

## Ejecutar localmente

Los módulos ES deben servirse mediante HTTP; no abras `index.html` directamente con `file://`.

### Python

```bash
cd sculptcad-pro
python -m http.server 8000
```

Abre después:

```text
http://localhost:8000
```

### Node.js, opcional

```bash
npx http-server . -p 8000
```

También puede usarse una extensión como **Live Server** en Visual Studio Code.

## Publicación como sitio estático

El proyecto no requiere compilación ni backend. Para publicarlo, copia el contenido de la carpeta en la raíz pública de cualquier servicio de alojamiento estático. El archivo `index.html` debe permanecer en el nivel principal.

Las rutas de los recursos son relativas, por lo que la aplicación puede funcionar tanto en la raíz de un dominio como dentro de un subdirectorio.

## Flujo de uso recomendado

1. Crea una forma básica o importa un modelo.
2. Ajusta su tamaño y posición en **Modelar**.
3. Revisa la densidad de malla antes de trabajar detalles pequeños.
4. Esculpe el volumen general y después añade pliegues o detalles con Crease.
5. Aplica color o textura en **Pintar**.
6. Exporta en GLB para conservar materiales o en STL para impresión 3D.

Para convertir una imagen en volumen:

1. Abre el panel **Convertir imagen 2D a volumen**.
2. Carga una silueta o imagen de alto contraste.
3. Ajusta umbral, ruido, suavizado y simplificación.
4. Comprueba la vista previa vectorial.
5. Descarga el SVG o pulsa **Crear objeto 3D**.

## Atajos de teclado

| Acción | Atajo |
|---|---|
| Seleccionar | `V` |
| Mover | `W` |
| Rotar | `E` |
| Escalar | `R` |
| Esculpir | `B` |
| Pintar | `P` |
| Medir | `M` |
| Enfocar selección | `F` |
| Modelar / Esculpir / Pintar / Exportar | `1` / `2` / `3` / `4` |
| Suavizar temporalmente | `Shift` durante el trazo |
| Aplicar máscara temporalmente | `Ctrl` durante el trazo |
| Invertir el trazo | `Alt` |
| Alternar inversión persistente | `N` |
| Deshacer | `Ctrl+Z` |
| Rehacer | `Ctrl+Y` o `Ctrl+Shift+Z` |
| Eliminar objeto | `Delete` o `Backspace` |
| Cancelar medición / cerrar ayuda | `Esc` |

## Formatos compatibles

| Operación | Formatos |
|---|---|
| Importar modelos | OBJ, STL, GLTF, GLB |
| Cargar imágenes 2D | PNG, JPG/JPEG, WEBP, BMP, GIF |
| Exportar modelos | GLB, OBJ, STL |
| Exportar vector | SVG |
| Exportar textura | PNG |
| Guardar proyecto | IndexedDB del navegador |

## Datos y privacidad

La edición, vectorización, escultura y exportación se realizan localmente en el navegador. Los modelos e imágenes seleccionados no se envían a un servidor de SculptCAD Pro. La aplicación únicamente solicita desde jsDelivr las dependencias de Three.js definidas en el `importmap`.

Los proyectos guardados permanecen en el almacenamiento del navegador y no se sincronizan automáticamente entre dispositivos.

## Validación y pruebas

Desde la raíz del proyecto:

```bash
python tests/validate_project.py
node tests/sculpt_tools_smoke.mjs
node tests/mesh_worker_smoke.cjs
```

Las pruebas verifican:

- IDs únicos y referencias DOM válidas.
- Imports relativos existentes.
- Sintaxis de todos los módulos JavaScript.
- Comportamiento básico de Suavizar y Crease.
- Subdivisión, reducción y relajación en el Web Worker.

## Limitaciones actuales

- Three.js se carga desde CDN; para trabajar completamente offline debe alojarse localmente.
- La vectorización está optimizada para siluetas, logotipos e imágenes de alto contraste, no para fotografías complejas.
- La reducción de malla usa agrupamiento espacial y no un simplificador QEM completo.
- Las operaciones booleanas, capas de pintura y agrupación jerárquica todavía no están incluidas.
- El guardado local depende del navegador y puede perderse si se borran los datos del sitio.

## Créditos

SculptCAD Pro está inspirado en el enfoque de escultura web de **SculptGL**, creado por Stéphane Ginier y publicado bajo licencia MIT. Este repositorio no incorpora archivos fuente copiados de SculptGL, pero reconoce su influencia conceptual y técnica.

El proyecto utiliza [Three.js](https://threejs.org/) para renderizado, carga y exportación 3D.

## Licencia

SculptCAD Pro se distribuye bajo la **licencia MIT**. Consulta el archivo [`LICENSE`](LICENSE) para conocer los términos completos de uso, copia, modificación y distribución.
