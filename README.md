# Pinball Vintage — «Estrella Fugaz»

Pinball electromecánico de estilo años 70 para Android.

**Descargar la APK:** [PinballVintage.apk (última versión)](https://github.com/ricardopch/pinball/releases/latest/download/PinballVintage.apk) · también en [`apk/PinballVintage.apk`](apk/PinballVintage.apk)

## Controles

| Acción | Cómo |
|---|---|
| Flipper izquierdo / derecho | Tocar la mitad izquierda / derecha de la pantalla (multitáctil) |
| Lanzador | Mantener pulsada una **tecla de volumen** para tensar el muelle y soltarla para disparar |
| Inclinación | La bola nota la inclinación real del móvil (acelerómetro / sensor de gravedad) |
| Empujón | Un golpe seco al móvil sacude la mesa; demasiados → **TILT** |
| Pausa y ajustes | Botón atrás o el botón ☰ del cristal |

Al empezar la partida se toma como referencia la postura del móvil (se puede recalibrar en el menú,
que también tiene sensibilidad, volumen, 3 ó 5 bolas, nivel de TILT y vibración).

## Reglas

- Pasillos **A-B-C**: 1.000 cada uno; los tres suben el multiplicador del bono (2X → 3X → 5X).
- **Dianas abatibles** (4): 500 cada una, 5.000 al tumbarlas todas; la segunda vez encienden **ESPECIAL** en los pasillos exteriores (partida gratis).
- **Dianas fijas** (3): 1.000 cada una; las tres encienden **BOLA EXTRA** en el agujero.
- **Agujero**: 3.000 y avanza el bono. **Spinner**: 100 por vuelta. **Bumpers**: 100.
- Bono de 1.000 × luces × multiplicador al perder la bola.
- Partidas gratis a 150.000, 300.000 y 450.000, y **MATCH** al acabar.

## Sonido

Todos los sonidos se sintetizan con `tools/gen_sounds.py` (campanas de 10/100/1.000 puntos, solenoides de
flippers y bumpers, knocker de partida gratis, rodillos de puntuación, muelle del lanzador, zumbador de TILT,
rodadura de la bola…). En Android suenan con `SoundPool` para tener baja latencia.

## Estructura

- `app/src/main/assets/www/` — el juego (HTML5 canvas + JavaScript, física propia con 600 pasos/s).
- `app/src/main/java/.../MainActivity.java` — envoltorio nativo: pantalla completa, sensores, teclas de volumen, sonido y vibración.
- `.github/workflows/build-apk.yml` — compila la APK en cada cambio, la publica en *Releases* y la guarda en `apk/`.

Para probar el juego en un navegador: `python3 -m http.server -d app/src/main/assets/www` y abrir
`http://localhost:8000` (Z / M flippers, espacio = lanzador, S = jugar, J/L/I/K = inclinar, N = empujón).

La APK se firma con una clave de depuración fija (`app/debug.keystore`) para que cada versión se instale encima
de la anterior. Si se definen los secretos `KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS` y `KEY_PASSWORD`,
el workflow usa esa clave en su lugar.

Fuentes tipográficas: Shrikhand, Bebas Neue y Alfa Slab One (SIL Open Font License, incluidas en `assets/www/fonts`).
