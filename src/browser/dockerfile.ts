import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  BROWSER_ENGINES,
  BROWSER_EXTENSIONS,
  BROWSER_ROOT,
  BSK_BIN,
  BSK_SHIM,
  type BrowserConfig,
  extensionDir,
} from './registry'

const UV_VERSION = '0.13.3'

// Per-agent layers for the non-default engines and extensions. Rendered after
// the base heavy stack in both the versioned and inline heads, so the shared
// Chrome (installed by agent-browser's layer) is always present first.
export function renderBrowserLayers(browser: BrowserConfig): string {
  const layers: string[] = []
  for (const id of browser.engines) {
    const install = BROWSER_ENGINES[id].install
    if (install.kind === 'bun-global') layers.push(renderBunGlobalEngine(id, install.spec))
    if (install.kind === 'uv-tool') layers.push(renderUvToolEngine(install.package, install.version, install.python))
  }
  for (const id of browser.extensions) layers.push(renderExtension(id))
  return layers.map((layer) => `${layer}\n\n`).join('')
}

function renderBunGlobalEngine(id: string, spec: string): string {
  const root = `${BROWSER_ROOT}/${id}`
  const module = `${root}/index.js`
  return `# Browser engine ${id}: installed under /usr so sandboxed bash can import it.
RUN mkdir -p ${root} \\
 && cd ${root} \\
 && printf '{}' > package.json \\
 && BUN_INSTALL_CACHE_DIR=/tmp/typeclaw-browser-bun-cache bun add ${spec} \\
 && printf '%s\\n' 'export * from "${id}"' > ${module} \\
 && rm -rf /tmp/typeclaw-browser-bun-cache \\
 && chmod -R a+rX ${root} \\
 && bun -e 'await import("${module}")'`
}

function renderUvToolEngine(pkg: string, version: string, python: string): string {
  return `# Browser engine ${pkg}: pinned uv tool with a uv-managed Python under /usr.
COPY --from=ghcr.io/astral-sh/uv:${UV_VERSION} /uv /usr/local/bin/uv
RUN UV_TOOL_DIR=${BROWSER_ROOT}/uv-tools UV_TOOL_BIN_DIR=/usr/local/bin UV_PYTHON_INSTALL_DIR=${BROWSER_ROOT}/python UV_CACHE_DIR=/tmp/typeclaw-uv-cache \\
      uv tool install --python ${python} ${pkg}==${version} \\
 && rm -rf /tmp/typeclaw-uv-cache \\
 && chmod -R a+rX ${BROWSER_ROOT} \\
 && ${pkg} --version > /dev/null`
}

function renderExtension(id: keyof typeof BROWSER_EXTENSIONS): string {
  const spec = BROWSER_EXTENSIONS[id]
  const dir = extensionDir(id)
  const { amd64, arm64 } = spec.cli.urlByArch
  return `# Browser extension ${id} ${spec.version}: release zip unpacked for --load-extension, plus its CLI.
RUN case "\${TARGETARCH:-$(uname -m)}" in \\
      arm64|aarch64) url=${arm64.url}; sha=${arm64.sha256} ;; \\
      amd64|x86_64) url=${amd64.url}; sha=${amd64.sha256} ;; \\
      *) echo "Unsupported ${id} architecture" >&2; exit 1 ;; \\
    esac \\
 && mkdir -p /tmp/typeclaw-ext ${dir} \\
 && curl -fsSL "$url" -o /tmp/typeclaw-ext/cli.tar.gz \\
 && echo "$sha  /tmp/typeclaw-ext/cli.tar.gz" | sha256sum -c - \\
 && tar -xzf /tmp/typeclaw-ext/cli.tar.gz -C /tmp/typeclaw-ext \\
 && mkdir -p ${dirname(BSK_BIN)} \\
 && install -m 0755 "$(find /tmp/typeclaw-ext -type f -name ${spec.cli.name} | head -n 1)" ${BSK_BIN} \\
 && printf '%s' '${readFileSync(join(import.meta.dir, 'bsk-shim.mjs')).toString('base64')}' | base64 -d > ${BSK_SHIM} \\
 && printf '#!/bin/sh\\nexec bun ${BSK_SHIM} "$@"\\n' > /usr/local/bin/${spec.cli.name} \\
 && chmod 0755 /usr/local/bin/${spec.cli.name} \\
 && chmod -R a+rX ${dirname(BSK_BIN)} \\
 && curl -fsSL ${spec.zip.url} -o /tmp/typeclaw-ext/ext.zip \\
 && echo "${spec.zip.sha256}  /tmp/typeclaw-ext/ext.zip" | sha256sum -c - \\
 && apt-get update \\
 && apt-get install -y --no-install-recommends unzip \\
 && rm -rf /var/lib/apt/lists/* \\
 && unzip -q /tmp/typeclaw-ext/ext.zip -d ${dir} \\
 && test -f ${dir}/manifest.json \\
 && chmod -R a+rX ${dir} \\
 && rm -rf /tmp/typeclaw-ext \\
 && ${BSK_BIN} --version > /dev/null`
}
