# pi-emacs-integration

Puente entre [pi](https://github.com/earendil-works/pi-coding-agent) y Emacs (daemon vía `emacsclient`).

## Features

- **Chips clicables en el chat** — cuando un tool result menciona archivos, aparece una fila de chips `⏏ ruta.ts:42` bajo el resultado. Click → `emacsclient -n -c +línea` (frame nuevo, salta a línea/columna si el output las menciona). Iconos: `⏏` mención, `+` creado, `✎` editado. Rutas relativas al proyecto (o `~/`).
- **`/emacs [ruta]`** — abre archivo o carpeta (dired). Sin argumento: raíz del proyecto.
- **`/changes`** — buffer `*pi-changes*` con los archivos tocados en la sesión: botones abrir/diff, navegación `n/p`, diff completo. Reutiliza el frame si ya existe.
- **`/emacs-eval EXPR`** — evalúa elisp en el daemon.
- **`alt+e`** — `/emacs` sobre el cwd.

## Config (env)

| Variable | Default | Descripción |
|---|---|---|
| `PI_EMACS_CLIENT` | `emacsclient` | Binario cliente |
| `PI_EMACS_MAX_LINKS` | `8` | Máx chips por tool result |
| `PI_EMACS_EXTS` | (todas) | CSV de extensiones permitidas, p.ej. `ts,tsx,py` |
| `PI_EMACS_NOISE` | — | CSV de prefijos extra a ignorar |
| `PI_EMACS_OPENER` | `xdg-open` | Comando para archivos no-texto |

Filtrado anti-ruido built-in: sesiones de pi, `~/.cache`, `/tmp`, `node_modules`.

## Config de usuario

`~/.pi/agent/extensions-config/emacs-integration.json` (los env de arriba tienen precedencia):

```json
{
  "maxLinks": 8,
  "extensions": [],
  "noise": ["/ruta/ruidosa"],
  "textExts": ["ts", "py", "md"],
  "externalOpener": "xdg-open"
}
```

- `textExts` **reemplaza** la lista built-in de extensiones que abren en Emacs; el resto va al `externalOpener`.
- Sin extensión (`Makefile`, `Dockerfile`) siempre abre en Emacs.

## Requisitos

- Daemon de Emacs (p.ej. `emacs.service` systemd) con `emacsclient` en PATH.
- Terminal con mouse para los clicks.

## Install

```
/pi package install git:github.com/kcurtet/pi-emacs-integration
```

## Dev

```
bun install
bun run typecheck   # tsc --noEmit
bun test            # node --test
```

## Notas

- El dispatch de clicks por columna (`event.x`) es necesario porque `Container.handleMouse` de pi-tui enruta por fila y los chips de un `HStack` comparten fila ([bug upstream](https://github.com/earendil-works/pi-tui)).
- Los scripts elisp de `/changes` se escriben a archivo con `;;; -*- lexical-binding: t; -*-` y se cargan con `(load ...)`: `emacsclient --eval` usa scope dinámico.
